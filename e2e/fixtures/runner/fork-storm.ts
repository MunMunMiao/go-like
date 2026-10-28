import { appendFileSync } from "node:fs"
import { join } from "node:path"

const [barrierDirectory, processIdPath, readyPath] = process.argv.slice(2)

if (barrierDirectory === undefined || processIdPath === undefined || readyPath === undefined) {
  throw new Error("fork storm fixture paths are required")
}
const barrierRoot: string = barrierDirectory
const targetProcessIdPath: string = processIdPath
const descendantReadyPath: string = readyPath

process.on("SIGTERM", function ignore() {})
const descendants = new Set<Bun.Subprocess>()
let periodicStorm: ReturnType<typeof setInterval> | null = null

function recordProcessId(processId: number): void {
  appendFileSync(targetProcessIdPath, `${processId}\n`)
}

function spawnDescendant(): void {
  const descendant = Bun.spawn(
    [process.execPath, join(import.meta.dir, "persistent.ts"), descendantReadyPath, "silent"],
    { stdout: "ignore", stderr: "ignore" }
  )
  descendants.add(descendant)
  recordProcessId(descendant.pid)
  void descendant.exited.finally(() => descendants.delete(descendant))
}

await Bun.write(targetProcessIdPath, `${process.pid}\n`)
for (let index = 0; index < 3; index += 1) spawnDescendant()
periodicStorm = setInterval(spawnDescendant, 10)
while (!(await Bun.file(descendantReadyPath).exists())) await Bun.sleep(5)
process.stdout.write("FORK_STORM_READY\n")

while (true) {
  for (const stage of ["term", "kill-1", "kill-2", "kill-3"] as const) {
    const ready = Bun.file(join(barrierRoot, `${stage}.ready`))
    const releasePath = join(barrierRoot, `${stage}.release`)
    if ((await ready.exists()) && !(await Bun.file(releasePath).exists())) {
      if (stage === "kill-3" && periodicStorm !== null) {
        clearInterval(periodicStorm)
        periodicStorm = null
      }
      for (let index = 0; index < 8; index += 1) spawnDescendant()
      await Bun.write(releasePath, "release")
    }
  }
  await Bun.sleep(5)
}
