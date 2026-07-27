import { existsSync, readFileSync } from "node:fs"

if (!existsSync(".artifacts/coverage/lcov.info")) {
  throw new Error("Bun coverage did not produce LCOV output")
}

const required = new Set([
  "src/errors.ts",
  "src/index.ts",
  "src/options.ts",
  "src/snapshot.ts",
  "src/testing.ts"
])
const records = readFileSync(".artifacts/coverage/lcov.info", "utf8").split("end_of_record\n")
const seen = new Set<string>()
for (const record of records) {
  const lines = record.split("\n")
  const source = lines.find((line) => line.startsWith("SF:"))
  if (source === undefined) continue
  const normalized = source.slice(3).replace(process.cwd() + "/", "")
  if (!required.has(normalized)) continue
  const functions = lines.find((line) => line.startsWith("FNF:"))
  const hit = lines.find((line) => line.startsWith("FNH:"))
  const foundLines = lines.find((line) => line.startsWith("LF:"))
  const hitLines = lines.find((line) => line.startsWith("LH:"))
  if (
    functions === undefined ||
    hit === undefined ||
    foundLines === undefined ||
    hitLines === undefined ||
    functions.slice(4) !== hit.slice(4) ||
    foundLines.slice(3) !== hitLines.slice(3)
  ) {
    throw new Error(`Store coverage is below 100% for ${normalized}`)
  }
  seen.add(normalized)
}
if (seen.size !== required.size) {
  throw new Error("LCOV does not contain every executable Store source")
}
