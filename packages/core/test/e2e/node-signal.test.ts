import { expect, test } from "bun:test"
import { constants } from "node:os"
import { resolve } from "node:path"

test("a failed real Node signal installation rolls back earlier listeners", async () => {
  const fixture = resolve(import.meta.dir, "fixtures/signal-install.ts")
  const child = Bun.spawn(["node", "--import", "tsx", fixture], {
    stdout: "pipe",
    stderr: "pipe"
  })

  expect(await child.exited).toBe(0)
  expect(await new Response(child.stderr).text()).toBe("")
  expect(JSON.parse(await new Response(child.stdout).text())).toEqual({
    rejected: true,
    listenerDelta: 0
  })
})

test("a second real signal uses the Node default while graceful stop is blocked", async () => {
  const fixture = resolve(import.meta.dir, "fixtures/signal-force.ts")
  const child = Bun.spawn(["node", "--import", "tsx", fixture], {
    stdout: "pipe",
    stderr: "pipe"
  })
  const ready = Promise.withResolvers<void>()
  const stopping = Promise.withResolvers<void>()
  const observeOutput = (async () => {
    const reader = child.stdout.getReader()
    const decoder = new TextDecoder()
    let text = ""
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) return
      text += decoder.decode(chunk.value, { stream: true })
      if (text.includes("ready\n")) ready.resolve()
      if (text.includes("stopping\n")) stopping.resolve()
    }
  })()
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 2_000)
  try {
    await ready.promise
    child.kill("SIGTERM")
    await stopping.promise
    child.kill("SIGTERM")
    expect(await child.exited).toBe(128 + constants.signals.SIGTERM)
    expect(await new Response(child.stderr).text()).toBe("")
    await observeOutput
  } finally {
    clearTimeout(watchdog)
    child.kill("SIGKILL")
  }
})
