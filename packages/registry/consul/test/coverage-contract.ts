import { existsSync, readFileSync } from "node:fs"

import { validateBunPackageCoverage } from "../../../../scripts/published/workspace-coverage"

const path = ".artifacts/coverage/lcov.info"
const expected = new Set([
  "src/codec.ts",
  "src/discovery.ts",
  "src/errors.ts",
  "src/http.ts",
  "src/index.ts",
  "src/options.ts",
  "src/registration.ts",
  "src/runtime.ts"
])
if (!existsSync(path)) throw new Error("Bun coverage did not produce LCOV output")
const records = readFileSync(path, "utf8").split("end_of_record\n")
const seen = new Set<string>()
let linesFound = 0
let linesHit = 0
let functionsFound = 0
let functionsHit = 0
for (const record of records) {
  const lines = record.split("\n")
  const sourceLine = lines.find(function source(line) {
    return line.startsWith("SF:")
  })
  if (sourceLine === undefined) continue
  const source = sourceLine.slice(3).replace(process.cwd() + "/", "")
  if (!expected.has(source))
    throw new Error(`LCOV contains unexpected or non-source record: ${source}`)
  if (seen.has(source)) throw new Error(`LCOV contains duplicate source record: ${source}`)
  seen.add(source)
  const fnf = lines.find(function functionFound(line) {
    return line.startsWith("FNF:")
  })
  const fnh = lines.find(function functionHit(line) {
    return line.startsWith("FNH:")
  })
  const lf = lines.find(function lineFound(line) {
    return line.startsWith("LF:")
  })
  const lh = lines.find(function lineHit(line) {
    return line.startsWith("LH:")
  })
  const foundFunctions = fnf === undefined ? Number.NaN : Number(fnf.slice(4))
  const hitFunctions = fnh === undefined ? Number.NaN : Number(fnh.slice(4))
  const foundLines = lf === undefined ? Number.NaN : Number(lf.slice(3))
  const hitLines = lh === undefined ? Number.NaN : Number(lh.slice(3))
  if (
    !Number.isSafeInteger(foundFunctions) ||
    !Number.isSafeInteger(hitFunctions) ||
    !Number.isSafeInteger(foundLines) ||
    !Number.isSafeInteger(hitLines) ||
    foundFunctions < 1 ||
    foundLines < 1 ||
    foundFunctions !== hitFunctions ||
    hitLines > foundLines
  ) {
    throw new Error(`SF:${source} function coverage is below 100% or line counters are invalid`)
  }
  functionsFound += foundFunctions
  functionsHit += hitFunctions
  linesFound += foundLines
  linesHit += hitLines
}

await validateBunPackageCoverage(process.cwd(), readFileSync(path, "utf8"))
const missing = [...expected].filter(function absent(source) {
  return !seen.has(source)
})
if (missing.length !== 0 || seen.size !== expected.size) {
  throw new Error(`LCOV executable source inventory differs: missing ${missing.join(",")}`)
}
console.log(
  `LIKEGO_BUN_SOURCE_COVERAGE_V1=${JSON.stringify({
    package: "@likego/registry-consul",
    files: Array.from(seen).sort(),
    lines: { found: linesFound, hit: linesHit },
    functions: { found: functionsFound, hit: functionsHit },
    branches: { supported: false, percent: null, reason: "BUN_1_3_14_NO_BRANCH_COUNTER" }
  })}`
)

// src/types.ts is intentionally absent: source-policy locks it to type-only declarations,
// while test/public-types.ts and package typecheck own its published type contract.
