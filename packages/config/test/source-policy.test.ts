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
const NodeHostModules = new Set(["node:crypto", "node:fs", "node:fs/promises", "node:path"])

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

/** Returns the text label used to make a policy violation actionable. */
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

/** Allows only the reviewed Go-style public option ABI to use a typed rest parameter. */
function isReviewedTypedRest(node: Node, sourceFile: SourceFile): boolean {
  return hasRestToken(node) && node.getFullText(sourceFile).includes("likego-typed-rest")
}

/** Returns a forbidden module reason or null for one exact portable import boundary. */
function moduleViolation(node: Node, sourceFile: SourceFile, specifier: string): string | null {
  if (specifier.startsWith(".")) {
    return extname(specifier) === "" ? null : `relative-extension:${specifier}`
  }
  if (specifier === "@likego/context" || specifier === "@likego/core/lifecycle") return null
  if (sourceFile.fileName.endsWith("/src/node-host.ts") && NodeHostModules.has(specifier))
    return null
  if (specifier === "js-yaml/browser") return null
  if (specifier === "@likego/core" || specifier === "@standard-schema/spec") {
    if (isImportDeclaration(node) && node.getText(sourceFile).startsWith("import type "))
      return null
    return `runtime-module:${specifier}`
  }
  return `module:${specifier}`
}

/** Finds every class, portability, documentation, assertion, and suppression violation in one source. */
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
    else if (node.kind === SyntaxKind.SpreadElement) violations.push("spread-element")
    else if (node.kind === SyntaxKind.SpreadAssignment) violations.push("spread-assignment")
    else if (hasRestToken(node) && !isReviewedTypedRest(node, sourceFile))
      violations.push("rest-element")

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
    if (isIdentifier(node) && ForbiddenGlobals.has(node.text))
      violations.push(`global:${node.text}`)
    if (isImportDeclaration(node) || isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier
      if (specifier !== undefined && isStringLiteral(specifier)) {
        const violation = moduleViolation(node, sourceFile, specifier.text)
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

test("AST and scanner policy fail closed on every forbidden form and missing documentation", async () => {
  const root = await mkdtemp(join(tmpdir(), "likego-config-source-policy-"))
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
        'import { newApp } from "@likego/core"',
        'import legacy = require("node:path")',
        "class Named {}",
        "const Anonymous = class {}",
        "function undocumented(): void {}",
        "const arrow = () => 1",
        "const expression = function () {}",
        "const object = { method(): void {} }",
        "const value = input as string",
        "const angle = <string>input",
        "const nonNull = input!",
        "let assigned!: string",
        "const broad: any = input",
        "const spreadArray = [...items]",
        "const spreadObject = { ...object }",
        "/** Documents the synthetic forbidden rest form. */",
        "function variadic(...items: string[]): void { void items }",
        "// @ts-ignore",
        "// @ts-expect-error fixture",
        "// @ts-nocheck",
        'const harmless = "@ts-ignore"',
        "void [Anonymous, arrow, expression, object, value, angle, nonNull, assigned, broad, spreadArray, spreadObject, variadic, harmless, Bun, Reflect]"
      ].join("\n")
    )

    const violations = await withProject(root, configPath, async function inspect(project) {
      const sourceFile = await project.program.getSourceFile(sourcePath)
      if (sourceFile === undefined) throw new Error("synthetic source file is missing")
      return sourceViolations(sourceFile)
    })
    expect(violations).toContain("module:node:fs")
    expect(violations).toContain("relative-extension:./context.js")
    expect(violations).toContain("runtime-module:@likego/core")
    expect(violations).toContain("import-equals")
    expect(violations.some((item) => item.startsWith("class-declaration"))).toBe(true)
    expect(violations.some((item) => item.startsWith("class-expression"))).toBe(true)
    expect(violations.filter((item) => item.startsWith("jsdoc:function-like"))).toHaveLength(4)
    expect(violations).toContain("type-assertion:as")
    expect(violations).toContain("type-assertion:angle")
    expect(violations).toContain("type-assertion:non-null")
    expect(violations).toContain("type-assertion:definite-assignment")
    expect(violations).toContain("explicit-any")
    expect(violations).toContain("spread-element")
    expect(violations).toContain("spread-assignment")
    expect(violations).toContain("rest-element")
    expect(violations).toContain("suppression:@ts-ignore")
    expect(violations).toContain("suppression:@ts-expect-error")
    expect(violations).toContain("suppression:@ts-nocheck")
    expect(violations).toContain("global:Bun")
    expect(violations).toContain("global:Reflect")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("production source recursively satisfies the complete fail-closed policy", async () => {
  const packageRoot = `${import.meta.dir}/..`
  const sourceRoot = `${packageRoot}/src`
  const files: string[] = []
  const violations: string[] = []
  for await (const file of new Bun.Glob("**/*.ts").scan({ cwd: sourceRoot, onlyFiles: true }))
    files.push(file)
  files.sort()
  await withProject(packageRoot, `${packageRoot}/tsconfig.json`, async function inspect(project) {
    for (const file of files) {
      const sourceFile = await project.program.getSourceFile(`${sourceRoot}/${file}`)
      if (sourceFile === undefined) throw new Error(`production source file is missing: ${file}`)
      for (const violation of sourceViolations(sourceFile)) violations.push(`${file}:${violation}`)
    }
  })
  expect(files).toEqual([
    "config.ts",
    "env.ts",
    "errors.ts",
    "file.ts",
    "index.ts",
    "merge.ts",
    "node-host.ts",
    "node.ts",
    "source.ts",
    "validation.ts",
    "value.ts",
    "yaml.ts"
  ])
  expect(violations).toEqual([])
})

test("development source and test trees contain no handwritten JavaScript or relative extension specifiers", async () => {
  const packageRoot = `${import.meta.dir}/..`
  const files: string[] = []
  const violations: string[] = []
  for (const tree of ["src", "test"]) {
    for await (const file of new Bun.Glob("**/*").scan({
      cwd: `${packageRoot}/${tree}`,
      onlyFiles: true
    })) {
      const relative = `${tree}/${file}`
      files.push(relative)
      if (file.endsWith(".js") || file.endsWith(".mjs"))
        violations.push(`handwritten-javascript:${relative}`)
      if (!file.endsWith(".ts")) continue
      const text = await readFile(`${packageRoot}/${relative}`, "utf8")
      for (const line of text.split("\n")) {
        const trimmed = line.trimStart()
        if (trimmed.startsWith('"') || trimmed.startsWith("'") || trimmed.startsWith("`")) continue
        const matches = line.matchAll(/(?:from\s+|import\s*\()(["'])(\.\.?\/[^"']+)\1/g)
        for (const match of matches) {
          const specifier = match[2]
          if (specifier !== undefined && extname(specifier) !== "") {
            violations.push(`relative-extension:${relative}:${specifier}`)
          }
        }
      }
    }
  }
  expect(files.length).toBeGreaterThan(0)
  expect(violations).toEqual([])
})
