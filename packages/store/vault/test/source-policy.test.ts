import { expect, test } from "bun:test"
import { API, type Project, type Snapshot } from "typescript/unstable/async"
import {
  SyntaxKind,
  isExportDeclaration,
  isImportDeclaration,
  isStringLiteral,
  type Node,
  type SourceFile
} from "typescript/unstable/ast"

const AllowedModules = new Set([
  "@likego/context",
  "@likego/core/lifecycle",
  "@likego/store",
  "@likego/store/provider"
])
const ForbiddenKinds = new Set([
  SyntaxKind.AnyKeyword,
  SyntaxKind.AsExpression,
  SyntaxKind.ClassDeclaration,
  SyntaxKind.ClassExpression,
  SyntaxKind.NonNullExpression,
  SyntaxKind.SpreadAssignment,
  SyntaxKind.SpreadElement,
  SyntaxKind.TypeAssertionExpression
])

function violations(source: SourceFile): string[] {
  const text = source.text
  const found: string[] = []
  function visit(node: Node): void {
    if (ForbiddenKinds.has(node.kind)) found.push(SyntaxKind[node.kind] ?? String(node.kind))
    if (node.kind === SyntaxKind.Parameter && node.getText(source).trimStart().startsWith("...")) {
      found.push("RestParameter")
    }
    if (isImportDeclaration(node) || isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier
      if (
        specifier !== undefined &&
        isStringLiteral(specifier) &&
        !specifier.text.startsWith(".") &&
        !AllowedModules.has(specifier.text)
      ) {
        found.push(`Module:${specifier.text}`)
      }
    }
    node.forEachChild(visit)
  }
  source.forEachChild(visit)
  if (/\bObject\.assign\s*\(/u.test(text)) found.push("Object.assign")
  if (/@ts-(?:ignore|expect-error|nocheck)\b/u.test(text)) found.push("TypeScriptSuppression")
  return found
}

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

test("production source is classless, assertion-free, spread-free, and Web portable", async () => {
  const root = `${import.meta.dir}/..`
  const found = await withProject(root, async function inspect(project) {
    const results: string[] = []
    for await (const file of new Bun.Glob("src/**/*.ts").scan({ cwd: root, onlyFiles: true })) {
      const source = await project.program.getSourceFile(`${root}/${file}`)
      if (source === undefined) throw new Error(`production source missing: ${file}`)
      for (const violation of violations(source)) results.push(`${file}:${violation}`)
    }
    return results
  })
  expect(found).toEqual([])
})

test("development trees contain no handwritten JavaScript or extensionful relative imports", async () => {
  const root = `${import.meta.dir}/..`
  const found: string[] = []
  for (const tree of ["src", "test"]) {
    for await (const file of new Bun.Glob("**/*").scan({
      cwd: `${root}/${tree}`,
      onlyFiles: true
    })) {
      if (!file.endsWith(".ts") && !file.endsWith(".md")) found.push(`${tree}/${file}`)
      if (!file.endsWith(".ts")) continue
      const text = await Bun.file(`${root}/${tree}/${file}`).text()
      for (const match of text.matchAll(/(?:from\s+|import\s*\()(["'])(\.\.?\/[^"']+)\1/gu)) {
        if (/\.[cm]?[jt]sx?$/u.test(match[2] ?? "")) found.push(`${tree}/${file}:${match[2]}`)
      }
    }
  }
  expect(found).toEqual([])
})
