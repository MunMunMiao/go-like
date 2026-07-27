import process from "node:process"
import { constants } from "node:os"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import { expect, spyOn, test } from "bun:test"

import { beforeStart, newApp, server, type Server } from "../src/index"
import { signal } from "../src/node"
import { deferred, turn } from "./helpers"

test("signal option installs and removes only App-owned process listeners", async () => {
  const before = {
    interrupt: process.listenerCount("SIGINT"),
    quit: process.listenerCount("SIGQUIT"),
    terminate: process.listenerCount("SIGTERM")
  }
  const done = deferred<void>()
  const subject: Server = {
    async start() {
      await done.promise
    },
    async stop() {
      done.resolve()
    }
  }
  const app = newApp(signal(), server(subject))
  const running = app.run()
  await turn()

  expect(process.listenerCount("SIGINT")).toBe(before.interrupt + 1)
  expect(process.listenerCount("SIGQUIT")).toBe(before.quit + 1)
  expect(process.listenerCount("SIGTERM")).toBe(before.terminate + 1)

  await app.stop()
  await running
  expect(process.listenerCount("SIGINT")).toBe(before.interrupt)
  expect(process.listenerCount("SIGQUIT")).toBe(before.quit)
  expect(process.listenerCount("SIGTERM")).toBe(before.terminate)
})

test("signal option deduplicates explicit signal names", async () => {
  const before = process.listenerCount("SIGTERM")
  const app = newApp(signal("SIGTERM", "SIGTERM"))
  const running = app.run()
  await turn()
  expect(process.listenerCount("SIGTERM")).toBe(before + 1)
  await app.stop()
  await running
  expect(process.listenerCount("SIGTERM")).toBe(before)
})

test("signal listener is active during asynchronous startup and removed after shutdown", async () => {
  const previousExitCode = process.exitCode
  const before = process.listenerCount("SIGUSR2")
  const entered = deferred<void>()
  const release = deferred<void>()
  let starts = 0
  const app = newApp(
    signal("SIGUSR2"),
    beforeStart(async () => {
      entered.resolve()
      await release.promise
    }),
    server({
      async start() {
        starts += 1
      },
      async stop() {}
    })
  )

  const running = app.run()
  await entered.promise
  expect(process.listenerCount("SIGUSR2")).toBe(before + 1)
  process.emit("SIGUSR2", "SIGUSR2")
  release.resolve()
  await running

  expect(starts).toBe(0)
  expect(process.listenerCount("SIGUSR2")).toBe(before)
  process.exitCode = previousExitCode ?? 0
})

test("an emitted process signal delegates to App.stop and preserves conventional exit codes", async () => {
  const previousExitCode = process.exitCode
  const before = process.listenerCount("SIGUSR2")
  const done = deferred<void>()
  let stops = 0
  const app = newApp(
    signal("SIGUSR2"),
    server({
      async start() {
        await done.promise
      },
      async stop() {
        stops += 1
        done.resolve()
      }
    })
  )
  const running = app.run()
  await turn()
  process.emit("SIGUSR2", "SIGUSR2")
  expect(process.listenerCount("SIGUSR2")).toBe(before)
  process.emit("SIGUSR2", "SIGUSR2")
  await running

  expect(stops).toBe(1)
  expect(process.exitCode).toBe(128 + constants.signals.SIGUSR2)
  process.exitCode = previousExitCode ?? 0
})

test("signal installation rolls back when the host rejects a later signal", async () => {
  const before = process.listeners("SIGUSR2")
  const installFailure = new Error("host rejected signal")
  const nativeOn = process.on.bind(process)
  const rejectLaterSignal = (
    ...parameters: Parameters<typeof nativeOn>
  ): ReturnType<typeof nativeOn> => {
    const [eventName, listener] = parameters
    if (eventName === "SIGKILL") throw installFailure
    return nativeOn(eventName, listener)
  }
  const installation = spyOn(process, "on").mockImplementation(rejectLaterSignal)

  try {
    await expect(newApp(signal("SIGUSR2", "SIGKILL")).run()).rejects.toBe(installFailure)
    expect(process.listeners("SIGUSR2")).toEqual(before)
  } finally {
    installation.mockRestore()
    for (const listener of process.listeners("SIGUSR2")) {
      if (!before.includes(listener)) process.off("SIGUSR2", listener)
    }
  }
})

test("a failed real Node signal installation rolls back earlier listeners", async () => {
  const directory = await mkdtemp(join(import.meta.dir, "../.artifacts/node-signal-install-"))
  try {
    const entry = join(directory, "signal-install-fixture.ts")
    const sourceRoot = resolve(import.meta.dir, "../src")
    await writeFile(
      entry,
      `import process from "node:process"
import { newApp } from ${JSON.stringify(join(sourceRoot, "index.ts"))}
import { signal } from ${JSON.stringify(join(sourceRoot, "node.ts"))}

const before = process.listenerCount("SIGUSR2")
let rejected = false
try {
  await newApp(signal("SIGUSR2", "SIGKILL")).run()
} catch {
  rejected = true
}
process.stdout.write(JSON.stringify({
  rejected,
  listenerDelta: process.listenerCount("SIGUSR2") - before
}))
`
    )
    const child = Bun.spawn(["node", "--import", "tsx", entry], {
      stdout: "pipe",
      stderr: "pipe"
    })

    expect(await child.exited).toBe(0)
    expect(await new Response(child.stderr).text()).toBe("")
    expect(JSON.parse(await new Response(child.stdout).text())).toEqual({
      rejected: true,
      listenerDelta: 0
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("a second real signal uses the Node default while graceful stop is blocked", async () => {
  const directory = await mkdtemp(join(import.meta.dir, "../.artifacts/node-signal-force-"))
  try {
    const entry = join(directory, "signal-force-fixture.ts")
    const sourceRoot = resolve(import.meta.dir, "../src")
    await writeFile(
      entry,
      `import process from "node:process"
import { newApp, server } from ${JSON.stringify(join(sourceRoot, "index.ts"))}
import { signal } from ${JSON.stringify(join(sourceRoot, "node.ts"))}

const blocked = Promise.withResolvers()
const app = newApp(signal("SIGTERM"), server({
  async start() {
    process.stdout.write("ready\\n")
    await blocked.promise
  },
  async stop() {
    process.stdout.write("stopping\\n")
    await blocked.promise
  }
}))
void app.run().catch(() => {})
setInterval(() => {}, 1_000)
`
    )
    const child = Bun.spawn(["node", "--import", "tsx", entry], {
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
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("a signal-driven stop failure changes the eventual exit code to one", async () => {
  const previousExitCode = process.exitCode
  const stopFailure = new Error("stop failed")
  const app = newApp(
    signal("SIGUSR2"),
    server({
      async start(ctx) {
        await new Promise<void>((resolve) => {
          ctx.done()?.addEventListener("abort", () => resolve(), { once: true })
        })
      },
      async stop() {
        throw stopFailure
      }
    })
  )
  const running = app.run()
  await turn()
  process.emit("SIGUSR2", "SIGUSR2")
  await expect(running).rejects.toBe(stopFailure)
  await turn()
  expect(process.exitCode).toBe(1)
  process.exitCode = previousExitCode ?? 0
})

test("validates signal names and handles host-specific event names", async () => {
  expect(() => signal("" as never)).toThrow(TypeError)
  const previousExitCode = process.exitCode
  const app = newApp(signal("LIKEGO_TEST_SIGNAL" as never))
  const running = app.run()
  await turn()
  process.emit("LIKEGO_TEST_SIGNAL" as never)
  await running
  expect(process.exitCode).toBe(1)
  process.exitCode = previousExitCode ?? 0
})
