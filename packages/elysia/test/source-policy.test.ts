import { expect, test } from "bun:test"
import { API, type Snapshot } from "typescript/unstable/async"
import {
  SyntaxKind,
  isAsExpression,
  isClassDeclaration,
  isClassExpression,
  isDecorator,
  isFunctionDeclaration,
  isImportDeclaration,
  isNonNullExpression,
  isStringLiteral,
  isTypeAssertion,
  type Node,
  type SourceFile
} from "typescript/unstable/ast"

const AllowedModules = new Set(["@likego/web", "elysia"])

/** Reports whether one callable declaration has an adjacent JSDoc block. */
function hasJSDoc(node: Node, sourceFile: SourceFile): boolean {
  const leading = sourceFile.text.slice(node.getFullStart(), node.getStart(sourceFile))
  return /\/\*\*[\s\S]*\*\/\s*$/.test(leading)
}

/** Collects the framework bridge production-policy violations from one source file. */
function violations(sourceFile: SourceFile): readonly string[] {
  const found: string[] = []
  /** Visits one syntax node and its descendants. */
  function visit(node: Node): void {
    if (isClassDeclaration(node) || isClassExpression(node)) found.push("custom-class")
    if (isDecorator(node)) found.push("decorator")
    if (isAsExpression(node) || isTypeAssertion(node) || isNonNullExpression(node))
      found.push("type-assertion")
    if (node.kind === SyntaxKind.AnyKeyword) found.push("explicit-any")
    if (node.kind === SyntaxKind.SpreadElement || node.kind === SyntaxKind.SpreadAssignment)
      found.push("spread")
    if (
      node.kind === SyntaxKind.Parameter &&
      node.getText(sourceFile).trimStart().startsWith("...")
    )
      found.push("rest")
    if (isFunctionDeclaration(node) && !hasJSDoc(node, sourceFile)) {
      found.push(`undocumented-function:${node.name?.text ?? "<anonymous>"}`)
    }
    if (isImportDeclaration(node) && isStringLiteral(node.moduleSpecifier)) {
      if (!AllowedModules.has(node.moduleSpecifier.text))
        found.push(`module:${node.moduleSpecifier.text}`)
    }
    node.forEachChild(visit)
  }
  sourceFile.forEachChild(visit)
  if (/^\s*\/\/\s*@ts-(?:ignore|nocheck|expect-error)/m.test(sourceFile.text))
    found.push("typescript-suppression")
  return found
}

test("production source is a documented thin native bridge without unsafe language features", async () => {
  const packageRoot = `${import.meta.dir}/..`
  const api = new API({ cwd: packageRoot })
  let snapshot: Snapshot | null = null
  try {
    snapshot = await api.updateSnapshot({ openProjects: [`${packageRoot}/tsconfig.json`] })
    const project = snapshot.getProjects()[0]
    if (project === undefined || snapshot.getProjects().length !== 1)
      throw new Error("source policy project is missing")
    const sourceFile = await project.program.getSourceFile(`${packageRoot}/src/index.ts`)
    if (sourceFile === undefined) throw new Error("production source is missing")
    expect(violations(sourceFile)).toEqual([])
  } finally {
    if (snapshot !== null) await snapshot.dispose()
    await api.close()
  }
})
