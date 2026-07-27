import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { extname, join } from "node:path"

import { expect, test } from "bun:test"
import { API, type Project, type Snapshot } from "typescript/unstable/async"
import {
  SyntaxKind,
  createScanner,
  isAsExpression,
  isCallExpression,
  isClassDeclaration,
  isClassExpression,
  isExportDeclaration,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isFunctionDeclaration,
  isIdentifier,
  isInterfaceDeclaration,
  isNonNullExpression,
  isPropertyDeclaration,
  isStringLiteral,
  isTypeAliasDeclaration,
  isTypeAssertion,
  isVariableDeclaration,
  type Node,
  type SourceFile
} from "typescript/unstable/ast"
import { checkSemanticGlobals } from "../../../../tools/boundaries/semantic-global"

const AllowedModules = new Set([
  "@likego/context",
  "@likego/core/lifecycle",
  "@likego/registry",
  "@likego/registry/provider"
])
const AllowedProductionGlobals = Object.freeze([
  "AbortController",
  "AbortSignal",
  "AggregateError",
  "Array",
  "BigInt",
  "CompressionStream",
  "Date",
  "DecompressionStream",
  "Error",
  "Headers",
  "JSON",
  "Math",
  "Map",
  "Number",
  "Object",
  "Promise",
  "Request",
  "Response",
  "RangeError",
  "Set",
  "String",
  "TextDecoder",
  "TextEncoder",
  "TypeError",
  "Uint8Array",
  "URL",
  "clearTimeout",
  "crypto",
  "encodeURIComponent",
  "performance",
  "setTimeout",
  "undefined"
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

/** Reports whether a declaration owns a forbidden rest token. */
function hasRestToken(node: Node): boolean {
  if (node.kind !== SyntaxKind.Parameter && node.kind !== SyntaxKind.BindingElement) return false
  return "dotDotDotToken" in node && node.dotDotDotToken !== undefined
}

/** Reports whether a Go-style rest parameter carries explicit forwarding evidence. */
function allowedRestToken(node: Node, sourceFile: SourceFile): boolean {
  if (!hasRestToken(node)) return true
  if (CallableKinds.has(node.parent.kind)) return true
  return node.parent.getFullText(sourceFile).includes("likego-typed-rest")
}

/** Reports whether a typed spread carries explicit forwarding evidence. */
function allowedSpread(node: Node, sourceFile: SourceFile): boolean {
  return node.parent.getFullText(sourceFile).includes("likego-typed-spread")
}

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

/** Finds every prohibited production syntax, module, and missing callable JSDoc. */
function sourceViolations(sourceFile: SourceFile): string[] {
  const violations = suppressionViolations(sourceFile)
  const functionNames: string[] = []
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
    if (node.kind === SyntaxKind.SpreadElement && !allowedSpread(node, sourceFile))
      violations.push("spread-element")
    if (node.kind === SyntaxKind.SpreadAssignment) violations.push("spread-assignment")
    if (!allowedRestToken(node, sourceFile)) violations.push("rest-element")
    if (
      isCallExpression(node) &&
      isIdentifier(node.expression) &&
      functionNames[functionNames.length - 1] === node.expression.text
    )
      violations.push(`direct-recursion:${node.expression.text}`)
    if (FunctionKinds.has(node.kind) && !hasJSDoc(node))
      violations.push(`jsdoc:${node.kind}:${node.getText(sourceFile).split("\n", 1)[0]}`)
    if (CallableKinds.has(node.kind) && !hasJSDoc(node))
      violations.push(`jsdoc:${node.kind}:${node.getText(sourceFile).split("\n", 1)[0]}`)
    if (
      node.kind === SyntaxKind.FunctionType &&
      (node.parent.kind === SyntaxKind.TypeAliasDeclaration ||
        node.parent.kind === SyntaxKind.PropertySignature) &&
      !hasJSDoc(node.parent)
    )
      violations.push("jsdoc:function-type")
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
    if (isFunctionDeclaration(node) && node.name !== undefined) {
      functionNames.push(node.name.text)
      node.forEachChild(visit)
      functionNames.pop()
      return
    }
    node.forEachChild(visit)
  }
  sourceFile.forEachChild(visit)
  return violations
}

/** Finds type-erasing shortcuts forbidden in published-runtime authority tests. */
function publishedTestTypeViolations(sourceFile: SourceFile): string[] {
  const violations: string[] = []
  /** Recursively checks one published-runtime test node. */
  function visit(node: Node): void {
    if (node.kind === SyntaxKind.AnyKeyword) violations.push("explicit-any")
    if (isAsExpression(node) || isTypeAssertion(node) || isNonNullExpression(node))
      violations.push("assertion")
    node.forEachChild(visit)
  }
  sourceFile.forEachChild(visit)
  return violations
}

/** Opens exactly one compiler project and always disposes its session. */
async function withProject<T>(
  root: string,
  use: (project: Project) => Promise<T>,
  config = "tsconfig.json"
): Promise<T> {
  const api = new API({ cwd: root })
  let snapshot: Snapshot | null = null
  try {
    snapshot = await api.updateSnapshot({ openProjects: [`${root}/${config}`] })
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
  const violations = await withProject(packageRoot, async function inspect(project) {
    const results: string[] = []
    const sourceFiles: SourceFile[] = []
    for await (const file of new Bun.Glob("src/**/*.ts").scan({
      cwd: packageRoot,
      onlyFiles: true
    })) {
      const sourceFile = await project.program.getSourceFile(`${packageRoot}/${file}`)
      if (sourceFile === undefined) throw new Error(`production source missing: ${file}`)
      sourceFiles.push(sourceFile)
      for (const violation of sourceViolations(sourceFile)) results.push(`${file}:${violation}`)
    }
    const globalIssues = await checkSemanticGlobals(project, sourceFiles, {
      AllowedFreeGlobals: AllowedProductionGlobals
    })
    for (const issue of globalIssues) results.push(`${issue.Path}:${issue.Code}:${issue.Message}`)
    return results
  })
  expect(violations).toEqual([])
})

test("semantic global authority rejects dynamic code, globalThis escape, and DOM-only globals", async () => {
  const root = await mkdtemp(join(tmpdir(), "likego-registry-consul-semantic-global-"))
  try {
    await mkdir(join(root, "src"), { recursive: true })
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          lib: ["ES2023", "DOM"],
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
          target: "ES2023"
        },
        include: ["src/**/*.ts"]
      })
    )
    await writeFile(
      join(root, "src", "synthetic.ts"),
      [
        'export const evaluated = eval("1")',
        'export const constructed = new Function("return 1")',
        "export const root = globalThis",
        "export const dom = [document, window, navigator, localStorage]"
      ].join("\n")
    )
    const issues = await withProject(root, async function inspect(project) {
      const sourceFile = await project.program.getSourceFile(join(root, "src", "synthetic.ts"))
      if (sourceFile === undefined) throw new Error("semantic global fixture source is missing")
      return checkSemanticGlobals(project, [sourceFile], { AllowedFreeGlobals: [] })
    })
    expect(
      issues.map(function code(issue) {
        return issue.Code
      })
    ).toEqual([
      "GLOBAL_DYNAMIC_CODE_FORBIDDEN",
      "GLOBAL_DYNAMIC_CODE_FORBIDDEN",
      "GLOBAL_FREE_IDENTIFIER_FORBIDDEN",
      "GLOBAL_FREE_IDENTIFIER_FORBIDDEN",
      "GLOBAL_FREE_IDENTIFIER_FORBIDDEN",
      "GLOBAL_FREE_IDENTIFIER_FORBIDDEN",
      "GLOBAL_THIS_ESCAPE_FORBIDDEN"
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("types source remains pure type-only input owned by the published typecheck gate", async () => {
  const packageRoot = `${import.meta.dir}/..`
  const violations = await withProject(packageRoot, async function inspect(project) {
    const sourceFile = await project.program.getSourceFile(`${packageRoot}/src/types.ts`)
    if (sourceFile === undefined) throw new Error("types source is missing")
    return sourceFile.statements
      .filter(function runtimeStatement(statement) {
        return !(
          (isImportDeclaration(statement) &&
            statement.importClause?.phaseModifier === SyntaxKind.TypeKeyword) ||
          isInterfaceDeclaration(statement) ||
          isTypeAliasDeclaration(statement)
        )
      })
      .map(function label(statement) {
        return statement.getText(sourceFile).split("\n", 1)[0]
      })
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
      if (!file.endsWith(".ts") && !file.endsWith(".md") && !file.endsWith(".hcl"))
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

test("published-runtime authority tests preserve unknown narrowing without any or assertions", async () => {
  const packageRoot = `${import.meta.dir}/..`
  const files = ["test/integration/published-behavior.ts", "test/integration/published-runtime.ts"]
  const violations = await withProject(
    packageRoot,
    async function inspect(project) {
      const results: string[] = []
      for (const file of files) {
        const sourceFile = await project.program.getSourceFile(`${packageRoot}/${file}`)
        if (sourceFile === undefined) throw new Error(`published-runtime source missing: ${file}`)
        for (const violation of publishedTestTypeViolations(sourceFile))
          results.push(`${file}:${violation}`)
      }
      return results
    },
    "tsconfig.test.json"
  )
  expect(violations).toEqual([])
})
