import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { expect, test } from "bun:test"
import { API, type Project, type Snapshot } from "typescript/unstable/async"
import {
  SyntaxKind,
  createScanner,
  isArrowFunction,
  isAsExpression,
  isCallSignatureDeclaration,
  isClassDeclaration,
  isClassExpression,
  isDecorator,
  isFunctionDeclaration,
  isFunctionExpression,
  isFunctionTypeNode,
  isGetAccessorDeclaration,
  isImportDeclaration,
  isMethodDeclaration,
  isMethodSignatureDeclaration,
  isNonNullExpression,
  isPrivateIdentifier,
  isPropertyAssignment,
  isPropertySignatureDeclaration,
  isSetAccessorDeclaration,
  isStringLiteral,
  isTypeAliasDeclaration,
  isTypeAssertion,
  isVariableDeclaration,
  isVariableStatement,
  type Node,
  type SourceFile
} from "typescript/unstable/ast"

/** Reports whether one declaration owns a meaningful JSDoc block. */
function hasJSDoc(node: Node): boolean {
  return (
    node.jsDoc?.some((doc) => {
      const text = doc.getText(node.getSourceFile())
      return (
        text
          .replace(/^\/\*\*|\*\/$/g, "")
          .replace(/\*/g, "")
          .trim() !== ""
      )
    }) === true
  )
}

/** Finds the declaration that owns one business-meaningful callable. */
function callableOwner(node: Node): Node | null {
  if (
    isFunctionDeclaration(node) ||
    isMethodDeclaration(node) ||
    isMethodSignatureDeclaration(node) ||
    isCallSignatureDeclaration(node) ||
    isGetAccessorDeclaration(node) ||
    isSetAccessorDeclaration(node)
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

/** Returns one stable label for an undocumented callable. */
function callableName(node: Node): string {
  if (isFunctionDeclaration(node)) return node.name?.text ?? "<anonymous>"
  if (
    isMethodDeclaration(node) ||
    isMethodSignatureDeclaration(node) ||
    isGetAccessorDeclaration(node) ||
    isSetAccessorDeclaration(node)
  )
    return node.name.getText(node.getSourceFile())
  if (isCallSignatureDeclaration(node)) return "<call-signature>"
  if (isFunctionTypeNode(node)) {
    if (isTypeAliasDeclaration(node.parent)) return node.parent.name.text
    if (isPropertySignatureDeclaration(node.parent))
      return node.parent.name.getText(node.getSourceFile())
  }
  if (isArrowFunction(node) || isFunctionExpression(node)) {
    if (isVariableDeclaration(node.parent)) return node.parent.name.getText(node.getSourceFile())
    if (isPropertyAssignment(node.parent)) return node.parent.name.getText(node.getSourceFile())
    if (isFunctionExpression(node)) return node.name?.text ?? "<anonymous>"
  }
  return "<unknown>"
}

/** Finds source-policy violations in one production module. */
function violations(sourceFile: SourceFile): readonly string[] {
  const found: string[] = []
  const scanner = createScanner(false, sourceFile.languageVariant, sourceFile.text)
  while (scanner.scan() !== SyntaxKind.EndOfFile) {
    const token = scanner.getToken()
    if (token !== SyntaxKind.SingleLineCommentTrivia && token !== SyntaxKind.MultiLineCommentTrivia)
      continue
    const match = /@ts-(ignore|expect-error|nocheck)\b/.exec(scanner.getTokenText())
    if (match !== null) found.push(`typescript-suppression:${match[1]}`)
  }

  /** Visits every syntax node and records forbidden production constructs. */
  const visit = (node: Node): void => {
    if (isClassDeclaration(node) || isClassExpression(node)) found.push("custom-class")
    if (isDecorator(node)) found.push("decorator")
    if (isPrivateIdentifier(node)) found.push("private-brand")
    if (isAsExpression(node) || isTypeAssertion(node) || isNonNullExpression(node)) {
      found.push("type-assertion")
    }
    if (isVariableDeclaration(node) && node.exclamationToken !== undefined) {
      found.push("definite-assignment")
    }
    if (node.kind === SyntaxKind.AnyKeyword) found.push("explicit-any")
    if (node.kind === SyntaxKind.SpreadElement || node.kind === SyntaxKind.SpreadAssignment) {
      found.push("spread-syntax")
    }
    if (isImportDeclaration(node)) {
      const specifier = node.moduleSpecifier
      if (isStringLiteral(specifier)) {
        if (/^(node:|bun:|deno:|npm:|jsr:)/.test(specifier.text)) {
          found.push(`runtime-module:${specifier.text}`)
        }
        if (
          !specifier.text.startsWith(".") &&
          specifier.text !== "@likego/context" &&
          specifier.text !== "@likego/metadata" &&
          specifier.text !== "@standard-schema/spec"
        ) {
          found.push(`production-dependency:${specifier.text}`)
        }
      }
    }
    const owner = callableOwner(node)
    if (owner !== null && !hasJSDoc(owner)) {
      found.push(`undocumented-callable:${callableName(node)}`)
    }
    node.forEachChild(visit)
  }
  sourceFile.forEachChild(visit)
  return found
}

/** Opens one isolated TypeScript project for AST inspection. */
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

test("detects runtime imports, classes, decorators, brands, escapes, and missing docs", async () => {
  const root = await mkdtemp(join(tmpdir(), "likego-transport-source-policy-"))
  const configPath = join(root, "tsconfig.json")
  const sourcePath = join(root, "synthetic.ts")
  try {
    await writeFile(
      configPath,
      JSON.stringify({
        compilerOptions: {
          experimentalDecorators: true,
          module: "NodeNext",
          moduleResolution: "NodeNext",
          target: "ES2023"
        },
        include: ["synthetic.ts"]
      })
    )
    await writeFile(
      sourcePath,
      [
        'import { readFile } from "node:fs"',
        'import { newApp } from "@likego/core"',
        "function mark(_value: unknown): void {}",
        "@mark class Branded { #state = 1 }",
        "function undocumented(): any { return value as any }",
        "const spread = [...items]",
        "// @ts-ignore",
        "void [readFile, newApp, Branded, undocumented, spread]"
      ].join("\n")
    )
    const found = await withProject(root, configPath, async (project) => {
      const sourceFile = await project.program.getSourceFile(sourcePath)
      if (sourceFile === undefined) throw new Error("synthetic source file is missing")
      return violations(sourceFile)
    })
    expect(found).toContain("runtime-module:node:fs")
    expect(found).toContain("production-dependency:node:fs")
    expect(found).toContain("production-dependency:@likego/core")
    expect(found).toContain("custom-class")
    expect(found).toContain("decorator")
    expect(found).toContain("private-brand")
    expect(found).toContain("type-assertion")
    expect(found).toContain("explicit-any")
    expect(found).toContain("spread-syntax")
    expect(found).toContain("undocumented-callable:undocumented")
    expect(found).toContain("typescript-suppression:ignore")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("production source is portable, structural, documented, and dependency-minimal", async () => {
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

  expect(files).toEqual([
    "src/endpoint.ts",
    "src/errors.ts",
    "src/headers.ts",
    "src/index.ts",
    "src/json.ts",
    "src/message.ts",
    "src/metadata.ts",
    "src/middleware.ts",
    "src/options.ts",
    "src/provider.ts",
    "src/testing.ts",
    "src/transport-info.ts",
    "src/types.ts"
  ])
  expect(found).toEqual([])
})
