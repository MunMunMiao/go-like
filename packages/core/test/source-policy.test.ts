import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { expect, test } from "bun:test"
import { API, type Project, type Snapshot } from "typescript/unstable/async"
import {
  SyntaxKind,
  isAsExpression,
  isArrowFunction,
  isClassDeclaration,
  isClassExpression,
  isCallExpression,
  isElementAccessExpression,
  isExportDeclaration,
  isExternalModuleReference,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isNonNullExpression,
  isParameterDeclaration,
  isMethodDeclaration,
  isStringLiteral,
  isTypeAssertion,
  isVariableDeclaration,
  type Node,
  type SourceFile,
  type VariableDeclaration
} from "typescript/unstable/ast"

function findCustomClassForms(sourceFile: SourceFile): string[] {
  const forms: string[] = []
  const visit = (node: Node): void => {
    if (isClassDeclaration(node)) {
      forms.push(`declaration:${node.name?.text ?? "<anonymous>"}`)
    } else if (isClassExpression(node)) {
      forms.push(`expression:${node.name?.text ?? "<anonymous>"}`)
    }
    node.forEachChild(visit)
  }
  sourceFile.forEachChild(visit)
  return forms
}

function findRuntimeSpecificForms(sourceFile: SourceFile): string[] {
  const forms: string[] = []
  const runtimeGlobals = new Set(["Bun", "Deno", "process", "require"])
  const runtimeSchemes = ["node:", "bun:", "deno:", "npm:", "jsr:"]
  const recordModule = (specifier: string): void => {
    if (runtimeSchemes.some((scheme) => specifier.startsWith(scheme))) {
      forms.push(`module:${specifier}`)
    }
  }
  const visit = (node: Node): void => {
    if (isIdentifier(node) && runtimeGlobals.has(node.text)) {
      forms.push(`global:${node.text}`)
    }
    if (isImportDeclaration(node) || isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier
      if (specifier !== undefined && isStringLiteral(specifier)) {
        recordModule(specifier.text)
      }
    }
    if (isImportEqualsDeclaration(node) && isExternalModuleReference(node.moduleReference)) {
      const specifier = node.moduleReference.expression
      if (specifier !== undefined && isStringLiteral(specifier)) recordModule(specifier.text)
    }
    if (isCallExpression(node)) {
      const specifier = node.arguments[0]
      const isDynamicImport = node.expression.kind === SyntaxKind.ImportKeyword
      const isRequire = isIdentifier(node.expression) && node.expression.text === "require"
      if (isDynamicImport) {
        if (specifier !== undefined && isStringLiteral(specifier)) {
          recordModule(specifier.text)
        } else {
          forms.push("module:<non-literal-dynamic-import>")
        }
      } else if (isRequire && specifier !== undefined && isStringLiteral(specifier)) {
        recordModule(specifier.text)
      }
    }
    if (
      isElementAccessExpression(node) &&
      isIdentifier(node.expression) &&
      node.expression.text === "globalThis"
    ) {
      const property = node.argumentExpression
      if (isStringLiteral(property) && runtimeGlobals.has(property.text)) {
        forms.push(`global:${property.text}`)
      }
    }
    node.forEachChild(visit)
  }
  sourceFile.forEachChild(visit)
  return forms
}

function findUnsafeTypeForms(sourceFile: SourceFile): string[] {
  const forms: string[] = []
  const visit = (node: Node): void => {
    if (isAsExpression(node)) {
      forms.push("type-assertion:as")
    } else if (isTypeAssertion(node)) {
      forms.push("type-assertion:angle")
    } else if (isNonNullExpression(node)) {
      forms.push("type-assertion:non-null")
    }
    if (isVariableDeclaration(node) && node.exclamationToken !== undefined) {
      forms.push("type-assertion:definite-assignment")
    }
    node.forEachChild(visit)
  }
  sourceFile.forEachChild(visit)
  return forms
}

/** Reports whether a parameter or binding element owns an actual rest token. */
function hasRestToken(node: Node): boolean {
  if (node.kind === SyntaxKind.RestType) return true
  return "dotDotDotToken" in node && node.dotDotDotToken !== undefined
}

/** Reports whether one rest exception carries its required same-line type-safety explanation. */
function hasLocalRestJustification(node: Node, sourceFile: SourceFile): boolean {
  const start = node.getStart(sourceFile)
  const newline = sourceFile.text.indexOf("\n", start)
  const end = newline < 0 ? sourceFile.text.length : newline
  return sourceFile.text.slice(start, end).includes("likego-typed-rest:")
}

/** Reports whether one rest parameter is an approved and locally justified public functional-option ABI. */
function isApprovedPublicVariadic(node: Node, sourceFile: SourceFile): boolean {
  if (
    !isParameterDeclaration(node) ||
    node.dotDotDotToken === undefined ||
    !isIdentifier(node.name)
  )
    return false
  const parent = node.parent
  if (!isFunctionDeclaration(parent) || parent.name === undefined) return false
  const isExported =
    parent.modifiers?.some((modifier) => modifier.kind === SyntaxKind.ExportKeyword) === true
  const isLastParameter = parent.parameters[parent.parameters.length - 1] === node
  const isApprovedSignature =
    (node.name.text === "options" && parent.name.text === "newApp") ||
    (node.name.text === "servers" && parent.name.text === "server") ||
    (node.name.text === "values" && parent.name.text === "endpoint") ||
    (node.name.text === "signals" && parent.name.text === "signal")
  return (
    isExported &&
    isLastParameter &&
    isApprovedSignature &&
    hasLocalRestJustification(node, sourceFile)
  )
}

/** Finds spread syntax and non-public rest parameters forbidden in production source. */
function findForbiddenSpreadAndRestForms(sourceFile: SourceFile): string[] {
  const forms: string[] = []
  const visit = (node: Node): void => {
    if (node.kind === SyntaxKind.SpreadElement) {
      forms.push("spread-element")
    } else if (node.kind === SyntaxKind.SpreadAssignment) {
      forms.push("spread-assignment")
    } else if (hasRestToken(node) && !isApprovedPublicVariadic(node, sourceFile)) {
      forms.push("rest-element")
    }
    node.forEachChild(visit)
  }
  sourceFile.forEachChild(visit)
  return forms
}

function hasJSDoc(node: Node, sourceFile: SourceFile): boolean {
  const leading = sourceFile.text.slice(node.getFullStart(), node.getStart(sourceFile))
  return /\/\*\*[\s\S]*\*\/\s*$/.test(leading)
}

function namedFunctionDeclaration(node: Node): VariableDeclaration | null {
  if (!isArrowFunction(node) && !isFunctionExpression(node)) return null
  const parent = node.parent
  if (!isVariableDeclaration(parent) || parent.name.kind !== SyntaxKind.Identifier) return null
  return parent
}

function hasFunctionJSDoc(node: Node, sourceFile: SourceFile): boolean {
  if (hasJSDoc(node, sourceFile)) return true
  const declaration = namedFunctionDeclaration(node)
  if (declaration === null) return false
  const statement = declaration.parent.parent
  return hasJSDoc(declaration, sourceFile) || hasJSDoc(statement, sourceFile)
}

function findUndocumentedCallables(sourceFile: SourceFile): string[] {
  const forms: string[] = []
  const visit = (node: Node): void => {
    if (isFunctionDeclaration(node) && !hasJSDoc(node, sourceFile)) {
      forms.push(`function:${node.name?.text ?? "<anonymous>"}`)
    }
    const declaration = namedFunctionDeclaration(node)
    if (declaration !== null && !hasFunctionJSDoc(node, sourceFile)) {
      forms.push(`function:${declaration.name.getText(sourceFile)}`)
    }
    if (isMethodDeclaration(node) && !hasJSDoc(node, sourceFile)) {
      forms.push(`method:${node.name.getText(sourceFile)}`)
    }
    if (node.kind === SyntaxKind.MethodSignature && !hasJSDoc(node, sourceFile)) {
      forms.push(`method:${node.getText(sourceFile).split("(", 1)[0]?.trim() ?? "<anonymous>"}`)
    }
    if (
      node.kind === SyntaxKind.FunctionType &&
      node.parent.kind === SyntaxKind.TypeAliasDeclaration &&
      !hasJSDoc(node.parent, sourceFile)
    ) {
      forms.push(
        `callable-type:${node.parent.getText(sourceFile).split("\n", 1)[0] ?? "<anonymous>"}`
      )
    }
    node.forEachChild(visit)
  }
  sourceFile.forEachChild(visit)
  return forms
}

async function withProject<T>(
  root: string,
  configPath: string,
  use: (project: Project) => Promise<T>
): Promise<T> {
  const api = new API({ cwd: root })
  let snapshot: Snapshot | null = null
  try {
    snapshot = await api.updateSnapshot({ openProjects: [configPath] })
    const projects = snapshot.getProjects()
    if (projects.length !== 1) throw new Error("source policy requires exactly one project")
    const project = projects[0]
    if (project === undefined) throw new Error("source policy project is missing")
    return await use(project)
  } finally {
    if (snapshot !== null) await snapshot.dispose()
    await api.close()
  }
}

test("detects named class declarations and anonymous or named class expressions", async () => {
  const root = await mkdtemp(join(tmpdir(), "likego-core-source-policy-"))
  const configPath = join(root, "tsconfig.json")
  const sourcePath = join(root, "synthetic.ts")
  try {
    await writeFile(
      configPath,
      JSON.stringify({
        compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", target: "ES2023" },
        include: ["synthetic.ts"]
      })
    )
    await writeFile(
      sourcePath,
      [
        "class NamedDeclaration {}",
        "const AnonymousExpression = class {}",
        "const NamedExpression = class Inner {}"
      ].join("\n")
    )

    const forms = await withProject(root, configPath, async (project) => {
      const sourceFile = await project.program.getSourceFile(sourcePath)
      if (sourceFile === undefined) throw new Error("synthetic source file is missing")
      return findCustomClassForms(sourceFile)
    })

    expect(forms).toEqual([
      "declaration:NamedDeclaration",
      "expression:<anonymous>",
      "expression:Inner"
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("production source recursively contains no custom class declarations or expressions", async () => {
  const packageRoot = `${import.meta.dir}/..`
  const sourceRoot = `${packageRoot}/src`
  const files: string[] = []
  const violations: string[] = []

  for await (const file of new Bun.Glob("**/*.ts").scan({ cwd: sourceRoot, onlyFiles: true })) {
    files.push(file)
  }
  files.sort()

  await withProject(packageRoot, `${packageRoot}/tsconfig.json`, async (project) => {
    for (const file of files) {
      const sourceFile = await project.program.getSourceFile(`${sourceRoot}/${file}`)
      if (sourceFile === undefined) throw new Error(`production source file is missing: ${file}`)
      if (findCustomClassForms(sourceFile).length > 0) violations.push(file)
    }
  })

  expect(files.length).toBeGreaterThan(0)
  expect(violations).toEqual([])
})

test("detects runtime-specific modules and globals used by runtime conditionals", async () => {
  const root = await mkdtemp(join(tmpdir(), "likego-core-runtime-policy-"))
  const configPath = join(root, "tsconfig.json")
  const sourcePath = join(root, "synthetic.ts")
  try {
    await writeFile(
      configPath,
      JSON.stringify({
        compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", target: "ES2023" },
        include: ["synthetic.ts"]
      })
    )
    await writeFile(
      sourcePath,
      [
        'import "node:fs"',
        'import Legacy = require("node:path")',
        'void import("node:os")',
        'const moduleName = "node:fs"; void import(moduleName)',
        "void import(`node:buffer`)",
        "void import()",
        'void require("node:util")',
        "void globalThis.process",
        'void globalThis["Deno"]',
        'if (typeof Bun !== "undefined") {',
        "  void Deno",
        "  void process",
        "}"
      ].join("\n")
    )

    const forms = await withProject(root, configPath, async (project) => {
      const sourceFile = await project.program.getSourceFile(sourcePath)
      if (sourceFile === undefined) throw new Error("synthetic source file is missing")
      return findRuntimeSpecificForms(sourceFile)
    })

    expect(forms).toEqual([
      "module:node:fs",
      "module:node:path",
      "module:node:os",
      "module:<non-literal-dynamic-import>",
      "module:<non-literal-dynamic-import>",
      "module:<non-literal-dynamic-import>",
      "module:node:util",
      "global:require",
      "global:process",
      "global:Deno",
      "global:Bun",
      "global:Deno",
      "global:process"
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("portable production source contains no runtime-specific modules or globals", async () => {
  const packageRoot = `${import.meta.dir}/..`
  const sourceRoot = `${packageRoot}/src`
  const files: string[] = []
  const violations: string[] = []

  for await (const file of new Bun.Glob("**/*.ts").scan({ cwd: sourceRoot, onlyFiles: true })) {
    files.push(file)
  }
  files.sort()

  await withProject(packageRoot, `${packageRoot}/tsconfig.json`, async (project) => {
    for (const file of files) {
      if (file === "node.ts") continue
      const sourceFile = await project.program.getSourceFile(`${sourceRoot}/${file}`)
      if (sourceFile === undefined) throw new Error(`production source file is missing: ${file}`)
      for (const form of findRuntimeSpecificForms(sourceFile)) violations.push(`${file}:${form}`)
    }
  })

  expect(files.length).toBeGreaterThan(0)
  expect(violations).toEqual([])
})

test("detects assertions, non-null expressions, and definite assignment escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "likego-core-type-policy-"))
  const configPath = join(root, "tsconfig.json")
  const sourcePath = join(root, "synthetic.ts")
  try {
    await writeFile(
      configPath,
      JSON.stringify({
        compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", target: "ES2023" },
        include: ["synthetic.ts"]
      })
    )
    await writeFile(
      sourcePath,
      [
        "declare const input: unknown",
        "const first = input as string",
        "const second = <string>input",
        "const third = input!",
        "let fourth!: string"
      ].join("\n")
    )

    const forms = await withProject(root, configPath, async (project) => {
      const sourceFile = await project.program.getSourceFile(sourcePath)
      if (sourceFile === undefined) throw new Error("synthetic source file is missing")
      return findUnsafeTypeForms(sourceFile)
    })

    expect(forms).toEqual([
      "type-assertion:as",
      "type-assertion:angle",
      "type-assertion:non-null",
      "type-assertion:definite-assignment"
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("production source recursively contains no unsafe type escapes", async () => {
  const packageRoot = `${import.meta.dir}/..`
  const sourceRoot = `${packageRoot}/src`
  const files: string[] = []
  const violations: string[] = []

  for await (const file of new Bun.Glob("**/*.ts").scan({ cwd: sourceRoot, onlyFiles: true })) {
    files.push(file)
  }
  files.sort()

  await withProject(packageRoot, `${packageRoot}/tsconfig.json`, async (project) => {
    for (const file of files) {
      const sourceFile = await project.program.getSourceFile(`${sourceRoot}/${file}`)
      if (sourceFile === undefined) throw new Error(`production source file is missing: ${file}`)
      for (const form of findUnsafeTypeForms(sourceFile)) violations.push(`${file}:${form}`)
    }
  })

  expect(files.length).toBeGreaterThan(0)
  expect(violations).toEqual([])
})

test("spread and rest policy rejects internal forms and permits only public option variadics", async () => {
  const root = await mkdtemp(join(tmpdir(), "likego-core-spread-policy-"))
  const configPath = join(root, "tsconfig.json")
  const sourcePath = join(root, "synthetic.ts")
  try {
    await writeFile(
      configPath,
      JSON.stringify({
        compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", target: "ES2023" },
        include: ["synthetic.ts"]
      })
    )
    await writeFile(
      sourcePath,
      [
        "export function newApp(...options: readonly unknown[] /* likego-typed-rest: preserves the functional-option ABI. */): void { void options }",
        "export function endpoint(...values: readonly string[] /* likego-typed-rest: preserves the functional-option ABI. */): void { void values }",
        "export function server(...servers: readonly unknown[]): void { void servers }",
        "function internal(...values: readonly unknown[]): void { void values }",
        "type NonEmpty = readonly [Error, ...Error[]]",
        "declare const nonEmpty: NonEmpty",
        "const array = [...values]",
        "const object = { ...value }",
        "void [internal, nonEmpty, array, object]"
      ].join("\n")
    )

    const forms = await withProject(root, configPath, async (project) => {
      const sourceFile = await project.program.getSourceFile(sourcePath)
      if (sourceFile === undefined) throw new Error("synthetic source file is missing")
      return findForbiddenSpreadAndRestForms(sourceFile)
    })

    expect(forms).toEqual([
      "rest-element",
      "rest-element",
      "rest-element",
      "spread-element",
      "spread-assignment"
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("production source contains no spread or unapproved rest forms", async () => {
  const packageRoot = `${import.meta.dir}/..`
  const sourceRoot = `${packageRoot}/src`
  const files: string[] = []
  const violations: string[] = []

  for await (const file of new Bun.Glob("**/*.ts").scan({ cwd: sourceRoot, onlyFiles: true })) {
    files.push(file)
  }
  files.sort()

  await withProject(packageRoot, `${packageRoot}/tsconfig.json`, async (project) => {
    for (const file of files) {
      const sourceFile = await project.program.getSourceFile(`${sourceRoot}/${file}`)
      if (sourceFile === undefined) throw new Error(`production source file is missing: ${file}`)
      for (const form of findForbiddenSpreadAndRestForms(sourceFile))
        violations.push(`${file}:${form}`)
    }
  })

  expect(files.length).toBeGreaterThan(0)
  expect(violations).toEqual([])
})

test("detects undocumented named functions and methods", async () => {
  const root = await mkdtemp(join(tmpdir(), "likego-core-jsdoc-policy-"))
  const configPath = join(root, "tsconfig.json")
  const sourcePath = join(root, "synthetic.ts")
  try {
    await writeFile(
      configPath,
      JSON.stringify({
        compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", target: "ES2023" },
        include: ["synthetic.ts"]
      })
    )
    await writeFile(
      sourcePath,
      [
        "function undocumented(): void {}",
        "const namedArrow = (): void => {}",
        "const value = { method(): void {} }",
        "void undocumented; void namedArrow; void value"
      ].join("\n")
    )

    const forms = await withProject(root, configPath, async (project) => {
      const sourceFile = await project.program.getSourceFile(sourcePath)
      if (sourceFile === undefined) throw new Error("synthetic source file is missing")
      return findUndocumentedCallables(sourceFile)
    })

    expect(forms).toEqual(["function:undocumented", "function:namedArrow", "method:method"])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("production source recursively documents every named callable", async () => {
  const packageRoot = `${import.meta.dir}/..`
  const sourceRoot = `${packageRoot}/src`
  const files: string[] = []
  const violations: string[] = []

  for await (const file of new Bun.Glob("**/*.ts").scan({ cwd: sourceRoot, onlyFiles: true })) {
    files.push(file)
  }
  files.sort()

  await withProject(packageRoot, `${packageRoot}/tsconfig.json`, async (project) => {
    for (const file of files) {
      const sourceFile = await project.program.getSourceFile(`${sourceRoot}/${file}`)
      if (sourceFile === undefined) throw new Error(`production source file is missing: ${file}`)
      for (const form of findUndocumentedCallables(sourceFile)) violations.push(`${file}:${form}`)
    }
  })

  expect(files.length).toBeGreaterThan(0)
  expect(violations).toEqual([])
})
