import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, posix, resolve } from "node:path"

import { defineConfig, type UserConfig } from "tsdown"
import { createScanner, SyntaxKind } from "typescript/ast"

type JsonObject = Record<string, unknown>

const dependencyFields = ["dependencies", "optionalDependencies", "peerDependencies"] as const
const publicExportKey = /^(?:\.|\.\/[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*)$/u
const repositoryUrl = "git+https://github.com/MunMunMiao/go-like.git"

function object(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return Object.fromEntries(Object.entries(value))
}

function sourceEntry(value: unknown): { readonly output: string; readonly source: string } {
  if (typeof value !== "string" || !value.startsWith("./src/") || !value.endsWith(".ts")) {
    throw new TypeError(`package export must target ./src/*.ts: ${String(value)}`)
  }
  const output = value.slice("./src/".length, -".ts".length)
  if (output.length === 0 || posix.normalize(output) !== output || output.startsWith("../")) {
    throw new TypeError(`package export must stay inside src: ${value}`)
  }
  return Object.freeze({ output, source: value.slice(2) })
}

function publicExportNames(exports: JsonObject): readonly string[] {
  const names: string[] = []
  for (const name of Object.keys(exports)) {
    if (name === "./package.json") continue
    if (!publicExportKey.test(name)) {
      throw new TypeError(`package export key is invalid: ${name}`)
    }
    names.push(name)
  }
  if (names.length === 0) {
    throw new TypeError("package exports must declare a public entry")
  }
  return names
}

/** Returns the tsdown entry for every public source export. The `.` export is optional. */
export function packageEntries(value: unknown): Readonly<Record<string, string>> {
  const exports = object(object(value, "package manifest").exports, "package exports")
  const names = publicExportNames(exports)
  if (names.includes(".") && sourceEntry(exports["."]).output !== "index") {
    throw new TypeError("package root export must target ./src/index.ts")
  }
  const entries: Record<string, string> = {}
  for (const name of names) {
    const entry = sourceEntry(exports[name])
    if (entries[entry.output] !== undefined) {
      throw new TypeError(`duplicate package output: ${entry.output}`)
    }
    entries[entry.output] = entry.source
  }
  return Object.freeze(entries)
}

async function workspaceVersion(cwd: string, name: string): Promise<string> {
  const manifestPath = Bun.resolveSync(`${name}/package.json`, cwd)
  const manifest = object(await Bun.file(manifestPath).json(), `${name} package manifest`)
  if (typeof manifest.version !== "string") {
    throw new TypeError(`${name} package version must be a string`)
  }
  return manifest.version
}

async function rewriteWorkspaceDependencies(manifest: JsonObject, cwd: string): Promise<void> {
  for (const field of dependencyFields) {
    if (manifest[field] === undefined) continue
    const dependencies = object(manifest[field], field)
    for (const [name, range] of Object.entries(dependencies)) {
      if (typeof range === "string" && range.startsWith("workspace:")) {
        dependencies[name] = await workspaceVersion(cwd, name)
      }
    }
    manifest[field] = dependencies
  }
}

function distExport(output: string): JsonObject {
  return {
    types: `./${output}.d.ts`,
    import: `./${output}.js`,
    default: `./${output}.js`
  }
}

/** Produces the package manifest written directly into dist. */
export async function distPackageManifest(value: unknown, cwd: string): Promise<JsonObject> {
  const source = object(value, "package manifest")
  const manifest = structuredClone(source)
  const sourceExports = object(source.exports, "package exports")
  const names = publicExportNames(sourceExports)
  const exports: JsonObject = {}
  for (const name of names) {
    exports[name] = distExport(sourceEntry(sourceExports[name]).output)
  }
  exports["./package.json"] = "./package.json"

  if (names.includes(".")) {
    const root = sourceEntry(sourceExports["."])
    if (root.output !== "index") {
      throw new TypeError("package root export must target ./src/index.ts")
    }
    manifest.main = `./${root.output}.js`
    manifest.module = `./${root.output}.js`
    manifest.types = `./${root.output}.d.ts`
    manifest.typings = `./${root.output}.d.ts`
  } else {
    delete manifest.main
    delete manifest.module
    delete manifest.types
    delete manifest.typings
  }
  manifest.exports = exports
  manifest.repository ??= { type: "git", url: repositoryUrl }
  manifest.homepage ??= "https://github.com/MunMunMiao/go-like#readme"
  manifest.bugs ??= { url: "https://github.com/MunMunMiao/go-like/issues" }
  manifest.keywords ??= ["go-like", "microservices", "typescript"]
  delete manifest.scripts
  delete manifest.devDependencies
  delete manifest.private
  delete manifest.files
  if (manifest.publishConfig !== undefined) {
    const publishConfig = object(manifest.publishConfig, "publishConfig")
    manifest.publishConfig = { access: publishConfig.access }
  }
  await rewriteWorkspaceDependencies(manifest, cwd)
  return manifest
}

/**
 * Modules whose side-effect import pulls Node types into a declaration consumer.
 * `@connectrpc/connect-node` is the Node adapter; `node:` modules resolve through `@types/node`.
 */
const nodeSideEffectPackages = new Set(["@connectrpc/connect-node"])
const nodeGlobalTypes = new Set(["Buffer", "BufferEncoding", "NodeJS"])
const nodeTypesReference = /\/\/\/\s*<reference\s+types\s*=\s*["']node["']\s*\/>/u
const declarationKeywords = new Set<SyntaxKind>([
  SyntaxKind.InterfaceKeyword,
  SyntaxKind.ClassKeyword,
  SyntaxKind.EnumKeyword,
  SyntaxKind.FunctionKeyword,
  SyntaxKind.NamespaceKeyword,
  SyntaxKind.ConstKeyword,
  SyntaxKind.LetKeyword,
  SyntaxKind.VarKeyword
])

interface ScannedToken {
  readonly kind: SyntaxKind
  readonly start: number
  readonly end: number
  readonly text: string
  /** True when the token can be a binding name, including contextual keywords such as `source`. */
  readonly identifier: boolean
}

interface ImportStatement {
  readonly start: number
  readonly end: number
  readonly specifier: string
  readonly bindings: readonly string[]
  readonly sideEffect: boolean
}

interface SpecifierUse {
  readonly specifier: string
  readonly start: number
}

function tokenAt(tokens: readonly ScannedToken[], index: number): ScannedToken | undefined {
  if (index < 0 || index >= tokens.length) return undefined
  return tokens[index]
}

function isName(token: ScannedToken | undefined): token is ScannedToken {
  return token?.identifier === true
}

function scanTokens(text: string): ScannedToken[] {
  const scanner = createScanner(true)
  scanner.setText(text)
  const tokens: ScannedToken[] = []
  while (true) {
    const kind = scanner.scan()
    if (kind === SyntaxKind.EndOfFile) break
    tokens.push({
      kind,
      start: scanner.getTokenStart(),
      end: scanner.getTokenEnd(),
      text: kind === SyntaxKind.StringLiteral ? scanner.getTokenValue() : scanner.getTokenText(),
      identifier: scanner.isIdentifier()
    })
  }
  return tokens
}

function failImport(fileName: string, text: string, start: number): never {
  const newline = text.indexOf("\n", start)
  const line = text.slice(start, newline === -1 ? text.length : newline)
  throw new Error(`${fileName} has an import declaration that could not be checked: ${line}`)
}

function readNamedImports(
  tokens: readonly ScannedToken[],
  openBrace: number,
  fileName: string,
  text: string
): { readonly names: string[]; readonly next: number } {
  let cursor = openBrace + 1
  const names: string[] = []
  if (tokenAt(tokens, cursor)?.kind === SyntaxKind.CloseBraceToken)
    return { names, next: cursor + 1 }
  const start = tokenAt(tokens, openBrace)?.start ?? 0
  while (cursor < tokens.length) {
    if (tokenAt(tokens, cursor)?.kind === SyntaxKind.TypeKeyword) cursor += 1
    const name = tokenAt(tokens, cursor)
    if (!isName(name)) failImport(fileName, text, start)
    let local = name.text
    cursor += 1
    if (tokenAt(tokens, cursor)?.kind === SyntaxKind.AsKeyword) {
      cursor += 1
      const alias = tokenAt(tokens, cursor)
      if (!isName(alias)) failImport(fileName, text, start)
      local = alias.text
      cursor += 1
    }
    names.push(local)
    if (tokenAt(tokens, cursor)?.kind === SyntaxKind.CommaToken) {
      cursor += 1
      if (tokenAt(tokens, cursor)?.kind === SyntaxKind.CloseBraceToken)
        return { names, next: cursor + 1 }
      continue
    }
    if (tokenAt(tokens, cursor)?.kind === SyntaxKind.CloseBraceToken)
      return { names, next: cursor + 1 }
    failImport(fileName, text, start)
  }
  failImport(fileName, text, start)
}

function finishImport(
  tokens: readonly ScannedToken[],
  specifierIndex: number,
  fileName: string
): { readonly end: number; readonly next: number } {
  const specifier = tokenAt(tokens, specifierIndex)
  if (specifier === undefined)
    throw new Error(`${fileName} has an import declaration that could not be checked`)
  let cursor = specifierIndex + 1
  const clause = tokenAt(tokens, cursor)
  if (clause?.kind === SyntaxKind.WithKeyword || clause?.kind === SyntaxKind.AssertKeyword) {
    cursor += 1
    if (tokenAt(tokens, cursor)?.kind !== SyntaxKind.OpenBraceToken) {
      throw new Error(`${fileName} has an import attribute that could not be checked`)
    }
    let depth = 0
    while (cursor < tokens.length) {
      const kind = tokenAt(tokens, cursor)?.kind
      if (kind === SyntaxKind.OpenBraceToken) depth += 1
      else if (kind === SyntaxKind.CloseBraceToken) {
        depth -= 1
        cursor += 1
        if (depth === 0) break
      } else cursor += 1
    }
    if (depth !== 0)
      throw new Error(`${fileName} has an import attribute that could not be checked`)
  }
  const semicolon = tokenAt(tokens, cursor)
  if (semicolon?.kind === SyntaxKind.SemicolonToken) return { end: semicolon.end, next: cursor + 1 }
  return { end: specifier.end, next: specifierIndex + 1 }
}

function parseImport(
  tokens: readonly ScannedToken[],
  index: number,
  fileName: string,
  text: string
): { readonly statement: ImportStatement; readonly nextIndex: number } {
  const keyword = tokenAt(tokens, index)
  if (keyword === undefined)
    throw new Error(`${fileName} has an import declaration that could not be checked`)
  let cursor = index + 1
  const first = tokenAt(tokens, cursor)
  if (first === undefined) failImport(fileName, text, keyword.start)
  if (first.kind === SyntaxKind.StringLiteral) {
    const finished = finishImport(tokens, cursor, fileName)
    return {
      statement: {
        start: keyword.start,
        end: finished.end,
        specifier: first.text,
        bindings: [],
        sideEffect: true
      },
      nextIndex: finished.next
    }
  }
  if (first.kind === SyntaxKind.TypeKeyword) cursor += 1
  const bindings: string[] = []
  const current = tokenAt(tokens, cursor)
  if (current === undefined) failImport(fileName, text, keyword.start)
  if (current.kind === SyntaxKind.AsteriskToken) {
    const asToken = tokenAt(tokens, cursor + 1)
    const name = tokenAt(tokens, cursor + 2)
    if (asToken?.kind !== SyntaxKind.AsKeyword || !isName(name)) {
      failImport(fileName, text, keyword.start)
    }
    bindings.push(name.text)
    cursor += 3
  } else if (current.kind === SyntaxKind.OpenBraceToken) {
    const named = readNamedImports(tokens, cursor, fileName, text)
    bindings.push(...named.names)
    cursor = named.next
  } else if (isName(current)) {
    bindings.push(current.text)
    cursor += 1
    if (tokenAt(tokens, cursor)?.kind === SyntaxKind.CommaToken) {
      cursor += 1
      if (tokenAt(tokens, cursor)?.kind !== SyntaxKind.OpenBraceToken)
        failImport(fileName, text, keyword.start)
      const named = readNamedImports(tokens, cursor, fileName, text)
      bindings.push(...named.names)
      cursor = named.next
    }
  } else failImport(fileName, text, keyword.start)
  if (tokenAt(tokens, cursor)?.kind !== SyntaxKind.FromKeyword)
    failImport(fileName, text, keyword.start)
  cursor += 1
  const specifier = tokenAt(tokens, cursor)
  if (specifier?.kind !== SyntaxKind.StringLiteral) failImport(fileName, text, keyword.start)
  const finished = finishImport(tokens, cursor, fileName)
  return {
    statement: {
      start: keyword.start,
      end: finished.end,
      specifier: specifier.text,
      bindings,
      sideEffect: bindings.length === 0
    },
    nextIndex: finished.next
  }
}

function importStatements(
  tokens: readonly ScannedToken[],
  fileName: string,
  text: string
): ImportStatement[] {
  const statements: ImportStatement[] = []
  for (let index = 0; index < tokens.length; index++) {
    const token = tokenAt(tokens, index)
    if (token?.kind !== SyntaxKind.ImportKeyword) continue
    const next = tokenAt(tokens, index + 1)
    if (next?.kind === SyntaxKind.OpenParenToken || next?.kind === SyntaxKind.DotToken) continue
    const parsed = parseImport(tokens, index, fileName, text)
    statements.push(parsed.statement)
    index = parsed.nextIndex - 1
  }
  return statements
}

function isNodeSideEffectSpecifier(specifier: string): boolean {
  return specifier.startsWith("node:") || nodeSideEffectPackages.has(specifier)
}

function moduleSpecifierUses(tokens: readonly ScannedToken[]): SpecifierUse[] {
  const uses: SpecifierUse[] = []
  for (let index = 0; index < tokens.length; index++) {
    const token = tokenAt(tokens, index)
    if (token?.kind !== SyntaxKind.StringLiteral) continue
    const previous = tokenAt(tokens, index - 1)
    const earlier = tokenAt(tokens, index - 2)
    const fromClause = previous?.kind === SyntaxKind.FromKeyword
    const bareImport = previous?.kind === SyntaxKind.ImportKeyword
    const ambientModule = previous?.kind === SyntaxKind.ModuleKeyword
    const importType =
      previous?.kind === SyntaxKind.OpenParenToken && earlier?.kind === SyntaxKind.ImportKeyword
    const requireCall =
      previous?.kind === SyntaxKind.OpenParenToken && isName(earlier) && earlier.text === "require"
    if (!fromClause && !bareImport && !ambientModule && !importType && !requireCall) continue
    uses.push({ specifier: token.text, start: token.start })
  }
  return uses
}

function declaredNames(tokens: readonly ScannedToken[]): string[] {
  const names: string[] = []
  for (let index = 0; index < tokens.length; index++) {
    const token = tokenAt(tokens, index)
    const next = tokenAt(tokens, index + 1)
    if (token === undefined || !isName(next)) continue
    if (declarationKeywords.has(token.kind)) names.push(next.text)
    if (token.kind !== SyntaxKind.TypeKeyword) continue
    const previous = tokenAt(tokens, index - 1)
    if (
      previous?.kind === SyntaxKind.OpenBraceToken ||
      previous?.kind === SyntaxKind.CommaToken ||
      previous?.kind === SyntaxKind.ImportKeyword
    ) {
      continue
    }
    names.push(next.text)
  }
  return names
}

function importLineRange(
  text: string,
  statement: ImportStatement,
  fileName: string
): { readonly start: number; readonly end: number } {
  if (text.slice(statement.start, statement.end).includes("\n")) {
    throw new Error(`${fileName} side-effect import spans multiple lines`)
  }
  const lineStart = text.lastIndexOf("\n", statement.start - 1) + 1
  const newline = text.indexOf("\n", statement.end)
  const contentEnd = newline === -1 ? text.length : newline
  const residue =
    `${text.slice(lineStart, statement.start)}${text.slice(statement.end, contentEnd)}`.trim()
  if (residue.length > 0)
    throw new Error(`${fileName} side-effect import shares a line with other code`)
  return { start: lineStart, end: newline === -1 ? text.length : newline + 1 }
}

function removeRanges(
  text: string,
  ranges: readonly { readonly start: number; readonly end: number }[]
): string {
  const ordered = [...ranges].sort((left, right) => left.start - right.start)
  let cursor = 0
  let result = ""
  for (const range of ordered) {
    if (range.start < cursor) throw new Error("overlapping declaration edits")
    result += text.slice(cursor, range.start)
    cursor = range.end
  }
  return result + text.slice(cursor)
}

/**
 * Removes side-effect-only `node:*` and Node-only package imports from one emitted declaration.
 * The declaration bundler keeps those imports because external modules are treated as side-effectful,
 * even when no exported type uses them. Fails when an exported type still references a removed module.
 */
export function stripNodeSideEffectImports(source: string, fileName = "declaration.d.ts"): string {
  const tokens = scanTokens(source)
  const statements = importStatements(tokens, fileName, source)
  const removable = statements.filter(
    (statement) => statement.sideEffect && isNodeSideEffectSpecifier(statement.specifier)
  )
  if (removable.length === 0) return source
  const uses = moduleSpecifierUses(tokens)
  for (const specifier of new Set(removable.map((statement) => statement.specifier))) {
    const referenced = uses.some((use) => {
      if (use.specifier !== specifier) return false
      return !removable.some(
        (statement) =>
          statement.specifier === specifier &&
          use.start >= statement.start &&
          use.start < statement.end
      )
    })
    if (referenced) throw new Error(`${fileName} still references "${specifier}"`)
  }
  const bound = new Set<string>()
  for (const statement of statements) for (const name of statement.bindings) bound.add(name)
  for (const name of declaredNames(tokens)) bound.add(name)
  for (let index = 0; index < tokens.length; index++) {
    const token = tokenAt(tokens, index)
    if (!isName(token) || !nodeGlobalTypes.has(token.text) || bound.has(token.text)) continue
    const previous = tokenAt(tokens, index - 1)
    const next = tokenAt(tokens, index + 1)
    if (previous?.kind === SyntaxKind.DotToken) continue
    if (next?.kind === SyntaxKind.ColonToken || next?.kind === SyntaxKind.QuestionToken) continue
    const specifiers = removable.map((statement) => statement.specifier).join(", ")
    throw new Error(
      `${fileName} uses Node type ${token.text}, which depends on side-effect import ${specifiers}`
    )
  }
  if (nodeTypesReference.test(source)) throw new Error(`${fileName} still references Node types`)
  return removeRanges(
    source,
    removable.map((statement) => importLineRange(source, statement, fileName))
  )
}

function declarationFiles(directory: string): string[] {
  if (!existsSync(directory)) return []
  const files: string[] = []
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && entry.name.endsWith(".d.ts")) files.push(path)
    }
  }
  visit(directory)
  return files
}

/** Strips Node side-effect imports from every `.d.ts` under `directory`, or fails before writing. */
export function stripDistNodeSideEffectImports(directory: string): void {
  const updates: Array<{ readonly file: string; readonly source: string }> = []
  for (const file of declarationFiles(directory)) {
    const source = readFileSync(file, "utf8")
    const stripped = stripNodeSideEffectImports(source, file)
    if (stripped !== source) updates.push({ file, source: stripped })
  }
  for (const update of updates) writeFileSync(update.file, update.source)
}

export default defineConfig(async (inlineConfig): Promise<UserConfig> => {
  const cwd = resolve(inlineConfig.cwd ?? process.cwd())
  const manifest = await Bun.file(join(cwd, "package.json")).json()
  const entry = packageEntries(manifest)
  const copy = ["README.md", "LICENSE"]
  if (existsSync(join(cwd, "THIRD_PARTY_NOTICES.md"))) copy.push("THIRD_PARTY_NOTICES.md")
  return {
    clean: true,
    copy,
    cwd,
    deps: { neverBundle: [/^@go-like\//, /^node:/] },
    dts: true,
    entry,
    format: "esm",
    hooks: {
      "build:done": async ({ options }) => {
        const output = resolve(options.cwd, options.outDir)
        stripDistNodeSideEffectImports(output)
        await Bun.write(
          join(output, "package.json"),
          `${JSON.stringify(await distPackageManifest(manifest, cwd), null, 2)}\n`
        )
      }
    },
    outDir: "dist",
    platform: "neutral",
    target: false,
    tsconfig: "tsconfig.json"
  }
})
