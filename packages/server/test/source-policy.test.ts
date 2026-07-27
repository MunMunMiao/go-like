import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { extname, join } from "node:path"
import { tmpdir } from "node:os"

import { expect, test } from "bun:test"
import { API, type Project, type Snapshot } from "typescript/unstable/async"
import {
  SyntaxKind,
  createScanner,
  isAsExpression,
  isClassDeclaration,
  isClassExpression,
  isDecorator,
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

const AllowedModules = new Set([
  "@likego/context",
  "@likego/core",
  "@likego/core/lifecycle",
  "@likego/metadata",
  "@likego/registry",
  "@likego/resilience",
  "@likego/transport",
  "@likego/transport/headers",
  "@likego/transport/provider"
])
const ForbiddenGlobals = new Set([
  "AsyncLocalStorage",
  "Bun",
  "Deno",
  "process",
  "Reflect",
  "require",
  "module"
])
const FunctionLikeKinds = new Set([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor
])
const CallableDeclarationKinds = new Set([SyntaxKind.CallSignature, SyntaxKind.MethodSignature])

/** Reports whether the compiler attached one non-empty JSDoc block directly to a declaration. */
function hasJSDoc(node: Node): boolean {
  return (
    node.jsDoc?.some(function nonEmpty(doc) {
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

/** Returns a compact source label for one actionable violation. */
function nodeLabel(node: Node, sourceFile: SourceFile): string {
  return node.getText(sourceFile).split("\n", 1)[0] ?? "<unknown>"
}

/** Detects TypeScript suppression pragmas only in actual comment trivia. */
function suppressionViolations(sourceFile: SourceFile): string[] {
  const scanner = createScanner(false, sourceFile.languageVariant, sourceFile.text)
  const violations: string[] = []
  while (scanner.scan() !== SyntaxKind.EndOfFile) {
    const token = scanner.getToken()
    if (token !== SyntaxKind.SingleLineCommentTrivia && token !== SyntaxKind.MultiLineCommentTrivia)
      continue
    const match = /@ts-(ignore|expect-error|nocheck)\b/.exec(scanner.getTokenText())
    if (match !== null) violations.push(`suppression:@ts-${match[1]}`)
  }
  return violations
}

/** Reports whether a parameter or binding element owns an actual rest token. */
function hasRestToken(node: Node): boolean {
  if (node.kind !== SyntaxKind.Parameter && node.kind !== SyntaxKind.BindingElement) return false
  return "dotDotDotToken" in node && node.dotDotDotToken !== undefined
}

/** Reports whether one typed rest parameter carries explicit ABI evidence. */
function allowedRestToken(node: Node, sourceFile: SourceFile): boolean {
  if (!hasRestToken(node)) return true
  if (
    node.parent.kind === SyntaxKind.CallSignature ||
    node.parent.kind === SyntaxKind.MethodSignature
  )
    return true
  return node.parent.getFullText(sourceFile).includes("likego-typed-rest")
}

/** Reports whether one exact typed spread carries forwarding evidence. */
function allowedSpread(node: Node, sourceFile: SourceFile): boolean {
  return node.parent.getFullText(sourceFile).includes("likego-typed-spread")
}

/** Returns a forbidden module reason or null for one exact portable boundary. */
function moduleViolation(specifier: string): string | null {
  if (specifier.startsWith(".")) {
    return extname(specifier) === "" ? null : `relative-extension:${specifier}`
  }
  return AllowedModules.has(specifier) ? null : `module:${specifier}`
}

/** Finds every class, portability, documentation, assertion, and suppression violation. */
function sourceViolations(sourceFile: SourceFile): string[] {
  const violations = suppressionViolations(sourceFile)
  /** Recursively inspects one compiler node without a text-regex escape hatch. */
  function visit(node: Node): void {
    if (isClassDeclaration(node))
      violations.push(`class-declaration:${nodeLabel(node, sourceFile)}`)
    else if (isClassExpression(node))
      violations.push(`class-expression:${nodeLabel(node, sourceFile)}`)
    else if (isDecorator(node)) violations.push("decorator")
    else if (isImportEqualsDeclaration(node)) violations.push("import-equals")
    else if (isAsExpression(node)) violations.push("type-assertion:as")
    else if (isTypeAssertion(node)) violations.push("type-assertion:angle")
    else if (isNonNullExpression(node)) violations.push("type-assertion:non-null")
    else if (
      (isVariableDeclaration(node) || isPropertyDeclaration(node)) &&
      node.getText(sourceFile).includes("!:")
    )
      violations.push("type-assertion:definite-assignment")
    else if (node.kind === SyntaxKind.AnyKeyword) violations.push("explicit-any")
    else if (node.kind === SyntaxKind.SpreadElement && !allowedSpread(node, sourceFile))
      violations.push("spread-element")
    else if (node.kind === SyntaxKind.SpreadAssignment) violations.push("spread-assignment")
    else if (!allowedRestToken(node, sourceFile)) violations.push("rest-element")

    if (FunctionLikeKinds.has(node.kind) && !hasJSDoc(node)) {
      violations.push(`jsdoc:function-like:${nodeLabel(node, sourceFile)}`)
    }
    if (CallableDeclarationKinds.has(node.kind) && !hasJSDoc(node)) {
      violations.push(`jsdoc:callable-declaration:${nodeLabel(node, sourceFile)}`)
    }
    if (
      node.kind === SyntaxKind.FunctionType &&
      (node.parent.kind === SyntaxKind.TypeAliasDeclaration ||
        node.parent.kind === SyntaxKind.PropertySignature) &&
      !hasJSDoc(node.parent)
    ) {
      violations.push(`jsdoc:callable-type:${nodeLabel(node.parent, sourceFile)}`)
    }
    if (isIdentifier(node) && ForbiddenGlobals.has(node.text)) {
      violations.push(`global:${node.text}`)
    }
    if (isImportDeclaration(node) || isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier
      if (specifier !== undefined && isStringLiteral(specifier)) {
        const violation = moduleViolation(specifier.text)
        if (violation !== null) violations.push(violation)
      }
    }
    node.forEachChild(visit)
  }
  sourceFile.forEachChild(visit)
  return violations
}

/** Opens exactly one compiler project for fail-closed source inspection. */
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

test("AST and scanner policy fail closed on every forbidden production form", async () => {
  const root = await mkdtemp(join(tmpdir(), "likego-server-source-policy-"))
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
        'import "node:fs"',
        'import type { Context } from "./context.js"',
        'import legacy = require("node:path")',
        "class Named {}",
        "const Anonymous = class {}",
        "function undocumented(): void {}",
        "const arrow = () => 1",
        "const expression = function () {}",
        "const object = { method(): void {} }",
        "const broad: any = input",
        "const spreadArray = [...items]",
        "const spreadObject = { ...object }",
        "/** Documents a forbidden rest fixture. */",
        "function rest(...values: unknown[]): void { void values }",
        "const value = input as string",
        "const angle = <string>input",
        "const nonNull = input!",
        "let assigned!: string",
        "// @ts-ignore",
        "void [Context, legacy, Anonymous, arrow, expression, object, broad, spreadArray, spreadObject, rest, value, angle, nonNull, assigned, Bun, Reflect]"
      ].join("\n")
    )
    const found = await withProject(root, configPath, async function inspect(project) {
      const sourceFile = await project.program.getSourceFile(sourcePath)
      if (sourceFile === undefined) throw new Error("synthetic source file is missing")
      return sourceViolations(sourceFile)
    })
    expect(found).toContain("module:node:fs")
    expect(found).toContain("relative-extension:./context.js")
    expect(found).toContain("import-equals")
    expect(found.some((item) => item.startsWith("class-declaration"))).toBe(true)
    expect(found.some((item) => item.startsWith("class-expression"))).toBe(true)
    expect(found.filter((item) => item.startsWith("jsdoc:function-like"))).toHaveLength(4)
    expect(found).toContain("explicit-any")
    expect(found).toContain("spread-element")
    expect(found).toContain("spread-assignment")
    expect(found).toContain("rest-element")
    expect(found).toContain("type-assertion:as")
    expect(found).toContain("type-assertion:angle")
    expect(found).toContain("type-assertion:non-null")
    expect(found).toContain("type-assertion:definite-assignment")
    expect(found).toContain("suppression:@ts-ignore")
    expect(found).toContain("global:Bun")
    expect(found).toContain("global:Reflect")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("production source recursively satisfies the complete fail-closed policy", async () => {
  const packageRoot = `${import.meta.dir}/..`
  const sourceRoot = `${packageRoot}/src`
  const files: string[] = []
  const found: string[] = []
  for await (const file of new Bun.Glob("**/*.ts").scan({ cwd: sourceRoot, onlyFiles: true })) {
    files.push(file)
  }
  files.sort()
  await withProject(packageRoot, `${packageRoot}/tsconfig.json`, async function inspect(project) {
    for (const file of files) {
      const sourceFile = await project.program.getSourceFile(`${sourceRoot}/${file}`)
      if (sourceFile === undefined) throw new Error(`production source file is missing: ${file}`)
      for (const violation of sourceViolations(sourceFile)) found.push(`${file}:${violation}`)
    }
  })
  expect(files).toEqual(["index.ts"])
  expect(found).toEqual([])
})

test("source and tests contain no handwritten JavaScript or relative extension imports", async () => {
  const packageRoot = `${import.meta.dir}/..`
  const found: string[] = []
  for (const tree of ["src", "test"]) {
    for await (const file of new Bun.Glob("**/*").scan({
      cwd: `${packageRoot}/${tree}`,
      onlyFiles: true
    })) {
      const relative = `${tree}/${file}`
      if (file.endsWith(".js") || file.endsWith(".mjs")) {
        found.push(`handwritten-javascript:${relative}`)
      }
      if (!file.endsWith(".ts")) continue
      const text = await readFile(`${packageRoot}/${relative}`, "utf8")
      for (const line of text.split("\n")) {
        const trimmed = line.trimStart()
        if (trimmed.startsWith('"') || trimmed.startsWith("'") || trimmed.startsWith("`")) continue
        const matches = line.matchAll(/(?:from\s+|import\s*\()(["'])(\.\.?\/[^"']+)\1/g)
        for (const match of matches) {
          const specifier = match[2]
          if (specifier !== undefined && extname(specifier) !== "") {
            found.push(`relative-extension:${relative}:${specifier}`)
          }
        }
      }
    }
  }
  expect(found).toEqual([])
})
