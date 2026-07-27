import { existsSync, readFileSync } from "node:fs"

import { validateBunPackageCoverage } from "../../../scripts/published/workspace-coverage"

if (!existsSync(".artifacts/coverage/lcov.info")) {
  throw new Error("Bun coverage did not produce LCOV output")
}

const required = new Set([
  "src/errors.ts",
  "src/index.ts",
  "src/options.ts",
  "src/provider.ts",
  "src/selector.ts",
  "src/snapshot.ts",
  "src/testing.ts"
])
const records = readFileSync(".artifacts/coverage/lcov.info", "utf8").split("end_of_record\n")
const seen = new Set<string>()
let linesFound = 0
let linesHit = 0
let functionsFound = 0
let functionsHit = 0
for (const record of records) {
  const lines = record.split("\n")
  const source = lines.find((line) => line.startsWith("SF:"))
  if (source === undefined) continue
  const normalized = source.slice(3).replace(process.cwd() + "/", "")
  if (normalized.startsWith("dist/"))
    throw new Error(`LCOV unexpectedly contains generated output: ${normalized}`)
  if (normalized.startsWith("src/") && !required.has(normalized)) {
    throw new Error(`LCOV contains an unexpected production source: ${normalized}`)
  }
  if (!required.has(normalized)) continue
  if (seen.has(normalized))
    throw new Error(`LCOV contains a duplicate production source: ${normalized}`)
  seen.add(normalized)
  const fnf = lines.find((line) => line.startsWith("FNF:"))
  const fnh = lines.find((line) => line.startsWith("FNH:"))
  const lf = lines.find((line) => line.startsWith("LF:"))
  const lh = lines.find((line) => line.startsWith("LH:"))
  if (fnf === undefined || fnh === undefined || lf === undefined || lh === undefined)
    throw new Error(`coverage counters are missing for ${normalized}`)
  const fileFunctionsFound = Number(fnf.slice(4))
  const fileFunctionsHit = Number(fnh.slice(4))
  const fileLinesFound = Number(lf.slice(3))
  const fileLinesHit = Number(lh.slice(3))
  if (
    !Number.isSafeInteger(fileFunctionsFound) ||
    !Number.isSafeInteger(fileFunctionsHit) ||
    !Number.isSafeInteger(fileLinesFound) ||
    !Number.isSafeInteger(fileLinesHit) ||
    fileFunctionsFound === 0 ||
    fileLinesFound === 0 ||
    fileFunctionsFound !== fileFunctionsHit ||
    fileLinesHit > fileLinesFound
  )
    throw new Error(
      `function coverage is below 100% or line counters are invalid for ${normalized}`
    )
  linesFound += fileLinesFound
  linesHit += fileLinesHit
  functionsFound += fileFunctionsFound
  functionsHit += fileFunctionsHit
}
if (seen.size !== required.size)
  throw new Error("LCOV does not contain exactly the required executable source files")
if (linesFound === 0 || functionsFound === 0)
  throw new Error("Bun coverage contains a zero executable denominator")
await validateBunPackageCoverage(
  process.cwd(),
  readFileSync(".artifacts/coverage/lcov.info", "utf8")
)
console.log(
  `LIKEGO_BUN_SOURCE_COVERAGE_V1=${JSON.stringify({
    package: "@likego/registry",
    files: [...seen].sort(),
    lines: { found: linesFound, hit: linesHit },
    functions: { found: functionsFound, hit: functionsHit },
    branches: { supported: false, percent: null, reason: "BUN_1_3_14_NO_BRANCH_COUNTER" }
  })}`
)
