import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { dirname, join, normalize, resolve } from "node:path"
import { tmpdir } from "node:os"

import { expect, test } from "bun:test"
import { API, type Project, type Snapshot } from "typescript/unstable/async"
import {
  SyntaxKind,
  isArrowFunction,
  isAsExpression,
  isClassDeclaration,
  isClassExpression,
  isExportDeclaration,
  isFunctionDeclaration,
  isFunctionExpression,
  isFunctionTypeNode,
  isIdentifier,
  isImportDeclaration,
  isMethodDeclaration,
  isNonNullExpression,
  isStringLiteral,
  isTypeAliasDeclaration,
  isTypeAssertion,
  isVariableDeclaration,
  type Node,
  type SourceFile,
  type VariableDeclaration
} from "typescript/unstable/ast"

const AllowedPackages = new Set([
  "@likego/broker",
  "@likego/client",
  "@likego/context",
  "@likego/core",
  "@likego/core/lifecycle",
  "@likego/server",
  "@likego/transport",
  "@likego/transport/headers",
  "node:fs",
  "node:worker_threads",
  "pino"
])
const ForbiddenGlobals = new Set([
  "AsyncLocalStorage",
  "Bun",
  "Deno",
  "Function",
  "Reflect",
  "WeakMap",
  "eval",
  "global",
  "globalThis",
  "module",
  "process",
  "require"
])
const AllowedSdkRestMethods = new Set(["once", "on", "removeListener"])
const SdkRestJustification =
  "likego-typed-rest: preserves Pino DestinationStream's EventEmitter-compatible listener ABI."
const OptionRestJustification =
  "likego-typed-rest: preserves the Go-style functional-option ABI without coercion."
const ClientRestJustification = "likego-typed-rest: preserves the Client call ABI."

/** Reports whether one module specifier addresses package-local source. */
function relativeModule(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../")
}

/** Reports whether a declaration has an immediately preceding JSDoc block. */
function hasJSDoc(node: Node, sourceFile: SourceFile): boolean {
  const leading = sourceFile.text.slice(node.getFullStart(), node.getStart(sourceFile))
  return /\/\*\*[\s\S]*\*\/\s*$/.test(leading)
}

/** Returns the declaration owning a named function expression. */
function namedFunctionDeclaration(node: Node): VariableDeclaration | null {
  if (!isArrowFunction(node) && !isFunctionExpression(node)) return null
  const parent = node.parent
  return isVariableDeclaration(parent) && parent.name.kind === SyntaxKind.Identifier ? parent : null
}

/** Returns either an inline function-expression name or its owning variable name. */
function namedFunctionName(node: Node): string | null {
  if (isFunctionExpression(node) && node.name !== undefined) return node.name.text
  const declaration = namedFunctionDeclaration(node)
  return declaration === null ? null : declaration.name.getText()
}

/** Reports JSDoc attached directly to a function expression or its variable statement. */
function hasFunctionJSDoc(node: Node, sourceFile: SourceFile): boolean {
  if (hasJSDoc(node, sourceFile)) return true
  const declaration = namedFunctionDeclaration(node)
  return declaration !== null && hasJSDoc(declaration.parent.parent, sourceFile)
}

/** Reports whether one rest exception carries its exact same-line SDK explanation. */
function hasLocalRestJustification(node: Node, sourceFile: SourceFile): boolean {
  const start = node.getStart(sourceFile)
  const newline = sourceFile.text.indexOf("\n", start)
  const end = newline < 0 ? sourceFile.text.length : newline
  return sourceFile.text.slice(start, end).includes(SdkRestJustification)
}

/** Allows only the three exact, locally justified Pino DestinationStream listener declarations. */
function allowedSdkCallbackRest(node: Node, sourceFile: SourceFile): boolean {
  if (!sourceFile.fileName.endsWith("/src/types.ts")) return false
  if (node.kind !== SyntaxKind.Parameter || node.getText(sourceFile) !== "...values: unknown[]")
    return false
  const functionType = node.parent
  const listener = functionType.parent
  const method = listener.parent
  if (functionType.kind !== SyntaxKind.FunctionType || method.kind !== SyntaxKind.MethodSignature)
    return false
  if (!listener.getText(sourceFile).startsWith("listener: ")) return false
  const methodName = method.getText(sourceFile).split("(", 1)[0]?.trim()
  return (
    methodName !== undefined &&
    AllowedSdkRestMethods.has(methodName) &&
    hasLocalRestJustification(node, sourceFile)
  )
}

/** Allows the one exact, locally justified Go-style option-rest declaration. */
function allowedOptionRest(node: Node, sourceFile: SourceFile): boolean {
  if (!sourceFile.fileName.endsWith("/src/runtime.ts")) return false
  if (node.kind !== SyntaxKind.Parameter) return false
  if (!node.getText(sourceFile).startsWith("...options: readonly PinoServerOption[]")) return false
  const start = node.getStart(sourceFile)
  const newline = sourceFile.text.indexOf("\n", start)
  const end = newline < 0 ? sourceFile.text.length : newline
  return sourceFile.text.slice(start, end).includes(OptionRestJustification)
}

/** Allows the one exact, locally justified Client call option-rest declaration. */
function allowedClientRest(node: Node, sourceFile: SourceFile): boolean {
  if (!sourceFile.fileName.endsWith("/src/logging.ts")) return false
  if (node.kind !== SyntaxKind.Parameter) return false
  if (!node.getText(sourceFile).startsWith("...options: readonly CallOption[]")) return false
  const start = node.getStart(sourceFile)
  const newline = sourceFile.text.indexOf("\n", start)
  const end = newline < 0 ? sourceFile.text.length : newline
  return sourceFile.text.slice(start, end).includes(ClientRestJustification)
}

/** Collects every production policy violation from one parsed source file. */
function sourceViolations(sourceFile: SourceFile, sourceFiles: ReadonlySet<string>): string[] {
  const violations: string[] = []
  if (/@ts-(?:ignore|expect-error|nocheck)\b/.test(sourceFile.text))
    violations.push("syntax:ts-suppression")
  /** Checks one static module specifier against package boundaries. */
  function inspectModule(specifier: string): void {
    if (!relativeModule(specifier)) {
      if (!AllowedPackages.has(specifier)) violations.push(`module:${specifier}`)
      return
    }
    if (/\.(?:[cm]?js|[cm]?ts)$/.test(specifier)) {
      violations.push(`module:${specifier}`)
      return
    }
    const target = normalize(resolve(dirname(sourceFile.fileName), `${specifier}.ts`))
    if (!sourceFiles.has(target)) violations.push(`module:unresolved-relative:${specifier}`)
  }
  /** Visits one syntax subtree and records forbidden constructs. */
  function visit(node: Node): void {
    if (isClassDeclaration(node)) violations.push(`class:${node.name?.text ?? "<anonymous>"}`)
    else if (isClassExpression(node)) violations.push("class:<expression>")
    if (isAsExpression(node)) violations.push("syntax:as-assertion")
    else if (isTypeAssertion(node)) violations.push("syntax:angle-assertion")
    else if (isNonNullExpression(node)) violations.push("syntax:non-null-assertion")
    if (isVariableDeclaration(node) && node.exclamationToken !== undefined) {
      violations.push("syntax:definite-assignment-assertion")
    }
    if (node.kind === SyntaxKind.AnyKeyword) violations.push("syntax:explicit-any")
    if (node.kind === SyntaxKind.SpreadElement || node.kind === SyntaxKind.SpreadAssignment) {
      violations.push("syntax:spread")
    }
    if (
      node.kind === SyntaxKind.Parameter &&
      node.getText(sourceFile).trimStart().startsWith("...") &&
      !allowedSdkCallbackRest(node, sourceFile) &&
      !allowedOptionRest(node, sourceFile) &&
      !allowedClientRest(node, sourceFile)
    ) {
      violations.push("syntax:rest")
    }
    if (
      (isFunctionDeclaration(node) ||
        isMethodDeclaration(node) ||
        node.kind === SyntaxKind.MethodSignature) &&
      !hasJSDoc(node, sourceFile)
    ) {
      violations.push(`jsdoc:${node.getText(sourceFile).split("(", 1)[0]?.trim() ?? "<anonymous>"}`)
    }
    if (
      isFunctionTypeNode(node) &&
      isTypeAliasDeclaration(node.parent) &&
      !hasJSDoc(node.parent, sourceFile)
    ) {
      violations.push(
        `jsdoc:${node.parent.getText(sourceFile).split("=", 1)[0]?.trim() ?? "<function-type>"}`
      )
    }
    const functionName = namedFunctionName(node)
    if (functionName !== null && !hasFunctionJSDoc(node, sourceFile)) {
      violations.push(`jsdoc:${functionName}`)
    }
    if (isIdentifier(node) && ForbiddenGlobals.has(node.text))
      violations.push(`global:${node.text}`)
    if (isImportDeclaration(node) || isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier
      if (specifier !== undefined && isStringLiteral(specifier)) inspectModule(specifier.text)
    }
    node.forEachChild(visit)
  }
  sourceFile.forEachChild(visit)
  return violations
}

/** Opens one TypeScript project and disposes every native snapshot deterministically. */
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

/** Evaluates policy behavior against one temporary synthetic source file. */
async function syntheticViolations(
  source: string,
  relativePath = "synthetic.ts"
): Promise<string[]> {
  const root = await mkdtemp(join(tmpdir(), "likego-log-pino-node-policy-"))
  const sourcePath = join(root, relativePath)
  const configPath = join(root, "tsconfig.json")
  try {
    await writeFile(
      configPath,
      JSON.stringify({
        compilerOptions: { module: "ESNext", moduleResolution: "Bundler", target: "ES2023" },
        include: ["**/*.ts"]
      })
    )
    await mkdir(dirname(sourcePath), { recursive: true })
    await writeFile(sourcePath, source)
    return await withProject(root, configPath, async (project) => {
      const sourceFile = await project.program.getSourceFile(sourcePath)
      if (sourceFile === undefined) throw new Error("synthetic source is missing")
      return sourceViolations(sourceFile, new Set([normalize(sourcePath)]))
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test("rejects façades, runtime globals, assertions, extensions, and undocumented callables", async () => {
  const violations = await syntheticViolations(
    [
      'import "node:http"',
      'import "./native.js"',
      "// @ts-expect-error",
      "class LoggerFacade {}",
      "function undocumented(): void {}",
      "type MissingDoc = () => void",
      "type ExplicitAny = any",
      "function spread(values: number[]): number[] { return [...values] }",
      "function rest(...values: number[]): number { return values.length }",
      "const value = 1 as number",
      "void process"
    ].join("\n")
  )
  expect(violations).toContain("module:node:http")
  expect(violations).toContain("module:./native.js")
  expect(violations).toContain("syntax:ts-suppression")
  expect(violations).toContain("class:LoggerFacade")
  expect(
    violations.filter((violation) => violation.startsWith("jsdoc:")).length
  ).toBeGreaterThanOrEqual(2)
  expect(violations).toContain("syntax:explicit-any")
  expect(violations).toContain("syntax:spread")
  expect(violations).toContain("syntax:rest")
  expect(violations).toContain("syntax:as-assertion")
  expect(violations).toContain("global:process")
})

test("requires adjacent JSDoc for a named inline function expression", async () => {
  const undocumented =
    "void new Promise<void>(function undocumentedExecutor(resolve) { resolve() })"
  expect(await syntheticViolations(undocumented)).toContain("jsdoc:undocumentedExecutor")

  const documented = `void new Promise<void>(
    /** Resolves one documented synthetic Promise. */
    function documentedExecutor(resolve) { resolve() }
  )`
  expect(await syntheticViolations(documented)).not.toContain("jsdoc:documentedExecutor")
})

test("requires the local SDK justification on each exact listener-rest exception", async () => {
  const missingJustification = `interface Destination {
    /** Registers one listener. */
    once(event: string, listener: (...values: unknown[]) => void): this
  }`
  expect(await syntheticViolations(missingJustification, "src/types.ts")).toContain("syntax:rest")

  const misplacedJustification = `interface Destination {
    /**
     * Registers one listener.
     * @remarks ${SdkRestJustification}
     */
    once(event: string, listener: (...values: unknown[]) => void): this
  }`
  expect(await syntheticViolations(misplacedJustification, "src/types.ts")).toContain("syntax:rest")

  const justified = `interface Destination {
    /** Registers one listener. */
    once(event: string, listener: (...values: unknown[] /* ${SdkRestJustification} */) => void): this
  }`
  expect(await syntheticViolations(justified, "src/types.ts")).not.toContain("syntax:rest")

  const unlisted = justified.replace("once(", "addListener(")
  expect(await syntheticViolations(unlisted, "src/types.ts")).toContain("syntax:rest")
})

test("production source satisfies the native-first Pino adapter policy", async () => {
  const packageRoot = `${import.meta.dir}/..`
  const sourceRoot = `${packageRoot}/src`
  const files: string[] = []
  for await (const file of new Bun.Glob("**/*.ts").scan({ cwd: sourceRoot, onlyFiles: true }))
    files.push(file)
  files.sort()
  const sourceFiles = new Set(files.map((file) => normalize(resolve(sourceRoot, file))))
  const violations: string[] = []
  await withProject(packageRoot, `${packageRoot}/tsconfig.json`, async (project) => {
    for (const file of files) {
      const sourceFile = await project.program.getSourceFile(`${sourceRoot}/${file}`)
      if (sourceFile === undefined) throw new Error(`production source is missing: ${file}`)
      for (const violation of sourceViolations(sourceFile, sourceFiles)) {
        violations.push(`${file}:${violation}`)
      }
    }
  })
  expect(files).toEqual([
    "errors.ts",
    "index.ts",
    "logging.ts",
    "runtime.ts",
    "thread-stream-node26-compat.ts",
    "types.ts"
  ])
  expect(violations).toEqual([])
  const types = await Bun.file(`${sourceRoot}/types.ts`).text()
  const root = await Bun.file(`${sourceRoot}/index.ts`).text()
  expect(types.match(/\.\.\.values: unknown\[\]/g)?.length).toBe(3)
  expect(types.split(SdkRestJustification).length - 1).toBe(3)
  expect(root).not.toContain("DestinationLifecycle")
  expect(root).not.toContain("LoggerFlushLifecycle")
})
