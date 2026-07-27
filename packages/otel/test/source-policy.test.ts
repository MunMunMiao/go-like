import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, normalize, resolve } from "node:path"

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
  "@likego/context",
  "@likego/core",
  "@likego/core/lifecycle",
  "@likego/metadata",
  "@likego/broker",
  "@likego/client",
  "@likego/server",
  "@likego/transport",
  "@likego/transport/headers",
  "@likego/transport/provider",
  "@opentelemetry/api",
  "@opentelemetry/exporter-metrics-otlp-http",
  "@opentelemetry/exporter-trace-otlp-http",
  "@opentelemetry/resources",
  "@opentelemetry/sdk-metrics",
  "@opentelemetry/sdk-trace"
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

function relativeModule(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../")
}

function hasJSDoc(node: Node, sourceFile: SourceFile): boolean {
  const leading = sourceFile.text.slice(node.getFullStart(), node.getStart(sourceFile))
  return /\/\*\*[\s\S]*\*\/\s*$/.test(leading)
}

function namedFunctionDeclaration(node: Node): VariableDeclaration | null {
  if (!isArrowFunction(node) && !isFunctionExpression(node)) return null
  const parent = node.parent
  return isVariableDeclaration(parent) && parent.name.kind === SyntaxKind.Identifier ? parent : null
}

/** Admits only the documented Go-style option list on the public constructor. */
function allowedRestParameter(node: Node, sourceFile: SourceFile): boolean {
  const parameter = node.getText(sourceFile)
  const start = node.getStart(sourceFile)
  const newline = sourceFile.text.indexOf("\n", start)
  const end = newline < 0 ? sourceFile.text.length : newline
  if (!sourceFile.text.slice(start, end).includes("likego-typed-rest:")) return false
  if (parameter === "...options: readonly OtelOption[]") {
    return isFunctionDeclaration(node.parent) && node.parent.name?.text === "newOtelServer"
  }
  if (!sourceFile.fileName.endsWith("/client.ts")) return false
  if (parameter.startsWith("...options: readonly CallOption[]")) return true
  return (
    parameter.startsWith("...values: readonly unknown[]") &&
    isFunctionDeclaration(node.parent) &&
    node.parent.name?.text === "call"
  )
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

function sourceViolations(sourceFile: SourceFile, sourceFiles: ReadonlySet<string>): string[] {
  const violations: string[] = []
  if (/@ts-(?:ignore|expect-error|nocheck)\b/.test(sourceFile.text))
    violations.push("syntax:ts-suppression")
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
      !allowedRestParameter(node, sourceFile)
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
  const root = await mkdtemp(join(tmpdir(), "likego-otel-node-policy-"))
  const sourcePath = join(root, "synthetic.ts")
  const configPath = join(root, "tsconfig.json")
  try {
    await writeFile(
      configPath,
      JSON.stringify({
        compilerOptions: { module: "ESNext", moduleResolution: "Bundler", target: "ES2023" },
        include: ["synthetic.ts"]
      })
    )
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
      "class TracerFacade {}",
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
  expect(violations).toContain("class:TracerFacade")
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

test("production source satisfies the native-first OpenTelemetry adapter policy", async () => {
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
    "broker.ts",
    "client.ts",
    "errors.ts",
    "index.ts",
    "instrumentation.ts",
    "runtime.ts",
    "server.ts",
    "types.ts"
  ])
  expect(violations).toEqual([])
})
