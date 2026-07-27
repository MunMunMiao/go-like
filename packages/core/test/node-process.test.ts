import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import { expect, test } from "bun:test"

interface ProcessEvidence {
  readonly stops: number
  readonly interruptListenerDelta: number
  readonly quitListenerDelta: number
  readonly terminateListenerDelta: number
}

/** Builds one standalone fixture from the current Core sources. */
async function buildFixture(directory: string): Promise<string> {
  const entry = join(directory, "signal-fixture.ts")
  const sourceRoot = resolve(import.meta.dir, "../src")
  await writeFile(
    entry,
    `import process from "node:process"
import { newApp, server } from ${JSON.stringify(join(sourceRoot, "index.ts"))}
import { signal } from ${JSON.stringify(join(sourceRoot, "node.ts"))}

const selected = process.argv[2]
if (selected !== "SIGINT" && selected !== "SIGQUIT" && selected !== "SIGTERM") throw new Error("invalid signal")
const beforeInterrupt = process.listenerCount("SIGINT")
const beforeQuit = process.listenerCount("SIGQUIT")
const beforeTerminate = process.listenerCount("SIGTERM")
let stops = 0
let resolveDone = () => {}
const done = new Promise((resolve) => { resolveDone = resolve })
const keepalive = setTimeout(() => {}, 2_000)
const app = newApp(signal(), server({
  async start() {
    setTimeout(() => process.kill(process.pid, selected), 50)
    await done
  },
  async stop() {
    stops += 1
    resolveDone()
  }
}))
await app.run()
clearTimeout(keepalive)
process.stdout.write(JSON.stringify({
  stops,
  interruptListenerDelta: process.listenerCount("SIGINT") - beforeInterrupt,
  quitListenerDelta: process.listenerCount("SIGQUIT") - beforeQuit,
  terminateListenerDelta: process.listenerCount("SIGTERM") - beforeTerminate
}) + "\\n")
`
  )
  const result = await Bun.build({
    entrypoints: [entry],
    outdir: directory,
    format: "esm",
    target: "node"
  })
  if (!result.success) throw new Error("runtime fixture build failed")
  const output = result.outputs[0]
  if (output === undefined) throw new Error("runtime fixture output is missing")
  return output.path
}

/** Runs one real operating-system signal case. */
async function processCase(
  runtime: string,
  fixture: string,
  selected: "SIGINT" | "SIGQUIT" | "SIGTERM"
): Promise<{ readonly exitCode: number; readonly evidence: ProcessEvidence }> {
  const child = Bun.spawn([runtime, fixture, selected], { stdout: "pipe", stderr: "pipe" })
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 2_000)
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ])
  clearTimeout(watchdog)
  if (stderr !== "") {
    throw new Error(`runtime fixture exited ${exitCode}, stdout=${stdout}, stderr=${stderr}`)
  }
  return { exitCode, evidence: JSON.parse(stdout) as ProcessEvidence }
}

test("real Node and Bun signals stop once and release every listener", async () => {
  const directory = await mkdtemp(join(import.meta.dir, "../.artifacts/node-signal-"))
  try {
    const fixture = await buildFixture(directory)
    const node = await processCase("node", fixture, "SIGINT")
    const bun = await processCase(process.execPath, fixture, "SIGTERM")
    const nodeQuit = await processCase("node", fixture, "SIGQUIT")

    expect(node.exitCode).toBe(130)
    expect(bun.exitCode).toBe(143)
    expect(nodeQuit.exitCode).toBe(131)
    for (const result of [node, bun, nodeQuit]) {
      expect(result.evidence).toEqual({
        stops: 1,
        interruptListenerDelta: 0,
        quitListenerDelta: 0,
        terminateListenerDelta: 0
      })
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
