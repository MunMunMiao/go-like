import { join } from "node:path"

const processIdPath = process.argv[2]
const readyPath = process.argv[3]

if (processIdPath === undefined || readyPath === undefined) {
  throw new Error("breakaway fixture paths are required")
}

const descendant = Bun.spawn(
  [process.execPath, join(import.meta.dir, "persistent.ts"), readyPath, "stdout"],
  {
    stdout: "inherit",
    stderr: "inherit",
    detached: true
  }
)
await Bun.write(processIdPath, String(descendant.pid))
while (!(await Bun.file(readyPath).exists())) await Bun.sleep(5)
process.stdout.write(`BREAKAWAY_PID=${descendant.pid}\n`)
await Bun.sleep(250)
process.exit(0)
