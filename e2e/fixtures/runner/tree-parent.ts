import { join } from "node:path"

const mode = process.argv[2]
const processIdPath = process.argv[3]
const readyPath = process.argv[4]

if (mode !== "wait" && mode !== "exit" && mode !== "inherit") {
  throw new Error("tree mode must be wait, exit, or inherit")
}
if (processIdPath === undefined || readyPath === undefined) {
  throw new Error("tree fixture paths are required")
}

const descendant = Bun.spawn(
  [
    process.execPath,
    join(import.meta.dir, "persistent.ts"),
    readyPath,
    mode === "inherit" ? "stdout" : "silent"
  ],
  {
    stdout: mode === "inherit" ? "inherit" : "ignore",
    stderr: mode === "exit" ? "ignore" : "inherit"
  }
)
await Bun.write(processIdPath, String(descendant.pid))
while (!(await Bun.file(readyPath).exists())) await Bun.sleep(5)

if (mode === "inherit") process.stdout.write(`DESCENDANT_PID=${descendant.pid}\n`)
if (mode === "exit" || mode === "inherit") process.exit(0)
await new Promise(function never() {})
