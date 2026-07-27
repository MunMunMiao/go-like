import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { expect, test } from "bun:test"
import { API, type Project, type Snapshot } from "typescript/unstable/async"
import {
  SyntaxKind,
  createScanner,
  isArrowFunction,
  isAsExpression,
  isCallSignatureDeclaration,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isDecorator,
  isElementAccessExpression,
  isExportDeclaration,
  isExternalModuleReference,
  isFunctionDeclaration,
  isFunctionExpression,
  isFunctionTypeNode,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isMethodDeclaration,
  isMethodSignatureDeclaration,
  isNonNullExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertySignatureDeclaration,
  isStringLiteral,
  isTypeAliasDeclaration,
  isTypeAssertion,
  isVariableDeclaration,
  isVariableStatement,
  type Node,
  type SourceFile
} from "typescript/unstable/ast"

const ForbiddenGlobals = new Set([
  "AsyncLocalStorage",
  "Bun",
  "Deno",
  "Reflect",
  "WeakMap",
  "module",
  "require",
  "process"
])

function allowedModule(specifier: string): boolean {
  return (
    specifier === "@likego/context" ||
    specifier === "@likego/health" ||
    (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier))
  )
}

function commonJsLoader(expression: Node): boolean {
  let target = expression
  while (isParenthesizedExpression(target)) target = target.expression
  if (isIdentifier(target)) return target.text === "require"
  return (
    isPropertyAccessExpression(target) &&
    isIdentifier(target.expression) &&
    target.expression.text === "module" &&
    target.name.text === "require"
  )
}

function callableOwner(node: Node): Node | null {
  if (
    isFunctionDeclaration(node) ||
    isMethodDeclaration(node) ||
    isMethodSignatureDeclaration(node) ||
    isCallSignatureDeclaration(node)
  )
    return node
  if (isFunctionTypeNode(node)) {
    if (isTypeAliasDeclaration(node.parent) || isPropertySignatureDeclaration(node.parent)) {
      return node.parent
    }
    return null
  }
  if (!isArrowFunction(node) && !isFunctionExpression(node)) return null
  if (isVariableDeclaration(node.parent)) {
    const statement = node.parent.parent.parent
    return isVariableStatement(statement) ? statement : node.parent
  }
  if (isPropertyAssignment(node.parent)) return node.parent
  return node
}

function callableName(node: Node): string {
  if (isFunctionDeclaration(node)) return node.name?.text ?? "<anonymous>"
  if (isMethodDeclaration(node) || isMethodSignatureDeclaration(node)) {
    return node.name.getText(node.getSourceFile())
  }
  if (isCallSignatureDeclaration(node)) return "<call-signature>"
  if (isFunctionTypeNode(node)) {
    if (isTypeAliasDeclaration(node.parent)) return node.parent.name.text
    if (isPropertySignatureDeclaration(node.parent)) {
      return node.parent.name.getText(node.getSourceFile())
    }
  }
  if (isArrowFunction(node) || isFunctionExpression(node)) {
    if (isVariableDeclaration(node.parent) && isIdentifier(node.parent.name)) {
      return node.parent.name.text
    }
    if (isPropertyAssignment(node.parent)) return node.parent.name.getText(node.getSourceFile())
    if (isFunctionExpression(node)) return node.name?.text ?? "<anonymous>"
    return "<anonymous>"
  }
  return "<unknown>"
}

function hasJSDoc(node: Node, sourceFile: SourceFile): boolean {
  const leading = sourceFile.text.slice(node.getFullStart(), node.getStart(sourceFile))
  return /\/\*\*[\s\S]*\*\/\s*$/.test(leading)
}

function suppressionViolations(sourceFile: SourceFile): string[] {
  const scanner = createScanner(false, sourceFile.languageVariant, sourceFile.text)
  const violations: string[] = []
  while (scanner.scan() !== SyntaxKind.EndOfFile) {
    const token = scanner.getToken()
    if (
      token !== SyntaxKind.SingleLineCommentTrivia &&
      token !== SyntaxKind.MultiLineCommentTrivia
    ) {
      continue
    }
    const match = /@ts-(ignore|expect-error|nocheck)\b/.exec(scanner.getTokenText())
    if (match !== null) violations.push(`suppression:@ts-${match[1]}`)
  }
  return violations
}

/** Reports whether a parameter or binding element owns an actual rest token. */
function hasRestToken(node: Node): boolean {
  if (node.kind !== SyntaxKind.Parameter && node.kind !== SyntaxKind.BindingElement) return false
  return "dotDotDotToken" in node && node.dotDotDotToken !== undefined
}

function sourceViolations(sourceFile: SourceFile): string[] {
  const violations: string[] = suppressionViolations(sourceFile)
  const inspectModule = (specifier: string): void => {
    if (!allowedModule(specifier)) violations.push(`module:${specifier}`)
  }
  const visit = (node: Node): void => {
    if (isClassDeclaration(node)) {
      violations.push(`class-declaration:${node.name?.text ?? "<anonymous>"}`)
    } else if (isClassExpression(node)) {
      violations.push(`class-expression:${node.name?.text ?? "<anonymous>"}`)
    } else if (isDecorator(node)) {
      violations.push("decorator")
    }

    if (isAsExpression(node)) {
      violations.push("type-assertion:as")
    } else if (isTypeAssertion(node)) {
      violations.push("type-assertion:angle")
    } else if (isNonNullExpression(node)) {
      violations.push("type-assertion:non-null")
    } else if (isVariableDeclaration(node) && node.exclamationToken !== undefined) {
      violations.push("type-assertion:definite-assignment")
    } else if (node.kind === SyntaxKind.AnyKeyword) {
      violations.push("explicit-any")
    } else if (node.kind === SyntaxKind.SpreadElement) {
      violations.push("spread-element")
    } else if (node.kind === SyntaxKind.SpreadAssignment) {
      violations.push("spread-assignment")
    } else if (hasRestToken(node)) {
      violations.push("rest-element")
    }

    const owner = callableOwner(node)
    if (owner !== null && !hasJSDoc(owner, sourceFile)) {
      violations.push(`jsdoc:${callableName(node)}`)
    }

    if (isIdentifier(node) && ForbiddenGlobals.has(node.text)) {
      violations.push(`global:${node.text}`)
    }
    if (isImportDeclaration(node) || isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier
      if (specifier !== undefined && isStringLiteral(specifier)) inspectModule(specifier.text)
    }
    if (isImportEqualsDeclaration(node) && isExternalModuleReference(node.moduleReference)) {
      violations.push("syntax:import-equals-external-reference")
      const specifier = node.moduleReference.expression
      if (specifier !== undefined && isStringLiteral(specifier)) inspectModule(specifier.text)
    }
    if (isCallExpression(node) && node.expression.kind === SyntaxKind.ImportKeyword) {
      const [specifier] = node.arguments
      if (specifier !== undefined && isStringLiteral(specifier)) inspectModule(specifier.text)
      else violations.push("module:<non-literal-dynamic-import>")
    } else if (isCallExpression(node) && commonJsLoader(node.expression)) {
      const [specifier] = node.arguments
      if (specifier !== undefined && isStringLiteral(specifier)) inspectModule(specifier.text)
    }
    if (
      isElementAccessExpression(node) &&
      isIdentifier(node.expression) &&
      node.expression.text === "globalThis"
    ) {
      const property = node.argumentExpression
      if (isStringLiteral(property) && ForbiddenGlobals.has(property.text)) {
        violations.push(`global:${property.text}`)
      }
    }
    node.forEachChild(visit)
  }
  sourceFile.forEachChild(visit)
  return violations
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

async function syntheticViolations(source: string): Promise<string[]> {
  const root = await mkdtemp(join(tmpdir(), "likego-fetch-policy-escape-"))
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
    await writeFile(sourcePath, source)
    return await withProject(root, configPath, async (project) => {
      const sourceFile = await project.program.getSourceFile(sourcePath)
      if (sourceFile === undefined) throw new Error("synthetic source file is missing")
      return sourceViolations(sourceFile)
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test("AST policy detects forbidden classes, imports, globals, decorators, and reflection", async () => {
  const root = await mkdtemp(join(tmpdir(), "likego-fetch-source-policy-"))
  const configPath = join(root, "tsconfig.json")
  const sourcePath = join(root, "synthetic.ts")
  try {
    await writeFile(
      configPath,
      JSON.stringify({
        compilerOptions: {
          experimentalDecorators: true,
          module: "NodeNext",
          moduleResolution: "NodeNext",
          target: "ES2023"
        },
        include: ["synthetic.ts"]
      })
    )
    await writeFile(
      sourcePath,
      [
        'import { AsyncLocalStorage } from "node:async_hooks"',
        'import "hono"',
        'void import("elysia")',
        'const moduleName = "node:fs"; void import(moduleName)',
        "class NamedDeclaration {}",
        "const AnonymousExpression = class {}",
        "@sealed class Decorated {}",
        'if (typeof Bun !== "undefined") { void Deno; void process }',
        'Reflect.get(globalThis, "value")',
        "void new WeakMap()"
      ].join("\n")
    )

    const violations = await withProject(root, configPath, async (project) => {
      const sourceFile = await project.program.getSourceFile(sourcePath)
      if (sourceFile === undefined) throw new Error("synthetic source file is missing")
      return sourceViolations(sourceFile)
    })

    expect(violations).toContain("module:node:async_hooks")
    expect(violations).toContain("module:hono")
    expect(violations).toContain("module:elysia")
    expect(violations).toContain("module:<non-literal-dynamic-import>")
    expect(violations).toContain("class-declaration:NamedDeclaration")
    expect(violations).toContain("class-expression:<anonymous>")
    expect(violations).toContain("decorator")
    expect(violations).toContain("global:AsyncLocalStorage")
    expect(violations).toContain("global:Bun")
    expect(violations).toContain("global:Deno")
    expect(violations).toContain("global:process")
    expect(violations).toContain("global:Reflect")
    expect(violations).toContain("global:WeakMap")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("AST policy rejects undocumented callables, every assertion form, and TypeScript suppressions", async () => {
  const violations = await syntheticViolations(
    [
      "function undocumented(): void {}",
      "/** Documents the arrow. */",
      "const documented = (): void => {}",
      "const cast = value as unknown as string",
      "const angle = <string>value",
      "const nonNull = value!",
      "let deferred!: () => void",
      "const broad: any = value",
      "const spreadArray = [...items]",
      "const spreadObject = { ...documented }",
      "/** Documents the synthetic forbidden rest form. */",
      "function variadic(...items: string[]): void { void items }",
      "// @ts-ignore",
      "void cast",
      "// @ts-expect-error expected failure",
      "void angle",
      "// @ts-nocheck"
    ].join("\n")
  )

  expect(violations).toContain("jsdoc:undocumented")
  expect(violations).not.toContain("jsdoc:<arrow>")
  expect(violations.filter((violation) => violation === "type-assertion:as")).toHaveLength(2)
  expect(violations).toContain("type-assertion:angle")
  expect(violations).toContain("type-assertion:non-null")
  expect(violations).toContain("type-assertion:definite-assignment")
  expect(violations).toContain("explicit-any")
  expect(violations).toContain("spread-element")
  expect(violations).toContain("spread-assignment")
  expect(violations).toContain("rest-element")
  expect(violations).toContain("suppression:@ts-ignore")
  expect(violations).toContain("suppression:@ts-expect-error")
  expect(violations).toContain("suppression:@ts-nocheck")
})

test("AST policy rejects every undocumented callable declaration form", async () => {
  const violations = await syntheticViolations(
    [
      "type AliasHandler = (value: string) => void",
      "interface CallableShape {",
      "  method(): void",
      "  (): void",
      "  callback: (value: string) => void",
      "}",
      "const namedArrow = (): void => {}",
      "const namedExpression = function internalName(): void {}",
      "void Promise.resolve().then(function callbackExpression(): void {})",
      "const object = { propertyArrow: (): void => {} }",
      "void object"
    ].join("\n")
  )

  expect(violations).toContain("jsdoc:AliasHandler")
  expect(violations).toContain("jsdoc:method")
  expect(violations).toContain("jsdoc:<call-signature>")
  expect(violations).toContain("jsdoc:callback")
  expect(violations).toContain("jsdoc:namedArrow")
  expect(violations).toContain("jsdoc:namedExpression")
  expect(violations).toContain("jsdoc:callbackExpression")
  expect(violations).toContain("jsdoc:propertyArrow")
})

test("AST policy accepts documented callable declaration forms", async () => {
  const violations = await syntheticViolations(
    [
      "/** Handles one aliased operation. */",
      "type AliasHandler = (value: string) => void",
      "interface CallableShape {",
      "  /** Handles one method operation. */",
      "  method(): void",
      "  /** Handles one direct call operation. */",
      "  (): void",
      "  /** Handles one function-valued property operation. */",
      "  callback: (value: string) => void",
      "}",
      "/** Handles one arrow operation. */",
      "const namedArrow = (): void => {}",
      "/** Handles one function-expression operation. */",
      "const namedExpression = function internalName(): void {}",
      "void Promise.resolve().then(",
      "  /** Handles one named callback operation. */",
      "  function callbackExpression(): void {}",
      ")",
      "const object = {",
      "  /** Handles one object-property operation. */",
      "  propertyArrow: (): void => {}",
      "}",
      "void object"
    ].join("\n")
  )

  expect(violations).toEqual([])
})

test("suppression scanner ignores directive text inside strings", async () => {
  const violations = await syntheticViolations(
    [
      "/** Documents the fixture. */",
      "function fixture(): string {",
      "  return '@ts-ignore @ts-expect-error @ts-nocheck'",
      "}"
    ].join("\n")
  )

  expect(violations.filter((violation) => violation.startsWith("suppression:"))).toEqual([])
})

test.each([
  [
    "an import-equals external reference",
    'import Legacy = require("node:path")',
    "module:node:path"
  ],
  [
    "an import-equals external reference to an otherwise allowed module",
    'import Legacy = require("@likego/context")',
    "syntax:import-equals-external-reference"
  ],
  ["a direct require call", 'void require("node:util")', "module:node:util"],
  ["a parenthesized require call", 'void (require)("node:buffer")', "module:node:buffer"],
  ["a module.require call", 'void module.require("node:events")', "module:node:events"],
  ["the require global", "void require", "global:require"],
  ["computed globalThis Bun", 'void globalThis["Bun"]', "global:Bun"],
  ["computed globalThis Deno", 'void globalThis["Deno"]', "global:Deno"],
  ["computed globalThis process", 'void globalThis["process"]', "global:process"],
  ["computed globalThis require", 'void globalThis["require"]', "global:require"]
] as const)("rejects %s", async (_name, source, expectedViolation) => {
  const violations = await syntheticViolations(source)

  expect(violations).toContain(expectedViolation)
})

test("production source has complete inventory and no policy violations", async () => {
  const packageRoot = `${import.meta.dir}/..`
  const sourceRoot = `${packageRoot}/src`
  const files: string[] = []
  const violations: string[] = []

  files.push("context.ts", "health.ts", "index.ts")

  await withProject(packageRoot, `${packageRoot}/tsconfig.json`, async (project) => {
    for (const file of files) {
      const sourceFile = await project.program.getSourceFile(`${sourceRoot}/${file}`)
      if (sourceFile === undefined) throw new Error(`production source file is missing: ${file}`)
      for (const violation of sourceViolations(sourceFile)) {
        violations.push(`${file}:${violation}`)
      }
    }
  })

  expect(files).toEqual(["context.ts", "health.ts", "index.ts"])
  expect(violations).toEqual([])
})
