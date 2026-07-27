import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { extname, join } from "node:path"
import { tmpdir } from "node:os"

import { expect, test } from "bun:test"
import { API, type Project, type Snapshot } from "typescript/unstable/async"
import {
  SyntaxKind,
  isAsExpression,
  isArrowFunction,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isDecorator,
  isElementAccessExpression,
  isExportDeclaration,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isNonNullExpression,
  isParenthesizedExpression,
  isMethodDeclaration,
  isPropertyAccessExpression,
  isSatisfiesExpression,
  isStringLiteral,
  isTypeAssertion,
  isVariableDeclaration,
  type ExportDeclaration,
  type ImportDeclaration,
  type Node,
  type SourceFile,
  type VariableDeclaration
} from "typescript/unstable/ast"

const ForbiddenGlobals = new Set([
  "AsyncLocalStorage",
  "Bun",
  "Deno",
  "module",
  "Reflect",
  "require",
  "WeakMap",
  "process"
])

function peelTransparentWrappers(node: Node): Node {
  let current = node
  while (
    isParenthesizedExpression(current) ||
    isAsExpression(current) ||
    isNonNullExpression(current) ||
    isSatisfiesExpression(current) ||
    isTypeAssertion(current)
  ) {
    current = current.expression
  }
  return current
}

function commonJsLoader(node: Node): boolean {
  const target = peelTransparentWrappers(node)
  if (isIdentifier(target)) return target.text === "require"
  if (isPropertyAccessExpression(target)) {
    const receiver = peelTransparentWrappers(target.expression)
    return isIdentifier(receiver) && receiver.text === "module" && target.name.text === "require"
  }
  if (isElementAccessExpression(target)) {
    const receiver = peelTransparentWrappers(target.expression)
    const argument = target.argumentExpression
    const property = argument === undefined ? null : peelTransparentWrappers(argument)
    return (
      isIdentifier(receiver) &&
      receiver.text === "module" &&
      property !== null &&
      isStringLiteral(property) &&
      property.text === "require"
    )
  }
  return false
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

/** Reports whether a parameter or binding element owns an actual rest token. */
function hasRestToken(node: Node): boolean {
  if (node.kind !== SyntaxKind.Parameter && node.kind !== SyntaxKind.BindingElement) return false
  return "dotDotDotToken" in node && node.dotDotDotToken !== undefined
}

function allowedStaticModule(node: ImportDeclaration | ExportDeclaration): string | null {
  const specifier = node.moduleSpecifier
  if (specifier === undefined || !isStringLiteral(specifier)) return null
  const moduleName = specifier.text
  if (moduleName.startsWith(".") && extname(moduleName) === "") return null
  if (moduleName === "@likego/context" || moduleName === "@likego/web") return null
  const importClause = isImportDeclaration(node) ? node.importClause : undefined
  if (moduleName === "@likego/core" && importClause?.phaseModifier === SyntaxKind.TypeKeyword) {
    return null
  }
  return moduleName
}

function sourceViolations(sourceFile: SourceFile): string[] {
  const violations: string[] = []
  const visit = (node: Node): void => {
    if (isClassDeclaration(node)) {
      violations.push(`class-declaration:${node.name?.text ?? "<anonymous>"}`)
    } else if (isClassExpression(node)) {
      violations.push(`class-expression:${node.name?.text ?? "<anonymous>"}`)
    } else if (isDecorator(node)) {
      violations.push("decorator")
    } else if (isImportEqualsDeclaration(node)) {
      violations.push("import-equals")
    }

    if (isAsExpression(node)) {
      violations.push("type-assertion:as")
    } else if (isTypeAssertion(node)) {
      violations.push("type-assertion:angle")
    } else if (isNonNullExpression(node)) {
      violations.push("type-assertion:non-null")
    }
    if (isVariableDeclaration(node) && node.exclamationToken !== undefined) {
      violations.push("type-assertion:definite-assignment")
    }
    if (node.kind === SyntaxKind.AnyKeyword) violations.push("explicit-any")
    if (node.kind === SyntaxKind.SpreadElement) violations.push("spread-element")
    if (node.kind === SyntaxKind.SpreadAssignment) violations.push("spread-assignment")
    if (hasRestToken(node)) violations.push("rest-element")
    if (isFunctionDeclaration(node) && !hasJSDoc(node, sourceFile)) {
      violations.push(`jsdoc:function:${node.name?.text ?? "<anonymous>"}`)
    }
    const declaration = namedFunctionDeclaration(node)
    if (declaration !== null && !hasFunctionJSDoc(node, sourceFile)) {
      violations.push(`jsdoc:function:${declaration.name.getText(sourceFile)}`)
    }
    if (isMethodDeclaration(node) && !hasJSDoc(node, sourceFile)) {
      violations.push(`jsdoc:method:${node.name.getText(sourceFile)}`)
    }
    if (node.kind === SyntaxKind.MethodSignature && !hasJSDoc(node, sourceFile)) {
      violations.push(
        `jsdoc:method:${node.getText(sourceFile).split("(", 1)[0]?.trim() ?? "<anonymous>"}`
      )
    }
    if (
      node.kind === SyntaxKind.FunctionType &&
      node.parent.kind === SyntaxKind.TypeAliasDeclaration &&
      !hasJSDoc(node.parent, sourceFile)
    ) {
      violations.push(
        `jsdoc:callable-type:${node.parent.getText(sourceFile).split("\n", 1)[0] ?? "<anonymous>"}`
      )
    }

    if (isIdentifier(node) && ForbiddenGlobals.has(node.text)) {
      violations.push(`global:${node.text}`)
    }
    if (isPropertyAccessExpression(node)) {
      const receiver = peelTransparentWrappers(node.expression)
      if (
        isIdentifier(receiver) &&
        receiver.text === "globalThis" &&
        ForbiddenGlobals.has(node.name.text)
      ) {
        violations.push(`global:${node.name.text}`)
      }
    }
    if (isElementAccessExpression(node)) {
      const receiver = peelTransparentWrappers(node.expression)
      const argument = node.argumentExpression
      const property = argument === undefined ? null : peelTransparentWrappers(argument)
      if (isIdentifier(receiver) && receiver.text === "globalThis") {
        if (property !== null && isStringLiteral(property)) {
          if (ForbiddenGlobals.has(property.text)) violations.push(`global:${property.text}`)
        } else {
          violations.push("global:<computed>")
        }
      }
      if (
        isIdentifier(receiver) &&
        receiver.text === "module" &&
        (property === null || !isStringLiteral(property))
      ) {
        violations.push("module:<computed>")
      }
    }
    if (isImportDeclaration(node) || isExportDeclaration(node)) {
      const violation = allowedStaticModule(node)
      if (violation !== null) violations.push(`module:${violation}`)
    }
    if (isCallExpression(node) && node.expression.kind === SyntaxKind.ImportKeyword) {
      const [specifier] = node.arguments
      if (specifier !== undefined && isStringLiteral(specifier)) {
        violations.push(`dynamic-import:${specifier.text}`)
      } else {
        violations.push("dynamic-import:<non-literal>")
      }
    }
    if (isCallExpression(node) && commonJsLoader(node.expression)) {
      const [specifier] = node.arguments
      if (specifier !== undefined && isStringLiteral(specifier)) {
        violations.push(`require:${specifier.text}`)
      } else {
        violations.push("require:<non-literal>")
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
  const root = await mkdtemp(join(tmpdir(), "likego-health-source-policy-escape-"))
  const configPath = join(root, "tsconfig.json")
  const sourcePath = join(root, "synthetic.ts")
  try {
    await writeFile(
      configPath,
      JSON.stringify({
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          target: "ES2023"
        },
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

test("AST policy fails closed on forbidden module forms, classes, globals, decorators, and reflection", async () => {
  const root = await mkdtemp(join(tmpdir(), "likego-health-source-policy-"))
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
        'import type { AppStatusSource } from "@likego/core"',
        'import { type AppHandle, newApp } from "@likego/core"',
        'import { AsyncLocalStorage } from "node:async_hooks"',
        'import health = require("node:fs")',
        'export * from "hono"',
        'void import("elysia")',
        'const moduleName = "node:fs"; void import(moduleName)',
        'require("node:crypto")',
        "require(moduleName)",
        "class NamedDeclaration {}",
        "const AnonymousExpression = class {}",
        "@sealed class Decorated {}",
        'if (typeof Bun !== "undefined") { void Deno; void process }',
        'Reflect.get(globalThis, "value")',
        "void new WeakMap()",
        'void globalThis["process"]'
      ].join("\n")
    )

    const violations = await withProject(root, configPath, async (project) => {
      const sourceFile = await project.program.getSourceFile(sourcePath)
      if (sourceFile === undefined) throw new Error("synthetic source file is missing")
      return sourceViolations(sourceFile)
    })

    expect(violations.filter((violation) => violation === "module:@likego/core")).toHaveLength(1)
    expect(violations).toContain("module:node:async_hooks")
    expect(violations).toContain("module:hono")
    expect(violations).toContain("dynamic-import:elysia")
    expect(violations).toContain("dynamic-import:<non-literal>")
    expect(violations).toContain("require:node:crypto")
    expect(violations).toContain("require:<non-literal>")
    expect(violations).toContain("import-equals")
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

test.each([
  ["a direct require reference", "void require", "global:require"],
  ["a direct module reference", "void module", "global:module"],
  ["a parenthesized require call", 'void (require)("node:path")', "require:node:path"],
  ["a module.require call", 'void module.require("node:events")', "require:node:events"],
  [
    "a computed module require call",
    'void module["require"]("node:buffer")',
    "require:node:buffer"
  ],
  ["a computed require global", 'void globalThis["require"]', "global:require"],
  ["a parenthesized computed process global", 'void (globalThis)["process"]', "global:process"],
  [
    "a non-literal computed global",
    'const name = "process"; void globalThis[name]',
    "global:<computed>"
  ],
  [
    "a non-literal computed module access",
    'const name = "require"; void module[name]',
    "module:<computed>"
  ],
  [
    "an as-wrapped computed process global",
    'void (globalThis as any)["process"]',
    "global:process"
  ],
  [
    "an as-wrapped non-literal computed global",
    'const name = "process"; void (globalThis as any)[name]',
    "global:<computed>"
  ],
  [
    "a type-asserted computed process global",
    'void (<any>globalThis)["process"]',
    "global:process"
  ],
  ["a non-null computed process global", 'void (globalThis!)["process"]', "global:process"],
  [
    "a satisfies-wrapped computed process global",
    'void (globalThis satisfies typeof globalThis)["process"]',
    "global:process"
  ],
  [
    "a wrapped global module require chain",
    'void ((globalThis as any)["module"])["require"]("node:fs")',
    "global:module"
  ]
] as const)("rejects %s", async (_name, source, expectedViolation) => {
  const violations = await syntheticViolations(source)

  expect(violations).toContain(expectedViolation)
})

test.each([
  ["an as assertion", "const value = unknownValue as string", "type-assertion:as"],
  ["an angle-bracket assertion", "const value = <string>unknownValue", "type-assertion:angle"],
  ["a non-null assertion", "const value = unknownValue!", "type-assertion:non-null"],
  ["a definite assignment assertion", "let value!: string", "type-assertion:definite-assignment"],
  ["an explicit any", "const value: any = unknownValue", "explicit-any"],
  ["an array spread", "const value = [...items]", "spread-element"],
  ["an object spread", "const value = { ...input }", "spread-assignment"],
  [
    "a rest parameter",
    "/** Documents the synthetic forbidden rest form. */ function variadic(...items: string[]): void { void items }",
    "rest-element"
  ]
] as const)(
  "rejects %s",
  async (_name, source, expectedViolation) => {
    const violations = await syntheticViolations(source)

    expect(violations).toContain(expectedViolation)
  },
  10_000
)

test("rejects undocumented named functions and methods", async () => {
  const violations = await syntheticViolations(
    [
      "function undocumented(): void {}",
      "const namedArrow = (): void => {}",
      "const value = { method(): void {} }",
      "void undocumented; void namedArrow; void value"
    ].join("\n")
  )

  expect(violations).toContain("jsdoc:function:undocumented")
  expect(violations).toContain("jsdoc:function:namedArrow")
  expect(violations).toContain("jsdoc:method:method")
})

test("accepts documented named functions and methods", async () => {
  const violations = await syntheticViolations(
    [
      "/** Performs one documented operation. */",
      "function documented(): void {}",
      "/** Performs one documented arrow operation. */",
      "const namedArrow = (): void => {}",
      "const value = {",
      "  /** Performs one documented method operation. */",
      "  method(): void {}",
      "}",
      "void documented; void namedArrow; void value"
    ].join("\n")
  )

  expect(violations.filter((violation) => violation.startsWith("jsdoc:"))).toEqual([])
})

test("production source has complete inventory and no policy violations", async () => {
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
      for (const violation of sourceViolations(sourceFile)) {
        violations.push(`${file}:${violation}`)
      }
    }
  })

  expect(files).toEqual(["index.ts", "registry.ts"])
  expect(violations).toEqual([])
})
