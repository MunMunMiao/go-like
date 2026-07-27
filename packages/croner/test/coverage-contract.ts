import { existsSync, readFileSync } from "node:fs"
import { isAbsolute, relative } from "node:path"

const CoveragePath = ".artifacts/coverage/lcov.info"
const RequiredSources = new Set(["src/errors.ts", "src/index.ts", "src/server.ts"])

/** Normalizes one LCOV source path against the package working directory. */
function sourcePath(value: string): string {
  const path = isAbsolute(value) ? relative(process.cwd(), value) : value.replace(/^\.\//, "")
  return path.replaceAll("\\", "/")
}

/** Reads one unique non-negative safe-integer LCOV metric. */
function metric(lines: readonly string[], name: "FNF" | "FNH" | "LF" | "LH"): number {
  const matches = lines.filter((line) => line.startsWith(`${name}:`))
  if (matches.length !== 1) throw new Error(`LCOV record must contain exactly one ${name} metric`)
  const raw = matches[0]?.slice(name.length + 1)
  if (raw === undefined || !/^(?:0|[1-9]\d*)$/.test(raw))
    throw new Error(`LCOV ${name} metric is not an integer`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) throw new Error(`LCOV ${name} metric is not a safe integer`)
  return value
}

if (!existsSync(CoveragePath)) throw new Error("Bun coverage did not produce LCOV output")

const seen = new Set<string>()
let linesFound = 0
let linesHit = 0
let functionsFound = 0
let functionsHit = 0
for (const record of readFileSync(CoveragePath, "utf8").split("end_of_record\n")) {
  const lines = record.split("\n")
  const sources = lines.filter((line) => line.startsWith("SF:"))
  if (sources.length === 0) continue
  if (sources.length !== 1) throw new Error("LCOV record contains duplicate source fields")
  const source = sourcePath(sources[0]?.slice(3) ?? "")
  if (source.startsWith("dist/"))
    throw new Error(`LCOV unexpectedly contains generated output: ${source}`)
  if (source.startsWith("src/") && !RequiredSources.has(source)) {
    throw new Error(`LCOV contains an unexpected production source: ${source}`)
  }
  if (!RequiredSources.has(source)) continue
  if (seen.has(source)) throw new Error(`LCOV contains a duplicate production source: ${source}`)
  seen.add(source)
  const fnf = metric(lines, "FNF")
  const fnh = metric(lines, "FNH")
  const lf = metric(lines, "LF")
  const lh = metric(lines, "LH")
  if (fnf === 0 || lf === 0) throw new Error(`${source} has a zero executable denominator`)
  if (fnf !== fnh || lf !== lh) throw new Error(`${source} line/function coverage is below 100%`)
  functionsFound += fnf
  functionsHit += fnh
  linesFound += lf
  linesHit += lh
  if (![functionsFound, functionsHit, linesFound, linesHit].every(Number.isSafeInteger)) {
    throw new Error("Bun coverage aggregate exceeds the safe integer range")
  }
}
if (seen.size !== RequiredSources.size) {
  throw new Error("LCOV does not contain exactly the three required executable source files")
}
if (functionsFound === 0 || linesFound === 0)
  throw new Error("Bun coverage contains a zero executable denominator")

console.log(
  `LIKEGO_BUN_SOURCE_COVERAGE_V1=${JSON.stringify({
    package: "@likego/croner",
    files: Array.from(seen).sort(),
    lines: { found: linesFound, hit: linesHit },
    functions: { found: functionsFound, hit: functionsHit },
    branches: { supported: false, percent: null, reason: "BUN_1_3_14_NO_BRANCH_COUNTER" }
  })}`
)

// src/types.ts is intentionally absent: it contains only erased declarations,
// while test/public-types.ts and package typecheck own its published type contract.
