const CoveragePath = ".artifacts/coverage/lcov.info"

export {}
const Expected = new Set([
  "src/codec.ts",
  "src/errors.ts",
  "src/http.ts",
  "src/index.ts",
  "src/options.ts",
  "src/store.ts"
])

if (!(await Bun.file(CoveragePath).exists())) throw new Error("Bun coverage did not produce LCOV")
const records = (await Bun.file(CoveragePath).text()).split("end_of_record\n")
const seen = new Set<string>()
let functions = 0
let lines = 0

function counter(entries: readonly string[], name: string, source: string): number {
  const entry = entries.find((line) => line.startsWith(`${name}:`))
  if (entry === undefined) throw new Error(`${source} is missing ${name}`)
  const value = Number(entry.slice(name.length + 1))
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${source} has invalid ${name}`)
  return value
}

for (const record of records) {
  const entries = record.split("\n")
  const sourceEntry = entries.find((entry) => entry.startsWith("SF:"))
  if (sourceEntry === undefined) continue
  const source = sourceEntry.slice(3).replace(`${process.cwd()}/`, "")
  if (!Expected.has(source)) throw new Error(`LCOV contains unexpected source: ${source}`)
  if (seen.has(source)) throw new Error(`LCOV contains duplicate source: ${source}`)
  seen.add(source)
  const foundFunctions = counter(entries, "FNF", source)
  const hitFunctions = counter(entries, "FNH", source)
  const foundLines = counter(entries, "LF", source)
  const hitLines = counter(entries, "LH", source)
  if (
    foundFunctions < 1 ||
    foundLines < 1 ||
    foundFunctions !== hitFunctions ||
    foundLines !== hitLines
  ) {
    throw new Error(`${source} line/function coverage is below 100%`)
  }
  functions += foundFunctions
  lines += foundLines
}
if (seen.size !== Expected.size) throw new Error("LCOV source inventory differs from production")
console.log(
  `LIKEGO_BUN_COVERAGE_CONTRACT=${JSON.stringify({ package: "@likego/store-vault", files: seen.size, functions, lines })}`
)
