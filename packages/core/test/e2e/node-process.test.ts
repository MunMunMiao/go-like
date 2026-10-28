import { join } from "node:path"

import { expect, test } from "bun:test"

interface ProcessEvidence {
  readonly stops: number
  readonly interruptListenerDelta: number
  readonly quitListenerDelta: number
  readonly terminateListenerDelta: number
}

/** Runs one real operating-system signal case. */
async function processCase(
  runtime: "bun" | "node",
  fixture: string,
  selected: "SIGINT" | "SIGQUIT" | "SIGTERM"
): Promise<{ readonly exitCode: number; readonly evidence: ProcessEvidence }> {
  const command =
    runtime === "node"
      ? ["node", "--import", "tsx", fixture, selected]
      : [process.execPath, fixture, selected]
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" })
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
  const fixture = join(import.meta.dir, "fixtures/signal-process.ts")
  const node = await processCase("node", fixture, "SIGINT")
  const bun = await processCase("bun", fixture, "SIGTERM")
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
})
