import { relative, resolve } from "node:path"
import { parse, type ParseResult } from "@babel/parser"
import type {
  Declaration,
  ExportAllDeclaration,
  ExportNamedDeclaration,
  File,
  ImportDeclaration,
  ModuleDeclaration,
  Statement
} from "@babel/types"

export type SourceCoverageClass = "executable" | "type-only" | "barrel"

interface LcovRecord {
  readonly source: string
  readonly functionsFound: number
  readonly functionsHit: number
  readonly linesFound: number
  readonly linesHit: number
  readonly missedLines: readonly number[]
}

interface LcovLineDetails {
  readonly missed: readonly number[]
}

function counter(lines: readonly string[], prefix: string): number {
  const values = lines.filter((line) => line.startsWith(prefix))
  if (values.length !== 1) throw new Error(`LCOV record must contain exactly one ${prefix} counter`)
  const encoded = values[0]
  if (encoded === undefined) throw new Error(`LCOV record is missing ${prefix}`)
  const value = Number(encoded.slice(prefix.length))
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`LCOV contains an invalid ${prefix} counter`)
  return value
}

function lineDetails(
  lines: readonly string[],
  source: string,
  linesFound: number,
  linesHit: number
): LcovLineDetails {
  if (linesHit > linesFound) throw new Error(`LCOV ${source} line hit count exceeds found count`)
  const encoded = lines.filter((line) => line.startsWith("DA:"))
  if (encoded.length === 0) {
    if (linesFound !== linesHit)
      throw new Error(`LCOV ${source} omits detailed evidence for incomplete line coverage`)
    return Object.freeze({ missed: Object.freeze([]) })
  }
  if (encoded.length !== linesFound)
    throw new Error(`LCOV ${source} line detail count differs from LF`)
  const seen = new Set<number>()
  const missed: number[] = []
  let detailedHits = 0
  for (const entry of encoded) {
    const match = /^DA:(\d+),(\d+)(?:,.*)?$/.exec(entry)
    const line = Number(match?.[1])
    const hits = Number(match?.[2])
    if (
      !Number.isSafeInteger(line) ||
      line < 1 ||
      !Number.isSafeInteger(hits) ||
      hits < 0 ||
      seen.has(line)
    ) {
      throw new Error(`LCOV ${source} contains invalid line detail`)
    }
    seen.add(line)
    if (hits === 0) missed.push(line)
    else detailedHits += 1
  }
  if (detailedHits !== linesHit) throw new Error(`LCOV ${source} line details differ from LH`)
  return Object.freeze({
    missed: Object.freeze(missed.sort((left, right) => left - right))
  })
}

function records(packageRoot: string, lcov: string): readonly LcovRecord[] {
  const records: LcovRecord[] = []
  for (const raw of lcov.split("end_of_record")) {
    const lines = raw.trim().split("\n")
    const sources = lines.filter((line) => line.startsWith("SF:"))
    if (sources.length === 0) continue
    if (sources.length !== 1) throw new Error("LCOV record contains duplicate source fields")
    const encodedSource = sources[0]
    if (encodedSource === undefined) throw new Error("LCOV record has no source value")
    const rawSource = encodedSource.slice(3)
    const source = rawSource.startsWith("/")
      ? relative(packageRoot, rawSource)
      : relative(packageRoot, resolve(packageRoot, rawSource))
    const functionsFound = counter(lines, "FNF:")
    const functionsHit = counter(lines, "FNH:")
    const linesFound = counter(lines, "LF:")
    const linesHit = counter(lines, "LH:")
    const details = lineDetails(lines, source, linesFound, linesHit)
    records.push(
      Object.freeze({
        source,
        functionsFound,
        functionsHit,
        linesFound,
        linesHit,
        missedLines: details.missed
      })
    )
  }
  return records
}

function typeOnlyImport(node: ImportDeclaration): boolean {
  if (node.importKind === "type" || node.importKind === "typeof") return true
  return (
    node.specifiers.length > 0 &&
    node.specifiers.every(
      (specifier) =>
        specifier.type === "ImportSpecifier" &&
        (specifier.importKind === "type" || specifier.importKind === "typeof")
    )
  )
}

function typeOnlyExport(node: ExportAllDeclaration | ExportNamedDeclaration): boolean {
  if (node.exportKind === "type") return true
  if (node.type === "ExportAllDeclaration") return false
  return (
    node.specifiers.length > 0 &&
    node.specifiers.every(
      (specifier) => specifier.type === "ExportSpecifier" && specifier.exportKind === "type"
    )
  )
}

function statementClass(
  path: string,
  node: Statement | ModuleDeclaration | Declaration
): SourceCoverageClass | null {
  switch (node.type) {
    case "TSInterfaceDeclaration":
    case "TSTypeAliasDeclaration":
    case "TSDeclareFunction":
    case "TSNamespaceExportDeclaration":
    case "DeclareClass":
    case "DeclareFunction":
    case "DeclareModule":
    case "DeclareVariable":
      return "type-only"
    case "VariableDeclaration":
    case "FunctionDeclaration":
    case "ClassDeclaration":
    case "TSModuleDeclaration":
      return node.declare === true ? "type-only" : "executable"
    case "ImportDeclaration":
      return typeOnlyImport(node) ? "type-only" : "executable"
    case "ExportAllDeclaration":
      return typeOnlyExport(node) ? "type-only" : "barrel"
    case "ExportNamedDeclaration":
      if (node.declaration !== null && node.declaration !== undefined)
        return statementClass(path, node.declaration)
      if (typeOnlyExport(node)) return "type-only"
      return node.source === null ? "executable" : "barrel"
    case "EmptyStatement":
      return null
    case "ExpressionStatement":
    case "BlockStatement":
    case "DebuggerStatement":
    case "WithStatement":
    case "ReturnStatement":
    case "LabeledStatement":
    case "BreakStatement":
    case "ContinueStatement":
    case "IfStatement":
    case "SwitchStatement":
    case "ThrowStatement":
    case "TryStatement":
    case "WhileStatement":
    case "DoWhileStatement":
    case "ForStatement":
    case "ForInStatement":
    case "ForOfStatement":
    case "ExportDefaultDeclaration":
    case "TSExportAssignment":
    case "TSImportEqualsDeclaration":
    case "TSEnumDeclaration":
      return "executable"
    default:
      throw new Error(
        `Bun coverage classifier does not recognize ${path} statement kind ${node.type}`
      )
  }
}

function parseSource(path: string, source: string): ParseResult<File> {
  try {
    return parse(source, {
      sourceType: "module",
      sourceFilename: path,
      errorRecovery: false,
      plugins: ["typescript"]
    })
  } catch {
    throw new Error(`Bun coverage cannot parse ${path}`)
  }
}

/** Classifies one complete TypeScript source without treating parse failures as type-only. */
export function classifySourceCoverage(path: string, source: string): SourceCoverageClass {
  const file = parseSource(path, source)
  let classification: SourceCoverageClass = "type-only"
  if (file.program.directives.length > 0) classification = "executable"
  for (const statement of file.program.body) {
    const current = statementClass(path, statement)
    if (current === "executable") return "executable"
    if (current === "barrel") classification = "barrel"
  }
  return classification
}

async function packageName(packageRoot: string): Promise<string> {
  const manifest: unknown = await Bun.file(`${packageRoot}/package.json`).json()
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    Array.isArray(manifest) ||
    !("name" in manifest) ||
    typeof manifest.name !== "string" ||
    manifest.name.length === 0
  ) {
    throw new Error("Bun coverage package manifest has no valid name")
  }
  return manifest.name
}

function validateLineAttributionGaps(name: string, record: LcovRecord): void {
  const line = record.missedLines[0]
  if (line !== undefined) {
    throw new Error(`unreviewed Bun line-attribution gap at ${name}:${record.source}:${line}`)
  }
}

/** Validates source inventory and complete function and line coverage. */
export async function validateBunPackageCoverage(packageRoot: string, lcov: string): Promise<void> {
  const name = await packageName(packageRoot)
  const expected = new Map<string, SourceCoverageClass>()
  const glob = new Bun.Glob("**/*.ts")
  for await (const path of glob.scan({ cwd: `${packageRoot}/src`, onlyFiles: true })) {
    if (!path.endsWith(".d.ts")) {
      const sourcePath = `src/${path}`
      expected.set(
        sourcePath,
        classifySourceCoverage(sourcePath, await Bun.file(`${packageRoot}/${sourcePath}`).text())
      )
    }
  }
  if (expected.size === 0)
    throw new Error("Bun coverage package has zero production source subjects")
  const seen = new Set<string>()
  let linesFound = 0
  for (const record of records(packageRoot, lcov)) {
    if (!record.source.startsWith("src/")) continue
    const classification = expected.get(record.source)
    if (classification === undefined)
      throw new Error(`Bun LCOV contains unexpected production source ${record.source}`)
    if (seen.has(record.source))
      throw new Error(`Bun LCOV contains duplicate production source ${record.source}`)
    seen.add(record.source)
    if (record.functionsHit > record.functionsFound)
      throw new Error(`Bun function coverage counters are invalid for ${record.source}`)
    if (record.functionsFound !== record.functionsHit)
      throw new Error(`Bun function coverage is below 100% for ${record.source}`)
    validateLineAttributionGaps(name, record)
    if (classification === "executable") {
      if (record.linesFound === 0)
        throw new Error(`Bun coverage has zero executable line subjects for ${record.source}`)
      linesFound += record.linesFound
    }
  }
  let executableFiles = 0
  for (const [source, classification] of Array.from(expected).sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    if (classification !== "executable") continue
    executableFiles += 1
    if (!seen.has(source)) throw new Error(`Bun LCOV is missing ${source}`)
  }
  if (executableFiles === 0 || linesFound === 0) {
    throw new Error("Bun coverage package has zero executable line subjects")
  }
}
