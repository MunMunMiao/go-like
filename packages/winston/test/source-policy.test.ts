import { normalize, resolve } from "node:path"

import { expect, test } from "bun:test"
import { API, type Project, type Snapshot } from "typescript/unstable/async"
import {
  SyntaxKind,
  isAsExpression,
  isClassDeclaration,
  isClassExpression,
  isExportDeclaration,
  isIdentifier,
  isImportDeclaration,
  isNonNullExpression,
  isStringLiteral,
  isTypeAssertion,
  type Node,
  type SourceFile
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
  "@likego/web",
  "winston"
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

/** Reports whether one import addresses package-local source. */
function relativeModule(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../")
}

/** Collects strict production policy violations from one parsed source file. */
function sourceViolations(sourceFile: SourceFile, sourceFiles: ReadonlySet<string>): string[] {
  const violations: string[] = []
  if (/@ts-(?:ignore|expect-error|nocheck)\b/.test(sourceFile.text)) {
    violations.push("syntax:ts-suppression")
  }

  /** Checks one static module specifier against the package boundary. */
  function inspectModule(specifier: string): void {
    if (!relativeModule(specifier)) {
      if (!AllowedPackages.has(specifier)) violations.push(`module:${specifier}`)
      return
    }
    if (/\.(?:[cm]?js|[cm]?ts)$/.test(specifier)) {
      violations.push(`module:${specifier}`)
      return
    }
    const directory = sourceFile.fileName.slice(0, sourceFile.fileName.lastIndexOf("/"))
    const target = normalize(resolve(directory, `${specifier}.ts`))
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

/** Opens one TypeScript project and disposes its native snapshot deterministically. */
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

test("production source remains narrow native Winston integration", async () => {
  const packageRoot = `${import.meta.dir}/..`
  const sourceRoot = `${packageRoot}/src`
  const files: string[] = []
  for await (const file of new Bun.Glob("**/*.ts").scan({ cwd: sourceRoot, onlyFiles: true })) {
    files.push(file)
  }
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
  expect(files).toEqual(["errors.ts", "index.ts", "logging.ts", "server.ts", "types.ts"])
  expect(violations).toEqual([])
  const server = await Bun.file(`${sourceRoot}/server.ts`).text()
  expect(server).toContain("logger.end()")
  expect(server).not.toContain("logger.close()")
  expect(server).not.toContain("logger.transports")
})
