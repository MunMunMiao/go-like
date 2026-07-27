import { extname } from "node:path"

import { expect, test } from "bun:test"
import { API, type Project, type Snapshot } from "typescript/unstable/async"
import {
  SyntaxKind,
  createScanner,
  isAsExpression,
  isClassDeclaration,
  isClassExpression,
  isExportDeclaration,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isNonNullExpression,
  isPropertyDeclaration,
  isStringLiteral,
  isTypeAssertion,
  isVariableDeclaration,
  type Node,
  type SourceFile
} from "typescript/unstable/ast"

const AllowedModules = new Set(["@likego/config", "@likego/context", "@likego/core/lifecycle"])
const ForbiddenGlobals = new Set([
  "AsyncLocalStorage",
  "Bun",
  "Deno",
  "Reflect",
  "global",
  "globalThis",
  "module",
  "process",
  "require"
])
const FunctionKinds = new Set([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor
])
const CallableKinds = new Set([SyntaxKind.CallSignature, SyntaxKind.MethodSignature])

/** Reports whether one declaration has non-empty JSDoc attached by TypeScript. */
function hasJSDoc(node: Node): boolean {
  return (
    node.jsDoc?.some(function nonEmpty(doc) {
      return (
        doc
          .getText(node.getSourceFile())
          .replace(/^\/\*\*|\*\/$/g, "")
          .replace(/\*/g, "")
          .trim() !== ""
      )
    }) === true
  )
}

/** Scans actual comment trivia for TypeScript suppression directives. */
function suppressionViolations(sourceFile: SourceFile): string[] {
  const scanner = createScanner(false, sourceFile.languageVariant, sourceFile.text)
  const violations: string[] = []
  while (scanner.scan() !== SyntaxKind.EndOfFile) {
    const token = scanner.getToken()
    if (token !== SyntaxKind.SingleLineCommentTrivia && token !== SyntaxKind.MultiLineCommentTrivia)
      continue
    if (/@ts-(?:ignore|expect-error|nocheck)\b/.test(scanner.getTokenText()))
      violations.push("ts-suppression")
  }
  return violations
}

/** Finds every prohibited production syntax, module, global, and missing callable JSDoc. */
function sourceViolations(sourceFile: SourceFile): string[] {
  const violations = suppressionViolations(sourceFile)
  /** Recursively checks one compiler node. */
  function visit(node: Node): void {
    if (isClassDeclaration(node) || isClassExpression(node)) violations.push("class")
    if (isAsExpression(node) || isTypeAssertion(node) || isNonNullExpression(node))
      violations.push("assertion")
    if (
      (isVariableDeclaration(node) || isPropertyDeclaration(node)) &&
      node.getText(sourceFile).includes("!:")
    )
      violations.push("definite-assignment")
    if (node.kind === SyntaxKind.AnyKeyword) violations.push("explicit-any")
    if (node.kind === SyntaxKind.SpreadElement || node.kind === SyntaxKind.SpreadAssignment)
      violations.push("spread")
    if (
      node.kind === SyntaxKind.Parameter &&
      node.getText(sourceFile).trimStart().startsWith("...")
    )
      violations.push("rest")
    if (FunctionKinds.has(node.kind) && !hasJSDoc(node)) violations.push(`jsdoc:${node.kind}`)
    if (CallableKinds.has(node.kind) && !hasJSDoc(node)) violations.push(`jsdoc:${node.kind}`)
    if (
      node.kind === SyntaxKind.FunctionType &&
      (node.parent.kind === SyntaxKind.TypeAliasDeclaration ||
        node.parent.kind === SyntaxKind.PropertySignature) &&
      !hasJSDoc(node.parent)
    )
      violations.push("jsdoc:function-type")
    if (isIdentifier(node) && ForbiddenGlobals.has(node.text))
      violations.push(`global:${node.text}`)
    if (isImportEqualsDeclaration(node)) violations.push("import-equals")
    if (isImportDeclaration(node) || isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier
      if (specifier !== undefined && isStringLiteral(specifier)) {
        if (specifier.text.startsWith(".")) {
          if (extname(specifier.text) !== "")
            violations.push(`relative-extension:${specifier.text}`)
        } else if (!AllowedModules.has(specifier.text)) violations.push(`module:${specifier.text}`)
      }
    }
    node.forEachChild(visit)
  }
  sourceFile.forEachChild(visit)
  return violations
}

/** Opens exactly one compiler project and always disposes its session. */
async function withProject<T>(root: string, use: (project: Project) => Promise<T>): Promise<T> {
  const api = new API({ cwd: root })
  let snapshot: Snapshot | null = null
  try {
    snapshot = await api.updateSnapshot({ openProjects: [`${root}/tsconfig.json`] })
    const projects = snapshot.getProjects()
    if (projects.length !== 1) throw new Error("source policy requires exactly one project")
    const project = projects[0]
    if (project === undefined) throw new Error("source policy project missing")
    return await use(project)
  } finally {
    if (snapshot !== null) await snapshot.dispose()
    await api.close()
  }
}

test("production source satisfies classless, documented, assertion-free, portable syntax policy", async () => {
  const packageRoot = `${import.meta.dir}/..`
  const sourcePath = `${packageRoot}/src/index.ts`
  const violations = await withProject(packageRoot, async function inspect(project) {
    const sourceFile = await project.program.getSourceFile(sourcePath)
    if (sourceFile === undefined) throw new Error("production source missing")
    return sourceViolations(sourceFile)
  })
  expect(violations).toEqual([])
})

test("development trees contain only TypeScript and extensionless relative module specifiers", async () => {
  const packageRoot = `${import.meta.dir}/..`
  const violations: string[] = []
  for (const tree of ["src", "test"]) {
    for await (const file of new Bun.Glob("**/*").scan({
      cwd: `${packageRoot}/${tree}`,
      onlyFiles: true
    })) {
      if (!file.endsWith(".ts") && !file.endsWith(".md"))
        violations.push(`handwritten-javascript:${tree}/${file}`)
      if (!file.endsWith(".ts")) continue
      const text = await Bun.file(`${packageRoot}/${tree}/${file}`).text()
      for (const match of text.matchAll(/(?:from\s+|import\s*\()(["'])(\.\.?\/[^"']+)\1/g)) {
        const specifier = match[2]
        if (specifier !== undefined && extname(specifier) !== "")
          violations.push(`relative-extension:${tree}/${file}:${specifier}`)
      }
    }
  }
  expect(violations).toEqual([])
})
