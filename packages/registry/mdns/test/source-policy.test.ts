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
  isFunctionDeclaration,
  isIdentifier,
  isInterfaceDeclaration,
  isImportDeclaration,
  isImportEqualsDeclaration,
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

const PortableModules = new Set([
  "@likego/context",
  "@likego/core/lifecycle",
  "@likego/registry",
  "@likego/registry/provider"
])
const NodeModules = new Set([
  "@likego/context",
  "@likego/core/lifecycle",
  "@likego/registry",
  "@likego/registry/provider",
  "node:dgram",
  "node:os"
])
const NodeSources = new Set(["node-host.ts", "node.ts"])
const AllowedDevelopmentArtifacts = new Set([
  "test/e2e/compose.ipv4.yaml",
  "test/e2e/compose.ipv6.yaml"
])
const AllowedProductionGlobals = Object.freeze([
  "AggregateError",
  "Array",
  "CompressionStream",
  "DecompressionStream",
  "Error",
  "JSON",
  "Map",
  "Math",
  "Number",
  "Object",
  "Promise",
  "RangeError",
  "Set",
  "String",
  "TextDecoder",
  "TextEncoder",
  "TypeError",
  "URL",
  "Uint8Array",
  "clearInterval",
  "crypto",
  "performance",
  "setInterval",
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

/** Reports whether a declaration owns a rest token. */
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
    node.jsDoc?.some(function nonEmpty(doc): boolean {
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
  const found: string[] = []
  while (scanner.scan() !== SyntaxKind.EndOfFile) {
    const token = scanner.getToken()
    if (token !== SyntaxKind.SingleLineCommentTrivia && token !== SyntaxKind.MultiLineCommentTrivia)
      continue
    if (/@ts-(?:ignore|expect-error|nocheck)\b/.test(scanner.getTokenText()))
      found.push("ts-suppression")
  }
  return found
}

/** Finds forbidden syntax, missing documentation, and runtime-specific dependencies. */
function violations(
  sourceFile: SourceFile,
  allowedModules = PortableModules,
  forbidNodeModules = true
): string[] {
  const found = suppressionViolations(sourceFile)
  const functionNames: string[] = []
  /** Recursively inspects one compiler node. */
  function visit(node: Node): void {
    if (isClassDeclaration(node) || isClassExpression(node)) found.push("class")
    if (isAsExpression(node) || isTypeAssertion(node) || isNonNullExpression(node))
      found.push("assertion")
    if (
      (isVariableDeclaration(node) || isPropertyDeclaration(node)) &&
      node.getText(sourceFile).includes("!:")
    ) {
      found.push("definite-assignment")
    }
    if (node.kind === SyntaxKind.AnyKeyword) found.push("explicit-any")
    if (isImportEqualsDeclaration(node)) found.push("import-equals")
    if (node.kind === SyntaxKind.SpreadAssignment) found.push("spread-assignment")
    if (node.kind === SyntaxKind.SpreadElement && !allowedSpread(node, sourceFile)) {
      found.push("spread-element")
    }
    if (!allowedRestToken(node, sourceFile)) found.push("rest-element")
    if (
      isCallExpression(node) &&
      isIdentifier(node.expression) &&
      functionNames[functionNames.length - 1] === node.expression.text
    )
      found.push(`direct-recursion:${node.expression.text}`)
    if (FunctionKinds.has(node.kind) && !hasJSDoc(node)) {
      found.push(`jsdoc:${node.kind}:${node.getText(sourceFile).split("\n", 1)[0]}`)
    }
    if (CallableKinds.has(node.kind) && !hasJSDoc(node)) {
      found.push(`jsdoc:${node.kind}:${node.getText(sourceFile).split("\n", 1)[0]}`)
    }
    if (
      node.kind === SyntaxKind.FunctionType &&
      (node.parent.kind === SyntaxKind.TypeAliasDeclaration ||
        node.parent.kind === SyntaxKind.PropertySignature) &&
      !hasJSDoc(node.parent)
    )
      found.push("jsdoc:function-type")
    if (isImportDeclaration(node) || isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier
      if (specifier !== undefined && isStringLiteral(specifier)) {
        if (specifier.text.startsWith(".")) {
          if (extname(specifier.text) !== "") found.push(`relative-extension:${specifier.text}`)
        } else if (!allowedModules.has(specifier.text)) found.push(`module:${specifier.text}`)
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
  const forbiddenPatterns = [
    /\bBun\b/g,
    /\bDeno\b/g,
    /\bglobalThis\b/g,
    /\b(?:document|window|navigator|localStorage)\b/g,
    /(?:multicast-dns|dns-packet)/g,
    /@ts-(?:ignore|expect-error|nocheck)\b/g
  ]
  if (forbidNodeModules) forbiddenPatterns.push(/(?:from\s+|import\s*\()["']node:/g)
  for (const forbidden of forbiddenPatterns) {
    if (forbidden.test(sourceFile.text)) found.push(`text:${forbidden.source}`)
  }
  return found
}

/** Opens exactly one compiler project and always disposes its session. */
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
    if (project === undefined) throw new Error("mDNS source policy project is missing")
    return await use(project)
  } finally {
    if (snapshot !== null) await snapshot.dispose()
    await api.close()
  }
}

test("portable and Node production graphs preserve their exact runtime boundaries", async () => {
  const packageRoot = `${import.meta.dir}/..`
  const root = `${packageRoot}/src`
  const portable = await withProject(
    packageRoot,
    `${packageRoot}/tsconfig.portable.json`,
    async function inspect(project) {
      const output: string[] = []
      const sources: SourceFile[] = []
      for await (const file of new Bun.Glob("**/*.ts").scan({ cwd: root, onlyFiles: true })) {
        if (NodeSources.has(file)) continue
        const source = await project.program.getSourceFile(`${root}/${file}`)
        if (source === undefined) throw new Error(`mDNS portable source is missing: ${file}`)
        sources.push(source)
        for (const violation of violations(source)) output.push(`${file}:${violation}`)
      }
      const globalIssues = await checkSemanticGlobals(project, sources, {
        AllowedFreeGlobals: AllowedProductionGlobals
      })
      for (const issue of globalIssues) output.push(`${issue.Path}:${issue.Code}:${issue.Message}`)
      return output
    }
  )
  const node = await withProject(
    packageRoot,
    `${packageRoot}/tsconfig.json`,
    async function inspect(project) {
      const output: string[] = []
      const sources: SourceFile[] = []
      for (const file of NodeSources) {
        const source = await project.program.getSourceFile(`${root}/${file}`)
        if (source === undefined) throw new Error(`mDNS Node source is missing: ${file}`)
        sources.push(source)
        for (const violation of violations(source, NodeModules, false))
          output.push(`${file}:${violation}`)
      }
      const globalIssues = await checkSemanticGlobals(project, sources, {
        AllowedFreeGlobals: AllowedProductionGlobals
      })
      for (const issue of globalIssues) output.push(`${issue.Path}:${issue.Code}:${issue.Message}`)
      return output
    }
  )
  expect([...portable, ...node]).toEqual([])
}, 30_000)

test("policy detects dynamic code, runtime globals, classes, assertions, spread, and missing docs", async () => {
  const root = await mkdtemp(join(tmpdir(), "likego-registry-mdns-policy-"))
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
        'import { readFile } from "node:fs"',
        'export const evaluated = eval("1")',
        'export const constructed = new Function("return 1")',
        "export const root = globalThis",
        "export const dom = document",
        "function undocumented(): any { return value as any }",
        "class Stateful {}",
        "const spread = [...items]",
        "// @ts-ignore",
        "void [readFile, evaluated, constructed, root, dom, undocumented, Stateful, spread]"
      ].join("\n")
    )
    const found = await withProject(
      root,
      join(root, "tsconfig.json"),
      async function inspect(project) {
        const source = await project.program.getSourceFile(join(root, "src", "synthetic.ts"))
        if (source === undefined) throw new Error("mDNS policy fixture source is missing")
        const output = violations(source)
        const globalIssues = await checkSemanticGlobals(project, [source], {
          AllowedFreeGlobals: []
        })
        for (const issue of globalIssues) output.push(issue.Code)
        return output
      }
    )
    expect(found).toContain("class")
    expect(found).toContain("assertion")
    expect(found).toContain("explicit-any")
    expect(found).toContain("spread-element")
    expect(found).toContain("ts-suppression")
    expect(
      found.some(function missingDocs(item): boolean {
        return item.startsWith("jsdoc:")
      })
    ).toBe(true)
    expect(found).toContain("GLOBAL_DYNAMIC_CODE_FORBIDDEN")
    expect(found).toContain("GLOBAL_THIS_ESCAPE_FORBIDDEN")
    expect(found).toContain("GLOBAL_FREE_IDENTIFIER_FORBIDDEN")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("types source contains only type-owned declarations", async () => {
  const packageRoot = `${import.meta.dir}/..`
  const found = await withProject(
    packageRoot,
    `${packageRoot}/tsconfig.json`,
    async function inspect(project) {
      const source = await project.program.getSourceFile(`${packageRoot}/src/types.ts`)
      if (source === undefined) throw new Error("mDNS types source is missing")
      return source.statements
        .filter(function runtimeStatement(statement) {
          return !(
            (isImportDeclaration(statement) &&
              statement.importClause?.phaseModifier === SyntaxKind.TypeKeyword) ||
            isInterfaceDeclaration(statement) ||
            isTypeAliasDeclaration(statement)
          )
        })
        .map(function label(statement) {
          return statement.getText(source).split("\n", 1)[0]
        })
    }
  )
  expect(found).toEqual([])
})

test("development trees contain only TypeScript and extensionless relative specifiers", async () => {
  const packageRoot = `${import.meta.dir}/..`
  const found: string[] = []
  for (const tree of ["src", "test"]) {
    for await (const file of new Bun.Glob("**/*").scan({
      cwd: `${packageRoot}/${tree}`,
      onlyFiles: true
    })) {
      const path = `${tree}/${file}`
      if (!file.endsWith(".ts") && !AllowedDevelopmentArtifacts.has(path)) {
        found.push(`handwritten-non-typescript:${path}`)
      }
      if (!file.endsWith(".ts")) continue
      const text = await Bun.file(`${packageRoot}/${tree}/${file}`).text()
      for (const match of text.matchAll(/(?:from\s+|import\s*\()(["'])(\.\.?\/[^"']+)\1/g)) {
        const specifier = match[2]
        if (specifier !== undefined && extname(specifier) !== "") {
          found.push(`relative-extension:${tree}/${file}:${specifier}`)
        }
      }
    }
  }
  expect(found).toEqual([])
})
