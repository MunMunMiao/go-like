import { expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { API, type Snapshot } from "typescript/unstable/async"
import {
  SyntaxKind,
  isAsExpression,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isNonNullExpression,
  isTypeAssertion,
  type Node,
  type SourceFile
} from "typescript/unstable/ast"

/** Collects prohibited source forms from one parsed TypeScript source file. */
function sourceViolations(sourceFile: SourceFile): string[] {
  const violations: string[] = []
  /** Visits one TypeScript syntax node exactly once. */
  function visit(node: Node): void {
    if (isClassDeclaration(node) || isClassExpression(node)) violations.push("class")
    if (node.kind === SyntaxKind.AnyKeyword) violations.push("explicit-any")
    if (isAsExpression(node) || isTypeAssertion(node) || isNonNullExpression(node)) {
      violations.push("type-assertion")
    }
    if (node.kind === SyntaxKind.SpreadElement || node.kind === SyntaxKind.SpreadAssignment) {
      violations.push("spread")
    }
    if (isCallExpression(node) && node.expression.getText(sourceFile) === "Object.assign") {
      violations.push("Object.assign")
    }
    node.forEachChild(visit)
  }
  sourceFile.forEachChild(visit)
  if (/@ts-(?:ignore|expect-error|nocheck)\b/.test(sourceFile.text)) {
    violations.push("suppression")
  }
  return violations
}

test("source contains no classes assertions any spread or Object.assign", async () => {
  const packageRoot = join(import.meta.dir, "..")
  const sourceRoot = join(packageRoot, "src")
  const api = new API({ cwd: packageRoot })
  let snapshot: Snapshot | null = null
  try {
    snapshot = await api.updateSnapshot({ openProjects: [join(packageRoot, "tsconfig.json")] })
    const project = snapshot.getProjects()[0]
    if (project === undefined) throw new Error("Memory Cache source-policy project is missing")
    const violations: string[] = []
    for (const name of await readdir(sourceRoot)) {
      if (!name.endsWith(".ts")) continue
      const sourceFile = await project.program.getSourceFile(join(sourceRoot, name))
      if (sourceFile === undefined) throw new Error(`Memory Cache source file ${name} is missing`)
      for (const violation of sourceViolations(sourceFile)) {
        violations.push(`${name}:${violation}`)
      }
    }
    expect(violations).toEqual([])
  } finally {
    if (snapshot !== null) await snapshot.dispose()
    await api.close()
  }
})
