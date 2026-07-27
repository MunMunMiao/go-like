import { existsSync, readFileSync } from "node:fs"

const CoveragePath = ".artifacts/coverage/lcov.info"
const Expected = ["src/index.ts"]
const inventory = Array.from(new Bun.Glob("**/*.ts").scanSync({ cwd: "src", onlyFiles: true }))
  .map(function source(file) {
    return `src/${file}`
  })
  .sort()
if (JSON.stringify(inventory) !== JSON.stringify(Expected)) {
  throw new Error(`unexpected Vault config production inventory: ${inventory.join(",")}`)
}
if (!existsSync(CoveragePath)) throw new Error("Bun coverage did not produce LCOV output")

/** Reads one required non-negative LCOV counter. */
function counter(lines: readonly string[], name: string, source: string): number {
  const entry = lines.find(function named(line) {
    return line.startsWith(`${name}:`)
  })
  if (entry === undefined) throw new Error(`${source} is missing ${name}`)
  const value = Number(entry.slice(name.length + 1))
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${source} has invalid ${name}`)
  return value
}

const required = new Set(inventory)
const seen = new Set<string>()
let functions = 0
let lines = 0
for (const record of readFileSync(CoveragePath, "utf8").split("end_of_record\n")) {
  const entries = record.split("\n")
  const sourceEntry = entries.find(function source(entry) {
    return entry.startsWith("SF:")
  })
  if (sourceEntry === undefined) continue
  const source = sourceEntry.slice(3).replace(`${process.cwd()}/`, "")
  if (source.startsWith("dist/")) throw new Error(`LCOV contains generated output: ${source}`)
  if (source.startsWith("src/") && !required.has(source)) {
    throw new Error(`LCOV contains unexpected production source: ${source}`)
  }
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
if (seen.size !== required.size) {
  throw new Error("LCOV does not contain the exact Vault config production inventory")
}
console.log(
  `LIKEGO_BUN_COVERAGE_CONTRACT=${JSON.stringify({ package: "@likego/config-vault", files: seen.size, functions, lines })}`
)
