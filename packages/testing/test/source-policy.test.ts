import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { expect, test } from "bun:test"
import { API, type Project, type Snapshot } from "typescript/unstable/async"
import {
  SyntaxKind,
  isArrowFunction,
  isAsExpression,
  isCallSignatureDeclaration,
  isClassDeclaration,
  isClassExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isFunctionTypeNode,
  isIdentifier,
  isImportDeclaration,
  isMethodDeclaration,
  isMethodSignatureDeclaration,
  isNonNullExpression,
  isPropertyAssignment,
  isPropertySignatureDeclaration,
  isStringLiteral,
  isTypeAliasDeclaration,
  isTypeAssertion,
  isVariableDeclaration,
  isVariableStatement,
  type Node,
  type SourceFile
} from "typescript/unstable/ast"

/** Finds the declaration site that owns one business-meaningful callable. */
function callableOwner(node: Node): Node | null {
  if (
    isFunctionDeclaration(node) ||
    isMethodDeclaration(node) ||
    isMethodSignatureDeclaration(node) ||
    isCallSignatureDeclaration(node)
  )
    return node
  if (isFunctionTypeNode(node)) {
    if (isTypeAliasDeclaration(node.parent) || isPropertySignatureDeclaration(node.parent)) {
      return node.parent
    }
    return null
  }
  if (!isArrowFunction(node) && !isFunctionExpression(node)) return null
  if (isVariableDeclaration(node.parent)) {
    const statement = node.parent.parent.parent
    return isVariableStatement(statement) ? statement : node.parent
  }
  if (isPropertyAssignment(node.parent)) return node.parent
  if (isFunctionExpression(node) && node.name !== undefined) return node
  return null
}

/** Returns a stable diagnostic name for one business-meaningful callable. */
function callableName(node: Node): string {
  if (isFunctionDeclaration(node)) return node.name?.text ?? "<anonymous>"
  if (isMethodDeclaration(node) || isMethodSignatureDeclaration(node)) {
    return node.name.getText(node.getSourceFile())
  }
  if (isCallSignatureDeclaration(node)) return "<call-signature>"
  if (isFunctionTypeNode(node)) {
    if (isTypeAliasDeclaration(node.parent)) return node.parent.name.text
    if (isPropertySignatureDeclaration(node.parent))
      return node.parent.name.getText(node.getSourceFile())
  }
  if (isArrowFunction(node) || isFunctionExpression(node)) {
    if (isVariableDeclaration(node.parent) && isIdentifier(node.parent.name))
      return node.parent.name.text
    if (isPropertyAssignment(node.parent)) return node.parent.name.getText(node.getSourceFile())
    if (isFunctionExpression(node)) return node.name?.text ?? "<anonymous>"
  }
  return "<unknown>"
}

function hasJSDoc(node: Node, sourceFile: SourceFile): boolean {
  const leading = sourceFile.text.slice(node.getFullStart(), node.getStart(sourceFile))
  return /\/\*\*[\s\S]*\*\/\s*$/.test(leading)
}

/** Reports whether a parameter or binding element owns an actual rest token. */
function hasRestToken(node: Node): boolean {
  if (node.kind !== SyntaxKind.Parameter && node.kind !== SyntaxKind.BindingElement) return false
  return "dotDotDotToken" in node && node.dotDotDotToken !== undefined
}

function violations(sourceFile: SourceFile): readonly string[] {
  const found: string[] = []
  const visit = (node: Node): void => {
    if (isClassDeclaration(node) || isClassExpression(node)) found.push("custom-class")
    if (isAsExpression(node) || isTypeAssertion(node) || isNonNullExpression(node)) {
      found.push("type-assertion")
    }
    if (isVariableDeclaration(node) && node.exclamationToken !== undefined) {
      found.push("definite-assignment")
    }
    if (node.kind === SyntaxKind.AnyKeyword) found.push("explicit-any")
    if (node.kind === SyntaxKind.SpreadElement) found.push("spread-element")
    if (node.kind === SyntaxKind.SpreadAssignment) found.push("spread-assignment")
    if (hasRestToken(node)) found.push("rest-element")
    if (isImportDeclaration(node)) {
      const specifier = node.moduleSpecifier
      if (isStringLiteral(specifier) && /^(node:|bun:|deno:|npm:|jsr:)/.test(specifier.text)) {
        found.push(`runtime-module:${specifier.text}`)
      }
    }
    const owner = callableOwner(node)
    if (owner !== null && !hasJSDoc(owner, sourceFile)) {
      found.push(`undocumented-callable:${callableName(node)}`)
    }
    node.forEachChild(visit)
  }
  sourceFile.forEachChild(visit)
  if (/^\s*\/\/\s*@ts-(?:ignore|nocheck|expect-error)/m.test(sourceFile.text)) {
    found.push("typescript-suppression")
  }
  return found
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

/** Evaluates the source policy against one isolated synthetic TypeScript file. */
async function syntheticViolations(source: string): Promise<readonly string[]> {
  const root = await mkdtemp(join(tmpdir(), "likego-testing-callable-policy-"))
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
    return await withProject(root, configPath, async function inspect(project) {
      const sourceFile = await project.program.getSourceFile(sourcePath)
      if (sourceFile === undefined) throw new Error("synthetic source file is missing")
      return violations(sourceFile)
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test("AST policy rejects explicit any, spread, and rest syntax", async () => {
  const root = await mkdtemp(join(tmpdir(), "likego-testing-source-policy-"))
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
    await writeFile(
      sourcePath,
      [
        "const broad: any = input",
        "const spreadArray = [...items]",
        "const spreadObject = { ...input }",
        "/** Documents the synthetic forbidden rest form. */",
        "function variadic(...items: string[]): void { void items }",
        "void [broad, spreadArray, spreadObject, variadic]"
      ].join("\n")
    )
    const found = await withProject(root, configPath, async function inspect(project) {
      const sourceFile = await project.program.getSourceFile(sourcePath)
      if (sourceFile === undefined) throw new Error("synthetic source file is missing")
      return violations(sourceFile)
    })
    expect(found).toContain("explicit-any")
    expect(found).toContain("spread-element")
    expect(found).toContain("spread-assignment")
    expect(found).toContain("rest-element")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("AST policy rejects every undocumented business callable declaration form", async () => {
  const found = await syntheticViolations(
    [
      "function missingFunction(): void {}",
      "const missingArrow = (): void => {}",
      "const missingExpression = function namedExpression(): void {}",
      "void new Promise<void>(function missingExecutor(resolve) { resolve() })",
      "type MissingAlias = () => void",
      "interface MissingShape {",
      "  missingMethod(): void",
      "  (): void",
      "  missingProperty: () => void",
      "}",
      "const subject = {",
      "  run: async (): Promise<void> => {}",
      "}",
      "void [missingFunction, missingArrow, missingExpression, subject]"
    ].join("\n")
  )

  expect(found).toContain("undocumented-callable:missingFunction")
  expect(found).toContain("undocumented-callable:missingArrow")
  expect(found).toContain("undocumented-callable:missingExpression")
  expect(found).toContain("undocumented-callable:missingExecutor")
  expect(found).toContain("undocumented-callable:MissingAlias")
  expect(found).toContain("undocumented-callable:missingMethod")
  expect(found).toContain("undocumented-callable:<call-signature>")
  expect(found).toContain("undocumented-callable:missingProperty")
  expect(found).toContain("undocumented-callable:run")
})

test("AST policy accepts directly documented business callable declaration forms", async () => {
  const found = await syntheticViolations(
    [
      "/** Documents the function. */",
      "function documentedFunction(): void {}",
      "/** Documents the arrow. */",
      "const documentedArrow = (): void => {}",
      "/** Documents the function expression. */",
      "const documentedExpression = function namedExpression(): void {}",
      "void new Promise<void>(",
      "  /** Documents the inline executor. */",
      "  function documentedExecutor(resolve) { resolve() }",
      ")",
      "/** Documents the callable alias. */",
      "type DocumentedAlias = () => void",
      "interface DocumentedShape {",
      "  /** Documents the method signature. */",
      "  documentedMethod(): void",
      "  /** Documents the call signature. */",
      "  (): void",
      "  /** Documents the callable property. */",
      "  documentedProperty: () => void",
      "}",
      "const subject = {",
      "  /** Documents the object property callable. */",
      "  run: async (): Promise<void> => {}",
      "}",
      "void [documentedFunction, documentedArrow, documentedExpression, subject]"
    ].join("\n")
  )

  expect(found.filter((violation) => violation.startsWith("undocumented-callable:"))).toEqual([])
})

test("production source has no classes, unsafe type escapes, suppressions, runtime imports, or undocumented callables", async () => {
  const packageRoot = `${import.meta.dir}/..`
  const files: string[] = []
  for await (const file of new Bun.Glob("src/**/*.ts").scan({
    cwd: packageRoot,
    onlyFiles: true
  })) {
    files.push(file)
  }
  files.sort()

  const found = await withProject(packageRoot, `${packageRoot}/tsconfig.json`, async (project) => {
    const result: string[] = []
    for (const file of files) {
      const sourceFile = await project.program.getSourceFile(`${packageRoot}/${file}`)
      if (sourceFile === undefined) throw new Error(`production source file is missing: ${file}`)
      for (const violation of violations(sourceFile)) result.push(`${file}:${violation}`)
    }
    return result
  })

  expect(files).toEqual(["src/index.ts", "src/listener.ts", "src/server.ts"])
  expect(found).toEqual([])
})
