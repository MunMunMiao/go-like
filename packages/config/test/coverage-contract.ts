import { existsSync, readFileSync } from "node:fs"
import { isAbsolute, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { API, type Project, type Snapshot } from "typescript/unstable/async"
import {
  SyntaxKind,
  isExportDeclaration,
  isImportDeclaration,
  isInterfaceDeclaration,
  isNamedExports,
  isNamedImports,
  isTypeAliasDeclaration,
  type SourceFile,
  type Statement
} from "typescript/unstable/ast"

type SourceClass = "executable" | "barrel" | "type-only"

interface Counter {
  readonly found: number
  readonly hit: number
}

interface RecordSummary {
  readonly lines: Counter
  readonly functions: Counter
}

const PackageRoot = resolve(import.meta.dir, "..")
const CoveragePath = resolve(PackageRoot, ".artifacts/coverage/lcov.info")

/** Compares two sorted string inventories without weakening either side to a count. */
function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every(function same(value, index) {
      return value === right[index]
    })
  )
}

/** Identifies an explicitly type-only import; mixed imports remain runtime fail-closed subjects. */
function isTypeOnlyImport(statement: Statement): boolean {
  if (!isImportDeclaration(statement) || statement.importClause === undefined) return false
  if (statement.importClause.phaseModifier === SyntaxKind.TypeKeyword) return true
  const bindings = statement.importClause.namedBindings
  return (
    statement.importClause.name === undefined &&
    bindings !== undefined &&
    isNamedImports(bindings) &&
    bindings.elements.length > 0 &&
    bindings.elements.every(function typeSpecifier(specifier) {
      return specifier.isTypeOnly
    })
  )
}

/** Identifies an explicitly type-only export declaration, including a pure type barrel. */
function isTypeOnlyExport(statement: Statement): boolean {
  if (!isExportDeclaration(statement)) return false
  if (statement.isTypeOnly) return true
  const clause = statement.exportClause
  return (
    clause !== undefined &&
    isNamedExports(clause) &&
    clause.elements.length > 0 &&
    clause.elements.every(function typeSpecifier(specifier) {
      return specifier.isTypeOnly
    })
  )
}

/** Classifies only compiler-proven erased declarations and static re-export barrels outside executable code. */
function classifySource(sourceFile: SourceFile): SourceClass {
  if (sourceFile.isDeclarationFile) return "type-only"
  let classification: SourceClass = "type-only"
  for (const statement of sourceFile.statements) {
    if (
      isInterfaceDeclaration(statement) ||
      isTypeAliasDeclaration(statement) ||
      isTypeOnlyImport(statement) ||
      isTypeOnlyExport(statement)
    )
      continue
    if (isExportDeclaration(statement) && statement.moduleSpecifier !== undefined) {
      classification = "barrel"
      continue
    }
    return "executable"
  }
  return classification
}

/** Opens the package compiler project and classifies every discovered source with its TypeScript AST. */
async function classifySources(
  files: readonly string[]
): Promise<ReadonlyMap<string, SourceClass>> {
  const api = new API({ cwd: PackageRoot })
  let snapshot: Snapshot | null = null
  try {
    snapshot = await api.updateSnapshot({ openProjects: [resolve(PackageRoot, "tsconfig.json")] })
    const projects = snapshot.getProjects()
    if (projects.length !== 1)
      throw new Error("coverage classification requires exactly one compiler project")
    const project = projects[0]
    if (project === undefined)
      throw new Error("coverage classification compiler project is missing")
    return await classifyProjectSources(project, files)
  } finally {
    if (snapshot !== null) await snapshot.dispose()
    await api.close()
  }
}

/** Resolves every on-disk source through the compiler project before admitting an exclusion. */
async function classifyProjectSources(
  project: Project,
  files: readonly string[]
): Promise<ReadonlyMap<string, SourceClass>> {
  const classes = new Map<string, SourceClass>()
  for (const file of files) {
    const sourceFile = await project.program.getSourceFile(resolve(PackageRoot, file))
    if (sourceFile === undefined)
      throw new Error(`coverage source is absent from the compiler project: ${file}`)
    classes.set(file, classifySource(sourceFile))
  }
  return classes
}

/** Reads one unique legal non-negative LCOV summary counter. */
function summary(lines: readonly string[], key: string, source: string): number {
  const prefix = `${key}:`
  const values = lines.filter(function matching(line) {
    return line.startsWith(prefix)
  })
  if (values.length !== 1) throw new Error(`LCOV ${source} must contain exactly one ${key}`)
  const encoded = values[0]
  if (encoded === undefined) throw new Error(`LCOV ${source} is missing ${key}`)
  const value = Number(encoded.slice(prefix.length))
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`LCOV ${source} has an invalid ${key}`)
  return value
}

/** Maps one LCOV source field to a normalized package-relative path. */
function sourcePath(encoded: string): string {
  const raw = encoded.startsWith("file:") ? fileURLToPath(encoded) : encoded
  const absolute = isAbsolute(raw) ? raw : resolve(PackageRoot, raw)
  return relative(PackageRoot, absolute).replaceAll("\\", "/")
}

/** Validates Bun's detailed line records against the summary counters. */
function validateLineDetails(
  lines: readonly string[],
  source: string,
  found: number,
  hit: number
): void {
  const seen = new Set<number>()
  let hitDetails = 0
  for (const line of lines) {
    if (!line.startsWith("DA:")) continue
    const match = /^DA:(\d+),(\d+)(?:,.*)?$/.exec(line)
    if (match === null) throw new Error(`LCOV ${source} contains a malformed DA record`)
    const lineNumber = Number(match[1])
    const executions = Number(match[2])
    if (
      !Number.isSafeInteger(lineNumber) ||
      lineNumber <= 0 ||
      !Number.isSafeInteger(executions) ||
      executions < 0 ||
      seen.has(lineNumber)
    )
      throw new Error(`LCOV ${source} contains an invalid or duplicate DA record`)
    seen.add(lineNumber)
    if (executions > 0) hitDetails += 1
  }
  if (seen.size !== found || hitDetails !== hit) {
    throw new Error(`LCOV ${source} line details disagree with LF/LH summaries`)
  }
}

/** Requires one runtime record to carry non-zero, legal, complete line and function coverage. */
function validateRuntimeRecord(lines: readonly string[], source: string): RecordSummary {
  const functionsFound = summary(lines, "FNF", source)
  const functionsHit = summary(lines, "FNH", source)
  const linesFound = summary(lines, "LF", source)
  const linesHit = summary(lines, "LH", source)
  if (functionsHit > functionsFound || linesHit > linesFound) {
    throw new Error(`LCOV ${source} has hit counters greater than found counters`)
  }
  if (functionsFound === 0 || linesFound === 0) {
    throw new Error(`LCOV ${source} has a zero runtime denominator`)
  }
  if (functionsFound !== functionsHit || linesFound !== linesHit) {
    throw new Error(`Bun line/function coverage is below 100% for ${source}`)
  }
  validateLineDetails(lines, source, linesFound, linesHit)
  return Object.freeze({
    lines: Object.freeze({ found: linesFound, hit: linesHit }),
    functions: Object.freeze({ found: functionsFound, hit: functionsHit })
  })
}

/** Adds one complete per-file summary to an aggregate counter. */
function add(left: Counter, right: Counter): Counter {
  return Object.freeze({ found: left.found + right.found, hit: left.hit + right.hit })
}

const sourceFiles: string[] = []
for await (const path of new Bun.Glob("**/*.ts").scan({
  cwd: resolve(PackageRoot, "src"),
  onlyFiles: true
})) {
  sourceFiles.push(`src/${path}`)
}
sourceFiles.sort()
if (sourceFiles.length === 0)
  throw new Error("coverage contract discovered zero production sources")
const classes = await classifySources(sourceFiles)
const executableFiles = sourceFiles.filter(function executable(file) {
  return classes.get(file) === "executable"
})
const barrelFiles = sourceFiles.filter(function barrel(file) {
  return classes.get(file) === "barrel"
})
const typeOnlyFiles = sourceFiles.filter(function typeOnly(file) {
  return classes.get(file) === "type-only"
})
if (executableFiles.length === 0)
  throw new Error("coverage contract classified zero executable sources")

if (!existsSync(CoveragePath)) throw new Error("Bun coverage did not produce LCOV output")
const rawCoverage = readFileSync(CoveragePath, "utf8")
if (!rawCoverage.includes("end_of_record")) throw new Error("Bun LCOV contains no complete record")
const seen = new Set<string>()
let lines: Counter = Object.freeze({ found: 0, hit: 0 })
let functions: Counter = Object.freeze({ found: 0, hit: 0 })
for (const rawRecord of rawCoverage.split("end_of_record")) {
  const trimmed = rawRecord.trim()
  if (trimmed === "") continue
  const recordLines = trimmed.split(/\r?\n/)
  const sources = recordLines.filter(function source(line) {
    return line.startsWith("SF:")
  })
  if (sources.length !== 1)
    throw new Error("each non-empty LCOV record must contain exactly one source")
  const sourceLine = sources[0]
  if (sourceLine === undefined || sourceLine.length === 3)
    throw new Error("LCOV source field is empty")
  const source = sourcePath(sourceLine.slice(3))
  if (source.startsWith("dist/"))
    throw new Error(`LCOV unexpectedly contains generated output: ${source}`)
  if (!source.startsWith("src/")) continue
  if (!sourceFiles.includes(source))
    throw new Error(`LCOV contains an unexpected production source: ${source}`)
  if (classes.get(source) === "type-only")
    throw new Error(`LCOV contains a compiler-proven type-only source: ${source}`)
  if (seen.has(source)) throw new Error(`LCOV contains a duplicate production source: ${source}`)
  seen.add(source)
  const record = validateRuntimeRecord(recordLines, source)
  lines = add(lines, record.lines)
  functions = add(functions, record.functions)
}
const coveredFiles = Array.from(seen).sort()
const coveredExecutableFiles = coveredFiles.filter(function executable(file) {
  return classes.get(file) === "executable"
})
if (!sameStrings(coveredExecutableFiles, executableFiles)) {
  throw new Error(
    `LCOV executable inventory differs: expected ${JSON.stringify(executableFiles)}, got ${JSON.stringify(coveredExecutableFiles)}`
  )
}
if (lines.found === 0 || functions.found === 0)
  throw new Error("Bun coverage contains a zero aggregate denominator")

console.log(
  `LIKEGO_BUN_SOURCE_COVERAGE_V1=${JSON.stringify({
    package: "@likego/config",
    files: coveredFiles,
    executableFiles,
    barrelFiles,
    typeOnlyFiles,
    lines,
    functions,
    branches: { supported: false, percent: null, reason: "BUN_1_3_14_NO_BRANCH_COUNTER" }
  })}`
)
