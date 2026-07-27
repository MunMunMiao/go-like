import { expect, test } from "bun:test"
import { API, type Project, type Snapshot } from "typescript/unstable/async"
import {
  isArrowFunction,
  isAsExpression,
  isClassDeclaration,
  isClassExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isMethodDeclaration,
  isNonNullExpression,
  isTypeAssertion,
  isVariableDeclaration,
  SyntaxKind,
  type Node,
  type SourceFile,
  type VariableDeclaration
} from "typescript/unstable/ast"

function namedFunctionDeclaration(node: Node): VariableDeclaration | null {
  if (!isArrowFunction(node) && !isFunctionExpression(node)) return null
  const parent = node.parent
  if (!isVariableDeclaration(parent) || parent.name.kind !== SyntaxKind.Identifier) return null
  return parent
}

function hasJSDoc(node: Node, sourceFile: SourceFile): boolean {
  const leading = sourceFile.text.slice(node.getFullStart(), node.getStart(sourceFile))
  return /\/\*\*[\s\S]*\*\/\s*$/.test(leading)
}

/** Admits only the documented Client call rest list required by its public ABI. */
function allowedRestParameter(node: Node, sourceFile: SourceFile): boolean {
  const parameter = node.getText(sourceFile)
  const start = node.getStart(sourceFile)
  const newline = sourceFile.text.indexOf("\n", start)
  const end = newline < 0 ? sourceFile.text.length : newline
  return (
    sourceFile.text.slice(start, end).includes("likego-typed-rest:") &&
    parameter.startsWith("...options: readonly CallOption[]") &&
    ((isMethodDeclaration(node.parent) && node.parent.name.getText(sourceFile) === "call") ||
      (isFunctionDeclaration(node.parent) && node.parent.name?.text === "measuredCall"))
  )
}

function violations(sourceFile: SourceFile): readonly string[] {
  const found: string[] = []
  const visit = (node: Node): void => {
    if (isClassDeclaration(node) || isClassExpression(node)) found.push("custom-class")
    if (isAsExpression(node) || isTypeAssertion(node) || isNonNullExpression(node))
      found.push("type-assertion")
    if (isVariableDeclaration(node) && node.exclamationToken !== undefined)
      found.push("definite-assignment")
    if (node.kind === SyntaxKind.AnyKeyword) found.push("explicit-any")
    if (node.kind === SyntaxKind.SpreadElement || node.kind === SyntaxKind.SpreadAssignment)
      found.push("spread")
    if (
      node.kind === SyntaxKind.Parameter &&
      node.getText(sourceFile).trimStart().startsWith("...") &&
      !allowedRestParameter(node, sourceFile)
    )
      found.push("rest")
    if (isFunctionDeclaration(node) && !hasJSDoc(node, sourceFile)) {
      found.push(`undocumented-function:${node.name?.text ?? "<anonymous>"}`)
    }
    const declaration = namedFunctionDeclaration(node)
    if (declaration !== null) {
      const statement = declaration.parent.parent
      if (!hasJSDoc(declaration, sourceFile) && !hasJSDoc(statement, sourceFile)) {
        found.push(`undocumented-function:${declaration.name.getText(sourceFile)}`)
      }
    }
    if (isMethodDeclaration(node) && !hasJSDoc(node, sourceFile)) {
      found.push(`undocumented-method:${node.name.getText(sourceFile)}`)
    }
    if (node.kind === SyntaxKind.MethodSignature && !hasJSDoc(node, sourceFile)) {
      found.push(
        `undocumented-method:${node.getText(sourceFile).split("(", 1)[0]?.trim() ?? "<anonymous>"}`
      )
    }
    node.forEachChild(visit)
  }
  sourceFile.forEachChild(visit)
  if (/^\s*\/\/\s*@ts-(?:ignore|nocheck|expect-error)/m.test(sourceFile.text))
    found.push("typescript-suppression")
  return found
}

async function withProject<T>(use: (project: Project) => Promise<T>): Promise<T> {
  const packageRoot = `${import.meta.dir}/..`
  const api = new API({ cwd: packageRoot })
  let snapshot: Snapshot | null = null
  try {
    snapshot = await api.updateSnapshot({ openProjects: [`${packageRoot}/tsconfig.json`] })
    const project = snapshot.getProjects()[0]
    if (project === undefined || snapshot.getProjects().length !== 1) {
      throw new Error("source policy requires exactly one project")
    }
    return await use(project)
  } finally {
    if (snapshot !== null) await snapshot.dispose()
    await api.close()
  }
}

test("production source has no custom classes, unsafe type escapes, suppressions, or undocumented callables", async () => {
  const packageRoot = `${import.meta.dir}/..`
  const files: string[] = []
  for await (const file of new Bun.Glob("src/**/*.ts").scan({ cwd: packageRoot, onlyFiles: true }))
    files.push(file)
  files.sort()

  const found = await withProject(async (project) => {
    const result: string[] = []
    for (const file of files) {
      const sourceFile = await project.program.getSourceFile(`${packageRoot}/${file}`)
      if (sourceFile === undefined) throw new Error(`production source file is missing: ${file}`)
      for (const violation of violations(sourceFile)) result.push(`${file}:${violation}`)
    }
    return result
  })

  expect(files).toEqual(["src/index.ts"])
  expect(found).toEqual([])
})
