import { existsSync, readFileSync } from "node:fs"

const coveragePath = ".artifacts/coverage/lcov.info"
const expected = [
  "src/broker.ts",
  "src/client.ts",
  "src/errors.ts",
  "src/index.ts",
  "src/instrumentation.ts",
  "src/runtime.ts",
  "src/server.ts",
  "src/types.ts"
]
const inventory = Array.from(new Bun.Glob("**/*.ts").scanSync({ cwd: "src", onlyFiles: true }))
  .map((file) => `src/${file}`)
  .sort()
if (JSON.stringify(inventory) !== JSON.stringify(expected)) {
  throw new Error(`unexpected OpenTelemetry adapter production inventory: ${inventory.join(",")}`)
}
if (!existsSync(coveragePath)) throw new Error("Bun coverage did not produce LCOV output")

/** Parses one required non-negative safe integer LCOV counter. */
function counter(lines: readonly string[], name: string, source: string): number {
  const entry = lines.find((line) => line.startsWith(`${name}:`))
  if (entry === undefined) throw new Error(`${source} is missing ${name}`)
  const value = Number(entry.slice(name.length + 1))
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${source} has invalid ${name}`)
  return value
}

const required = new Set(inventory)
const seen = new Set<string>()
let functions = 0
let lines = 0
for (const record of readFileSync(coveragePath, "utf8").split("end_of_record\n")) {
  const entries = record.split("\n")
  const sourceEntry = entries.find((entry) => entry.startsWith("SF:"))
  if (sourceEntry === undefined) continue
  const source = sourceEntry.slice(3).replace(`${process.cwd()}/`, "")
  if (source.startsWith("dist/")) throw new Error(`LCOV contains generated output: ${source}`)
  if (source.startsWith("src/") && !required.has(source))
    throw new Error(`LCOV contains unexpected production source: ${source}`)
  if (!required.has(source)) continue
  if (seen.has(source)) throw new Error(`LCOV contains duplicate production source: ${source}`)
  seen.add(source)
  const foundFunctions = counter(entries, "FNF", source)
  const hitFunctions = counter(entries, "FNH", source)
  const foundLines = counter(entries, "LF", source)
  const hitLines = counter(entries, "LH", source)
  if (
    foundFunctions === 0 ||
    foundLines === 0 ||
    foundFunctions !== hitFunctions ||
    foundLines !== hitLines
  ) {
    throw new Error(`${source} line/function coverage is below 100% or has an empty denominator`)
  }
  functions += foundFunctions
  lines += foundLines
}
if (seen.size !== required.size)
  throw new Error("LCOV does not contain the exact OpenTelemetry adapter production inventory")
console.log(
  `LIKEGO_BUN_COVERAGE_CONTRACT=${JSON.stringify({ package: "@likego/otel", files: seen.size, functions, lines })}`
)
