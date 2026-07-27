import { relative, resolve } from "node:path"

import { validateBunPackageCoverage } from "../../../scripts/published/workspace-coverage"

const marker = "LIKEGO_BUN_SOURCE_COVERAGE_V1"
const packageRoot = resolve(import.meta.dir, "..")
const coveragePath = resolve(packageRoot, ".artifacts/coverage/lcov.info")

if (!(await Bun.file(coveragePath).exists())) {
  throw new Error("Bun coverage did not produce LCOV output")
}

const lcov = await Bun.file(coveragePath).text()
await validateBunPackageCoverage(packageRoot, lcov)

/** Reads one required non-negative integer counter from an LCOV record. */
function counter(lines: readonly string[], prefix: string): number {
  const encoded = lines.filter((line) => line.startsWith(prefix))
  if (encoded.length !== 1)
    throw new Error(`LCOV record must contain exactly one ${prefix} counter`)
  const value = encoded[0]
  if (value === undefined) throw new Error(`LCOV record is missing ${prefix}`)
  const parsed = Number(value.slice(prefix.length))
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error(`LCOV contains an invalid ${prefix} counter`)
  return parsed
}

const files = new Set<string>()
let functionsFound = 0
let functionsHit = 0
let linesFound = 0
let linesHit = 0
for (const rawRecord of lcov.split("end_of_record")) {
  const lines = rawRecord.trim().split("\n")
  const sourceFields = lines.filter((line) => line.startsWith("SF:"))
  if (sourceFields.length === 0) continue
  if (sourceFields.length !== 1) throw new Error("LCOV record contains duplicate source fields")
  const sourceField = sourceFields[0]
  if (sourceField === undefined) throw new Error("LCOV record has no source value")
  const sourceValue = sourceField.slice(3)
  const source = sourceValue.startsWith("/")
    ? relative(packageRoot, sourceValue)
    : relative(packageRoot, resolve(packageRoot, sourceValue))
  if (!source.startsWith("src/")) continue
  files.add(source)
  functionsFound += counter(lines, "FNF:")
  functionsHit += counter(lines, "FNH:")
  linesFound += counter(lines, "LF:")
  linesHit += counter(lines, "LH:")
}

if (functionsFound === 0 || linesFound === 0) {
  throw new Error("Bun coverage contains a zero production line or function denominator")
}

process.stdout.write(
  `${marker}=${JSON.stringify({
    package: "@likego/core",
    files: Array.from(files).sort(),
    lines: { found: linesFound, hit: linesHit },
    functions: { found: functionsFound, hit: functionsHit },
    branches: { supported: false, percent: null, reason: "BUN_1_3_14_NO_BRANCH_COUNTER" }
  })}\n`
)
