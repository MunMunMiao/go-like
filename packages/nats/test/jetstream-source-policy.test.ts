import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { dirname, join, normalize, resolve } from "node:path"
import { tmpdir } from "node:os"

import { expect, test } from "bun:test"
import { API, type Project, type Snapshot } from "typescript/unstable/async"
import {
  isArrowFunction,
  isAsExpression,
  isClassDeclaration,
  isClassExpression,
  isExportDeclaration,
  isFunctionDeclaration,
  isFunctionExpression,
  isImportDeclaration,
  isMethodDeclaration,
  isNonNullExpression,
  isStringLiteral,
  isTypeAssertion,
  isVariableDeclaration,
  SyntaxKind,
  type Node,
  type SourceFile,
  type VariableDeclaration
} from "typescript/unstable/ast"

const AllowedModules = new Set([
  "@likego/broker",
  "@likego/broker/provider",
  "@likego/context",
  "@likego/core",
  "@likego/core/lifecycle",
  "@nats-io/jetstream",
  "@nats-io/transport-node"
])

/** Reports whether one import is internal to the production source tree. */
function relativeModule(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../")
}

/** Reports whether a declaration has an adjacent documentation comment. */
function hasJSDoc(node: Node, sourceFile: SourceFile): boolean {
  const leading = sourceFile.text.slice(node.getFullStart(), node.getStart(sourceFile))
  return /\/\*\*[\s\S]*\*\/\s*$/.test(leading)
}

/** Returns the named declaration that owns one arrow or function expression. */
function namedFunctionDeclaration(node: Node): VariableDeclaration | null {
  if (!isArrowFunction(node) && !isFunctionExpression(node)) return null
  const parent = node.parent
  if (!isVariableDeclaration(parent) || parent.name.kind !== SyntaxKind.Identifier) return null
  return parent
}

/** Reports whether a named function expression is documented at either declaration boundary. */
function hasFunctionJSDoc(node: Node, sourceFile: SourceFile): boolean {
  if (hasJSDoc(node, sourceFile)) return true
  const declaration = namedFunctionDeclaration(node)
  if (declaration === null) return false
  return hasJSDoc(declaration, sourceFile) || hasJSDoc(declaration.parent.parent, sourceFile)
}

/** Reports whether one rest exception carries its required same-line type-safety explanation. */
function hasLocalRestJustification(node: Node, sourceFile: SourceFile): boolean {
  const start = node.getStart(sourceFile)
  const newline = sourceFile.text.indexOf("\n", start)
  const end = newline < 0 ? sourceFile.text.length : newline
  return sourceFile.text.slice(start, end).includes("likego-typed-rest:")
}

/** Admits only the reviewed Go-style functional-options public ABI. */
function allowedRestParameter(node: Node, sourceFile: SourceFile): boolean {
  return (
    node.getText(sourceFile) === "...options: readonly NatsJetStreamOption[]" &&
    node.parent.getText(sourceFile).startsWith("export function newNatsJetStreamServer(") &&
    hasLocalRestJustification(node, sourceFile)
  )
}

/** Collects forbidden source forms from one production source file. */
function sourceViolations(sourceFile: SourceFile, sourceFiles: ReadonlySet<string>): string[] {
  const violations: string[] = []
  if (/@ts-(?:ignore|expect-error|nocheck)\b/.test(sourceFile.text)) {
    violations.push("syntax:ts-suppression")
  }

  /** Validates one static module specifier. */
  const inspectModule = (specifier: string): void => {
    if (!relativeModule(specifier)) {
      if (!AllowedModules.has(specifier)) violations.push(`module:${specifier}`)
      return
    }
    if (/\.(?:[cm]?js|[cm]?ts|tsx|jsx)$/.test(specifier)) {
      violations.push(`module:extension:${specifier}`)
      return
    }
    const target = normalize(resolve(dirname(sourceFile.fileName), `${specifier}.ts`))
    if (!sourceFiles.has(target)) violations.push(`module:unresolved:${specifier}`)
  }

  /** Visits every syntax node in one production source file. */
  const visit = (node: Node): void => {
    if (isClassDeclaration(node)) {
      violations.push(`class:${node.name?.text ?? "<anonymous>"}`)
    } else if (isClassExpression(node)) {
      violations.push(`class-expression:${node.name?.text ?? "<anonymous>"}`)
    }
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
        `jsdoc:method-signature:${node.getText(sourceFile).split("(", 1)[0]?.trim() ?? "<anonymous>"}`
      )
    }
    if (
      node.kind === SyntaxKind.FunctionType &&
      node.parent.kind === SyntaxKind.TypeAliasDeclaration &&
      !hasJSDoc(node.parent, sourceFile)
    ) {
      violations.push("jsdoc:callable-type")
    }
    if (isImportDeclaration(node) || isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier
      if (specifier !== undefined && isStringLiteral(specifier)) inspectModule(specifier.text)
    }
    node.forEachChild(visit)
  }

  sourceFile.forEachChild(visit)
  return violations
}

/** Opens one TypeScript project and disposes every project-service resource afterward. */
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
  const root = await mkdtemp(join(tmpdir(), "likego-nats-jetstream-source-policy-"))
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

test("the functional-option rest exception requires a same-line explanation", async () => {
  const violations = await syntheticViolations(
    [
      "/** Applies one option. */",
      "type NatsJetStreamOption = (value: unknown) => void",
      "/** Unjustified option overload. */",
      "export function newNatsJetStreamServer(...options: readonly NatsJetStreamOption[]): void",
      "/** Justified option overload. */",
      "export function newNatsJetStreamServer(...options: readonly NatsJetStreamOption[] /* likego-typed-rest: preserves the functional-option ABI. */): void"
    ].join("\n")
  )
  expect(violations.filter((violation) => violation === "syntax:rest")).toEqual(["syntax:rest"])
})

test("production source is documented, assertion-free, class-free, and extensionless", async () => {
  const packageRoot = `${import.meta.dir}/..`
  const sourceRoot = `${packageRoot}/src`
  const packageFiles: string[] = []
  const violations: string[] = []
  for await (const file of new Bun.Glob("**/*.ts").scan({ cwd: sourceRoot, onlyFiles: true })) {
    packageFiles.push(file)
  }
  packageFiles.sort()
  const files = packageFiles.filter(
    (file) =>
      file === "broker-message.ts" ||
      file === "broker-runtime.ts" ||
      file === "jetstream-broker.ts" ||
      file === "jetstream.ts"
  )
  const sourcePaths = new Set(files.map((file) => normalize(resolve(sourceRoot, file))))
  await withProject(packageRoot, `${packageRoot}/tsconfig.json`, async (project) => {
    for (const file of files) {
      const sourceFile = await project.program.getSourceFile(`${sourceRoot}/${file}`)
      if (sourceFile === undefined) throw new Error(`production source file is missing: ${file}`)
      for (const violation of sourceViolations(sourceFile, sourcePaths)) {
        violations.push(`${file}:${violation}`)
      }
    }
  })

  expect(files).toEqual([
    "broker-message.ts",
    "broker-runtime.ts",
    "jetstream-broker.ts",
    "jetstream.ts"
  ])
  expect(violations).toEqual([])
})

test("the upstream declaration exception remains package-local", async () => {
  const packageBuild = await Bun.file(`${import.meta.dir}/../tsconfig.json`).json()
  const packageTest = await Bun.file(`${import.meta.dir}/../tsconfig.test.json`).json()
  const rootBase = await Bun.file(`${import.meta.dir}/../../../tsconfig.base.json`).json()

  expect(packageBuild.compilerOptions.skipLibCheck).toBe(true)
  expect(packageTest.compilerOptions.skipLibCheck).toBe(true)
  expect(rootBase.compilerOptions.skipLibCheck).toBe(false)
  expect(rootBase.compilerOptions.exactOptionalPropertyTypes).toBe(true)
})
