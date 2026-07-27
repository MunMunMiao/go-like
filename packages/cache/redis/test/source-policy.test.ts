import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

import { expect, test } from "bun:test"
import {
  SyntaxKind,
  createScanner,
  isAsExpression,
  isClassDeclaration,
  isClassExpression,
  isNonNullExpression,
  isTypeAssertion,
  type Node,
  type SourceFile
} from "typescript/unstable/ast"
import { API, type Snapshot } from "typescript/unstable/async"

/** Collects the prohibited source forms used by the package contract. */
function violations(sourceFile: SourceFile): string[] {
  const found: string[] = []
  /** Visits one syntax node exactly once. */
  function visit(node: Node): void {
    if (isClassDeclaration(node) || isClassExpression(node)) found.push("class")
    if (node.kind === SyntaxKind.AnyKeyword) found.push("explicit-any")
    if (isAsExpression(node) || isTypeAssertion(node) || isNonNullExpression(node)) {
      found.push("type-assertion")
    }
    if (node.kind === SyntaxKind.SpreadElement || node.kind === SyntaxKind.SpreadAssignment) {
      found.push("spread")
    }
    node.forEachChild(visit)
  }
  sourceFile.forEachChild(visit)
  const scanner = createScanner(false, sourceFile.languageVariant, sourceFile.text)
  while (scanner.scan() !== SyntaxKind.EndOfFile) {
    const token = scanner.getToken()
    if (
      token !== SyntaxKind.SingleLineCommentTrivia &&
      token !== SyntaxKind.MultiLineCommentTrivia
    ) {
      continue
    }
    if (/@ts-(?:ignore|expect-error|nocheck)\b/.test(scanner.getTokenText())) {
      found.push("suppression")
    }
  }
  if (/\bObject\.assign\s*\(/.test(sourceFile.text)) found.push("Object.assign")
  return found
}

test("Redis Cache production source satisfies the classless assertion-free policy", async () => {
  const root = join(import.meta.dir, "..")
  const api = new API({ cwd: root })
  let snapshot: Snapshot | null = null
  try {
    snapshot = await api.updateSnapshot({ openProjects: [join(root, "tsconfig.json")] })
    const projects = snapshot.getProjects()
    if (projects.length !== 1) throw new Error("source policy requires exactly one project")
    const project = projects[0]
    if (project === undefined) throw new Error("source policy project is missing")
    const found: string[] = []
    const sourceRoot = join(root, "src")
    for (const name of await readdir(sourceRoot)) {
      if (!name.endsWith(".ts")) continue
      const sourceFile = await project.program.getSourceFile(join(sourceRoot, name))
      if (sourceFile === undefined) throw new Error(`production source is missing: ${name}`)
      for (const violation of violations(sourceFile)) {
        found.push(`${sourceFile.fileName}:${violation}`)
      }
    }
    expect(found).toEqual([])
  } finally {
    if (snapshot !== null) await snapshot.dispose()
    await api.close()
  }
})

test("Redis Cache source and test trees contain TypeScript or reports only", async () => {
  for (const directory of [join(import.meta.dir, "..", "src"), import.meta.dir]) {
    for (const name of await readdir(directory, { recursive: true })) {
      const path = join(directory, name)
      if (name.endsWith(".ts")) await readFile(path, "utf8")
      else if (!name.includes(".") || name.endsWith(".md")) continue
      else expect(name.endsWith(".ts") || name.endsWith(".md")).toBe(true)
    }
  }
})
