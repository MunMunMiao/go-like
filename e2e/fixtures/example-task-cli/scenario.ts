import { writeFile } from "node:fs/promises"

const mode = process.argv[2]
const markerPath = process.env.LIKEGO_TEST_SCENARIO_MARKER
if (markerPath === undefined || markerPath.length === 0) {
  throw new Error("example-task CLI fixture scenario marker is unavailable")
}
await writeFile(markerPath, `${mode ?? "missing"}\n`, { flag: "wx", mode: 0o600 })

if (mode === "pass") {
  process.stdout.write("example-task-cli:passed\n")
} else if (mode === "fail") {
  throw new Error("example-task-cli:scenario-failed")
} else if (mode === "wait") {
  await Bun.sleep(24 * 60 * 60 * 1_000)
} else {
  throw new Error("example-task CLI fixture mode is invalid")
}
