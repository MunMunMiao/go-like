import { expect, test } from "bun:test"
import { getEventListeners } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { newDockerOwner, runCheckedCommand, runCommand } from "./suites"

const fixture = (name: string): string => join(import.meta.dir, "fixtures", "runner", name)

/** Returns whether one process identifier still belongs to a running, non-zombie process. */
async function processIsRunning(processId: number): Promise<boolean> {
  try {
    process.kill(processId, 0)
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH")
  }
  if (process.platform !== "linux") return true
  try {
    const stat = await Bun.file(`/proc/${processId}/stat`).text()
    const commandEnd = stat.lastIndexOf(")")
    return commandEnd < 0 || stat.slice(commandEnd + 2, commandEnd + 3) !== "Z"
  } catch {
    return false
  }
}

/** Waits briefly for the operating system to reap a force-terminated descendant. */
async function waitForProcessExit(processId: number): Promise<void> {
  const deadline = performance.now() + 2_000
  while ((await processIsRunning(processId)) && performance.now() < deadline) await Bun.sleep(25)
}

test("runCommand passes one child-only Docker owner without mutating the parent", async () => {
  const owner = newDockerOwner("owner-env-test")
  const controller = new AbortController()
  const listenerBaseline = getEventListeners(controller.signal, "abort").length
  const before = process.env.LIKEGO_E2E_OWNER
  const result = await runCommand(import.meta.dir, {
    cwd: ".",
    command: [process.execPath, fixture("environment.ts")],
    timeoutMs: 2_000,
    environment: { LIKEGO_E2E_OWNER: owner },
    signal: controller.signal
  })
  expect(result).toMatchObject({ exitCode: 0, stdout: owner, stderr: "captured", timedOut: false })
  expect(process.env.LIKEGO_E2E_OWNER).toBe(before)
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(listenerBaseline)
})

test("runCommand exposes only sanitized stream callbacks", async () => {
  const secret = "run-command-stream-callback-secret"
  let streamed = ""
  const result = await runCommand(import.meta.dir, {
    cwd: ".",
    command: [process.execPath, fixture("diagnostics.ts"), "failure"],
    environment: { LIKEGO_E2E_CANARY: secret },
    knownSecrets: [secret],
    timeoutMs: 2_000,
    onStdout(value) {
      streamed += value
    },
    onStderr(value) {
      streamed += value
    }
  })
  expect(result.exitCode).toBe(17)
  expect(streamed).not.toContain(secret)
  expect(streamed).toContain("<redacted>")
})

test("runCommand redacts captured and forwarded output before exposing it", async () => {
  const secret = "run-command-canary-secret"
  const capture = await runCommand(import.meta.dir, {
    cwd: ".",
    command: [process.execPath, fixture("diagnostics.ts"), "failure"],
    environment: { LIKEGO_E2E_CANARY: secret },
    knownSecrets: [secret],
    timeoutMs: 2_000
  })
  expect(capture).toMatchObject({
    exitCode: 17,
    signal: null,
    termination: "exit",
    timedOut: false,
    abortReason: null,
    containment: "not-claimed",
    residual: "zero-observed"
  })
  expect(`${capture.stdout}${capture.stderr}`).not.toContain(secret)
  expect(capture.stdout).toContain("token=<redacted>")
  expect(capture.stderr).toContain("-eLIKEGO_TOKEN=<redacted>")

  const forwarded = await runCommand(import.meta.dir, {
    cwd: ".",
    command: [process.execPath, fixture("forward-diagnostics.ts")],
    environment: { LIKEGO_E2E_CANARY: secret },
    knownSecrets: [secret],
    timeoutMs: 5_000
  })
  expect(forwarded.exitCode).toBe(0)
  expect(`${forwarded.stdout}${forwarded.stderr}`).not.toContain(secret)
  expect(forwarded.stdout).toContain("RESULT=")
  expect(forwarded.stdout).toContain("<redacted>")
})

test("runCommand records signal termination without manufacturing an exit code", async () => {
  if (process.platform === "win32") return
  const result = await runCommand(import.meta.dir, {
    cwd: ".",
    command: ["/bin/sh", "-c", "kill -TERM $$"],
    timeoutMs: 2_000
  })
  expect(result).toMatchObject({
    exitCode: null,
    signal: "SIGTERM",
    termination: "signal",
    timedOut: false,
    abortReason: null,
    containment: "not-claimed",
    residual: "zero-observed"
  })
})

test("runCommand preserves an in-flight abort reason and terminates the complete tree", async () => {
  const directory = await mkdtemp(join(tmpdir(), "likego-e2e-abort-tree-"))
  const processIdPath = join(directory, "descendant.pid")
  const readyPath = join(directory, "descendant.ready")
  const controller = new AbortController()
  const reason = Object.freeze({ code: "IN_FLIGHT_ABORT" })
  const listenerBaseline = getEventListeners(controller.signal, "abort").length
  let descendantPid: number | null = null
  const running = runCommand(import.meta.dir, {
    cwd: ".",
    command: [process.execPath, fixture("tree-parent.ts"), "wait", processIdPath, readyPath],
    timeoutMs: 5_000,
    signal: controller.signal
  })
  try {
    const readyDeadline = performance.now() + 2_000
    while (!(await Bun.file(readyPath).exists()) && performance.now() < readyDeadline) {
      await Bun.sleep(5)
    }
    expect(await Bun.file(readyPath).exists()).toBe(true)
    descendantPid = Number(await Bun.file(processIdPath).text())
    controller.abort(reason)
    let failure: unknown = null
    try {
      await running
    } catch (error) {
      failure = error
    }
    expect(failure).toBe(reason)
    expect(Number.isInteger(descendantPid)).toBe(true)
    await waitForProcessExit(descendantPid)
    expect(await processIsRunning(descendantPid)).toBe(false)
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(listenerBaseline)
  } finally {
    controller.abort(reason)
    await running.catch(() => {})
    if (descendantPid !== null && (await processIsRunning(descendantPid))) {
      process.kill(descendantPid, "SIGKILL")
    }
    await rm(directory, { recursive: true, force: true })
  }
}, 8_000)

test("runCommand terminates a descendant that inherits stdout and ignores SIGTERM", async () => {
  const directory = await mkdtemp(join(tmpdir(), "likego-e2e-inherited-output-"))
  const processIdPath = join(directory, "descendant.pid")
  const readyPath = join(directory, "descendant.ready")
  const startedAt = performance.now()
  const controller = new AbortController()
  const listenerBaseline = getEventListeners(controller.signal, "abort").length
  let descendantPid: number | null = null
  try {
    const result = await runCommand(import.meta.dir, {
      cwd: ".",
      command: [process.execPath, fixture("tree-parent.ts"), "inherit", processIdPath, readyPath],
      timeoutMs: 250,
      signal: controller.signal
    })
    const match = /DESCENDANT_PID=(\d+)/.exec(result.stdout)
    descendantPid = match === null ? null : Number(match[1])
    expect(result).toMatchObject({
      signal: null,
      termination: "timeout",
      timedOut: true,
      abortReason: null,
      containment: "not-claimed",
      residual: "zero-observed"
    })
    expect(result.stdout).toContain("DESCENDANT_READY")
    expect(descendantPid).not.toBeNull()
    expect(performance.now() - startedAt).toBeLessThan(8_000)
    if (descendantPid !== null) {
      await waitForProcessExit(descendantPid)
      expect(await processIsRunning(descendantPid)).toBe(false)
    }
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(listenerBaseline)
  } finally {
    if (descendantPid !== null && (await processIsRunning(descendantPid))) {
      process.kill(descendantPid, "SIGKILL")
    }
    await rm(directory, { recursive: true, force: true })
  }
}, 12_000)

test("runCommand rejects and terminates a silent descendant after its parent exits cleanly", async () => {
  if (process.platform === "win32") return
  const directory = await mkdtemp(join(tmpdir(), "likego-e2e-process-tree-"))
  const processIdPath = join(directory, "descendant.pid")
  const readyPath = join(directory, "descendant.ready")
  let descendantPid: number | null = null
  try {
    let failure: unknown = null
    try {
      await runCommand(import.meta.dir, {
        cwd: ".",
        command: [process.execPath, fixture("tree-parent.ts"), "exit", processIdPath, readyPath],
        timeoutMs: 5_000
      })
    } catch (error) {
      failure = error
    }
    descendantPid = Number(await Bun.file(processIdPath).text())
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).toContain("descendant processes remained")
    expect(Number.isInteger(descendantPid)).toBe(true)
    await waitForProcessExit(descendantPid)
    expect(await processIsRunning(descendantPid)).toBe(false)
  } finally {
    if (descendantPid !== null && (await processIsRunning(descendantPid))) {
      process.kill(descendantPid, "SIGKILL")
    }
    await rm(directory, { recursive: true, force: true })
  }
}, 12_000)

test("checked infrastructure commands reject a permanent process inside a bounded owner", async () => {
  const startedAt = performance.now()
  await expect(
    runCheckedCommand(import.meta.dir, [process.execPath, fixture("permanent.ts")], 250)
  ).rejects.toThrow("command exceeded 250ms")
  expect(performance.now() - startedAt).toBeLessThan(8_000)
}, 12_000)
