import { mkdtemp, rm, writeFile } from "node:fs/promises"
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
  isMethodSignatureDeclaration,
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
  "bullmq"
])
const ForbiddenGlobals = new Set([
  "AsyncLocalStorage",
  "Bun",
  "Deno",
  "Function",
  "WeakMap",
  "eval",
  "global",
  "globalThis",
  "module",
  "process",
  "require"
])

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

/** Reports whether one rest exception carries its required same-line type-safety explanation. */
function hasLocalRestJustification(node: Node, sourceFile: SourceFile): boolean {
  const start = node.getStart(sourceFile)
  const newline = sourceFile.text.indexOf("\n", start)
  const end = newline < 0 ? sourceFile.text.length : newline
  return sourceFile.text.slice(start, end).includes("likego-typed-rest:")
}

/** Admits only reviewed Go-style options ABI and the official Worker listener callback shape. */
function allowedRestParameter(node: Node, sourceFile: SourceFile): boolean {
  const parameter = node.getText(sourceFile)
  if (
    parameter === "...options: readonly BullMqOption[]" &&
    isFunctionDeclaration(node.parent) &&
    node.parent.name?.text === "newBullMqWorkerServer"
  )
    return hasLocalRestJustification(node, sourceFile)
  if (parameter !== "...values: unknown[]" || !isFunctionTypeNode(node.parent)) return false
  const signature = node.parent.parent.parent
  return (
    isMethodSignatureDeclaration(signature) &&
    isIdentifier(signature.name) &&
    (signature.name.text === "on" || signature.name.text === "off") &&
    hasLocalRestJustification(node, sourceFile)
  )
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
    if (node.kind === SyntaxKind.AnyKeyword) violations.push("syntax:explicit-any")
    if (node.kind === SyntaxKind.SpreadElement || node.kind === SyntaxKind.SpreadAssignment) {
      violations.push("syntax:spread")
    }
    if (
      node.kind === SyntaxKind.Parameter &&
      node.getText(sourceFile).startsWith("...") &&
      !allowedRestParameter(node, sourceFile)
    )
      violations.push("syntax:rest")
    if (isVariableDeclaration(node) && node.exclamationToken !== undefined) {
      violations.push("syntax:definite-assignment-assertion")
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
    const named = namedFunctionDeclaration(node)
    if (named !== null && !hasJSDoc(named.parent.parent, sourceFile)) {
      violations.push(`jsdoc:${named.name.getText(sourceFile)}`)
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

/** Evaluates one isolated source string through the production policy. */
async function syntheticViolations(source: string): Promise<readonly string[]> {
  const root = await mkdtemp(join(tmpdir(), "likego-bullmq-source-policy-"))
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
      return sourceViolations(sourceFile, new Set([normalize(sourcePath)]))
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test("typed rest exceptions require a same-line explanation", async () => {
  const violations = await syntheticViolations(
    [
      "/** Applies one option. */",
      "type BullMqOption = (value: unknown) => void",
      "/** Unjustified public option overload. */",
      "export function newBullMqWorkerServer(...options: readonly BullMqOption[]): void",
      "/** Justified public option overload. */",
      "export function newBullMqWorkerServer(...options: readonly BullMqOption[] /* likego-typed-rest: preserves the functional-option ABI. */): void",
      "interface WorkerLike {",
      "  /** Unjustified native listener. */",
      '  on(event: "error", listener: (...values: unknown[]) => void): this',
      "  /** Justified native listener. */",
      '  off(event: "error", listener: (...values: unknown[] /* likego-typed-rest: matches the native listener. */) => void): this',
      "}"
    ].join("\n")
  )
  expect(violations.filter((violation) => violation === "syntax:rest")).toHaveLength(2)
})

test("production source is native-first, documented, class-free, and assertion-free", async () => {
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
  expect(files).toEqual(["errors.ts", "index.ts", "server.ts", "testing.ts", "types.ts"])
  expect(violations).toEqual([])
  const publicTypes = await Bun.file(`${sourceRoot}/types.ts`).text()
  expect(publicTypes).toContain('import type { Worker } from "bullmq"')
  expect(publicTypes).toContain("() => Worker<DataType, ResultType, NameType>")
  expect(publicTypes).not.toContain("WorkerOptions")
  expect(publicTypes).not.toContain("Job<")
  expect(publicTypes).not.toContain("Context")
})
