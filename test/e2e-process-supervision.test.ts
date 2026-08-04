import { expect, test } from "bun:test"
import { getEventListeners } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import type { SuiteDefinition } from "../e2e/definitions"
import { runE2eRequest } from "../e2e/executor"
import {
  createProcessSupervisor,
  decodePosixControllerFrame,
  encodePosixControllerFrame,
  type CommandDefinition,
  type CommandResult,
  type ProcessPreflightResult,
  type ProcessSupervisor
} from "../e2e/harness/process"
import { RequiredRuntimeVersions } from "../e2e/runtime-versions"

const Root = resolve(import.meta.dir, "..")
const RunnerFixtures = resolve(Root, "e2e/fixtures/runner")
const runnerFixture = (name: string): string => join(RunnerFixtures, name)

async function nativeSupervisor(): Promise<ProcessSupervisor> {
  if (process.platform === "win32") throw new Error("POSIX supervisor fixture is unavailable")
  const supervisor = await createProcessSupervisor("managed", Root)
  await supervisor.preflight()
  return supervisor
}

interface PosixFinalizedEvidence {
  readonly termSent: boolean
  readonly killRounds: number
}

function posixU32(payload: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > payload.byteLength) {
    throw new Error("POSIX test payload is truncated")
  }
  return new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(offset)
}

function posixPreparePayload(command: readonly string[]): Uint8Array {
  const encoder = new TextEncoder()
  const chunks: Uint8Array[] = []
  const u32 = (value: number): void => {
    const bytes = new Uint8Array(4)
    new DataView(bytes.buffer).setUint32(0, value)
    chunks.push(bytes)
  }
  const string = (value: string): void => {
    const bytes = encoder.encode(value)
    u32(bytes.byteLength)
    chunks.push(bytes)
  }
  u32(1)
  u32(command.length)
  u32(0)
  string(Root)
  for (const argument of command) string(argument)
  const payload = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    payload.set(chunk, offset)
    offset += chunk.byteLength
  }
  return payload
}

async function readPosixFrameForTest(
  reader: ReadableStreamDefaultReader<Uint8Array<ArrayBufferLike>>,
  buffered: { value: Uint8Array<ArrayBufferLike> }
): Promise<ReturnType<typeof decodePosixControllerFrame>> {
  while (true) {
    if (buffered.value.byteLength >= 4) {
      const bodyLength = new DataView(
        buffered.value.buffer,
        buffered.value.byteOffset,
        buffered.value.byteLength
      ).getUint32(0)
      const wireLength = 4 + bodyLength
      if (buffered.value.byteLength >= wireLength) {
        const wire = buffered.value.slice(0, wireLength)
        buffered.value = buffered.value.slice(wireLength)
        return decodePosixControllerFrame(wire)
      }
    }
    const chunk = await reader.read()
    if (chunk.done) throw new Error("POSIX test protocol ended before the expected frame")
    const combined = new Uint8Array(buffered.value.byteLength + chunk.value.byteLength)
    combined.set(buffered.value)
    combined.set(chunk.value, buffered.value.byteLength)
    buffered.value = combined
  }
}

async function nativePosixTerminationEvidence(
  helperPath: string,
  requestType: 0x0004 | 0x0008
): Promise<PosixFinalizedEvidence> {
  const controller = Bun.spawn([helperPath], {
    cwd: Root,
    stdin: "pipe",
    stdout: "ignore",
    stderr: "pipe",
    stdio: ["pipe", "ignore", "pipe", "pipe", "pipe", "ignore"]
  })
  const protocolFd = controller.stdio[3]
  const targetStdoutFd = controller.stdio[4]
  if (
    protocolFd === null ||
    protocolFd === undefined ||
    targetStdoutFd === null ||
    targetStdoutFd === undefined
  ) {
    controller.kill("SIGKILL")
    throw new Error("POSIX test controller protocol/output fd was not created")
  }
  const reader = Bun.file(protocolFd).stream().getReader()
  const targetStdout = Bun.file(targetStdoutFd).stream().getReader()
  const buffered: { value: Uint8Array<ArrayBufferLike> } = { value: new Uint8Array() }
  const writer = controller.stdin
  let nonce: Uint8Array<ArrayBufferLike> = new Uint8Array(32)
  const send = async (
    type: number,
    requestId: bigint,
    payload: Uint8Array<ArrayBufferLike> = new Uint8Array()
  ): Promise<void> => {
    writer.write(encodePosixControllerFrame({ type, flags: 0, requestId, nonce, payload }))
    await writer.flush()
  }
  try {
    const ready = await readPosixFrameForTest(reader, buffered)
    expect(ready.type).toBe(0x8001)
    nonce = ready.nonce
    await send(
      0x0001,
      1n,
      posixPreparePayload([
        "/bin/sh",
        "-c",
        "trap '' TERM; printf ready; while :; do sleep 1; done"
      ])
    )
    const anchorReady = await readPosixFrameForTest(reader, buffered)
    expect(anchorReady.type).toBe(0x8002)
    await send(0x0002, 2n)
    const started = await readPosixFrameForTest(reader, buffered)
    expect(started.type).toBe(0x8003)
    const readyOutput = await targetStdout.read()
    expect(readyOutput.done).toBe(false)
    expect(new TextDecoder().decode(readyOutput.value)).toContain("ready")
    await send(requestType, 3n)
    let finalized = await readPosixFrameForTest(reader, buffered)
    while (finalized.type === 0x8004) finalized = await readPosixFrameForTest(reader, buffered)
    expect(finalized.type).toBe(0x8005)
    expect(finalized.requestId).toBe(3n)
    const evidence = Object.freeze({
      termSent: posixU32(finalized.payload, 4) === 1,
      killRounds: posixU32(finalized.payload, 8)
    })
    await send(0x0007, 4n)
    const closed = await readPosixFrameForTest(reader, buffered)
    expect(closed.type).toBe(0x8008)
    await writer.end()
    expect(await controller.exited).toBe(0)
    return evidence
  } finally {
    await Promise.resolve(writer.end()).catch(() => {})
    await Promise.allSettled([reader.cancel(), targetStdout.cancel()])
    if (controller.exitCode === null) controller.kill("SIGKILL")
    await controller.exited.catch(() => {})
  }
}

interface TestHookSupervisorFixture {
  readonly supervisor: ProcessSupervisor
  readonly artifactDirectory: string
  readonly nativeHelperPath: string
  readonly closeNativeSupervisor: () => Promise<void>
}

async function testHookNativeSupervisor(): Promise<TestHookSupervisorFixture> {
  if (process.platform !== "darwin") {
    throw new Error("macOS native test-hook supervisor fixture is unavailable")
  }
  const artifactDirectory = await mkdtemp(join(tmpdir(), "go-like-e2e-posix-test-hooks-"))
  try {
    const source = resolve(Root, "e2e/harness/native/go-like_e2e_posix_controller.c")
    const binary = join(artifactDirectory, "controller")
    const compile = Bun.spawnSync(
      [
        "/usr/bin/cc",
        "-std=c11",
        "-O2",
        "-Wall",
        "-Wextra",
        "-Wpedantic",
        "-Werror",
        "-DGO_LIKE_E2E_TEST_HOOKS",
        source,
        "-o",
        binary
      ],
      { stdout: "pipe", stderr: "pipe" }
    )
    if (compile.exitCode !== 0) throw new Error(compile.stderr.toString())
    const nativeSupervisor = await createProcessSupervisor("managed", Root, {
      compileNativeHelper: async () => binary
    })
    await nativeSupervisor.preflight()
    const supervisor: ProcessSupervisor = Object.freeze({
      mode: nativeSupervisor.mode,
      preflight: () => nativeSupervisor.preflight(),
      run: (root: string, definition: CommandDefinition) => nativeSupervisor.run(root, definition),
      async close(): Promise<void> {
        let primary: unknown = null
        try {
          await nativeSupervisor.close()
        } catch (error) {
          primary = error
        }
        try {
          await rm(artifactDirectory, { recursive: true, force: true })
        } catch (cleanupError) {
          if (primary !== null) {
            throw new AggregateError(
              [primary, cleanupError],
              "test-hook supervisor close and artifact cleanup failed"
            )
          }
          throw cleanupError
        }
        if (primary !== null) throw primary
      }
    })
    return Object.freeze({
      supervisor,
      artifactDirectory,
      nativeHelperPath: binary,
      closeNativeSupervisor: () => nativeSupervisor.close()
    })
  } catch (error) {
    try {
      await rm(artifactDirectory, { recursive: true, force: true })
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "test-hook supervisor setup and artifact cleanup failed"
      )
    }
    throw error
  }
}

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

async function waitForProcessExit(processId: number): Promise<void> {
  const deadline = performance.now() + 2_000
  while ((await processIsRunning(processId)) && performance.now() < deadline) await Bun.sleep(25)
}

async function processCommand(processId: number): Promise<string | null> {
  const result = Bun.spawnSync(["/bin/ps", "-p", String(processId), "-o", "command="])
  if (result.exitCode !== 0) return null
  const command = result.stdout.toString().trim()
  return command.length === 0 ? null : command
}

async function terminateForkStormFixture(processIdPath: string, directory: string): Promise<void> {
  if (!(await Bun.file(processIdPath).exists())) return
  const processIds = Array.from(
    new Set(
      (await Bun.file(processIdPath).text())
        .split("\n")
        .map(Number)
        .filter((value) => Number.isSafeInteger(value) && value > 0)
    )
  )
  const fixturePaths = [runnerFixture("fork-storm.ts"), runnerFixture("persistent.ts")]
  for (const processId of processIds.reverse()) {
    const command = await processCommand(processId)
    if (command === null) continue
    if (!command.includes(directory) || !fixturePaths.some((path) => command.includes(path))) {
      throw new Error(`refusing to terminate unrecognized fork-storm PID ${processId}`)
    }
    try {
      process.kill(processId, "SIGKILL")
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error
    }
  }
}

const Definition: SuiteDefinition = Object.freeze({
  id: "supervision-fixture",
  tags: Object.freeze(["registered"] as const),
  defaultScopes: Object.freeze(["suites"] as const),
  includeInAll: true,
  cwd: ".",
  command: Object.freeze(["bun", "fixture"]),
  timeoutMs: 10_000,
  requiredTools: Object.freeze(["bun"] as const),
  requiresDocker: false,
  dockerOwnership: "none"
})

function commandResult(overrides: Partial<CommandResult> = Object.freeze({})): CommandResult {
  return Object.freeze({
    exitCode: 0,
    signal: null,
    termination: "exit",
    timedOut: false,
    abortReason: null,
    durationMs: 7,
    stdout: "",
    stderr: "",
    cleanupFailures: Object.freeze([]),
    containment: "not-claimed",
    residual: "zero-observed",
    ...overrides
  })
}

function syntheticSupervisor(
  run: (root: string, definition: CommandDefinition) => Promise<CommandResult>,
  close: () => Promise<void> = async () => {}
): ProcessSupervisor {
  const preflight: ProcessPreflightResult = Object.freeze({
    processMode: "managed",
    strategy: "posix-anchored-best-effort",
    containment: "not-claimed",
    cgroupV2: "n/a"
  })
  return Object.freeze({
    mode: "managed",
    async preflight() {
      return preflight
    },
    run,
    close
  })
}

test("POSIX controller frames round-trip and reject malformed lengths", () => {
  const nonce = new Uint8Array(32).fill(7)
  const wire = encodePosixControllerFrame({
    type: 0x0005,
    flags: 0,
    requestId: 42n,
    nonce,
    payload: new Uint8Array([1, 2, 3])
  })
  expect(decodePosixControllerFrame(wire)).toEqual({
    type: 0x0005,
    flags: 0,
    requestId: 42n,
    nonce,
    payload: new Uint8Array([1, 2, 3])
  })
  expect(() => decodePosixControllerFrame(wire.slice(0, -1))).toThrow("does not match")
  expect(() =>
    encodePosixControllerFrame({
      type: 1,
      flags: 0,
      requestId: 1n,
      nonce: new Uint8Array(31),
      payload: new Uint8Array()
    })
  ).toThrow("nonce must be 32 bytes")
})

test("invocation supervisor requires preflight and rejects use after close", async () => {
  let runs = 0
  const supervisor = await createProcessSupervisor("managed", "/repo", {
    run: async () => {
      runs += 1
      return commandResult()
    },
    compileNativeHelper: async () => "/repo/helper"
  })
  const definition: CommandDefinition = {
    cwd: ".",
    command: ["bun", "fixture"],
    timeoutMs: 1_000
  }
  await expect(supervisor.run("/repo", definition)).rejects.toThrow("before preflight")
  const first = await supervisor.preflight()
  expect(await supervisor.preflight()).toBe(first)
  await supervisor.run("/repo", definition)
  expect(runs).toBe(1)
  await supervisor.close()
  await expect(supervisor.run("/repo", definition)).rejects.toThrow("is closed")
  await expect(supervisor.preflight()).rejects.toThrow("is closed")
})

test("native POSIX supervisor rejects controller-only target environment overrides", async () => {
  if (process.platform === "win32") return
  const supervisor = await nativeSupervisor()
  try {
    await expect(
      supervisor.run(Root, {
        cwd: ".",
        command: [process.execPath, "-e", "process.exit(0)"],
        environment: { GO_LIKE_E2E_CGROUP_PARENT: "/should/not/reach/target" },
        timeoutMs: 2_000
      })
    ).rejects.toThrow("controller-only key GO_LIKE_E2E_CGROUP_PARENT")
  } finally {
    await supervisor.close()
  }
}, 10_000)

test("native POSIX supervisor strips controller-only ambient environment from targets", async () => {
  if (process.platform === "win32") return
  const original = process.env.GO_LIKE_E2E_CGROUP_PARENT
  const supervisor = await nativeSupervisor()
  try {
    process.env.GO_LIKE_E2E_CGROUP_PARENT = "/synthetic/delegated/parent"
    const result = await supervisor.run(Root, {
      cwd: ".",
      command: [
        process.execPath,
        "-e",
        "console.log(process.env.GO_LIKE_E2E_CGROUP_PARENT ?? 'controller-only-absent')"
      ],
      timeoutMs: 2_000
    })
    expect(result).toMatchObject({
      exitCode: 0,
      termination: "exit",
      residual: "zero-observed"
    })
    expect(result.stdout.trim()).toBe("controller-only-absent")
  } finally {
    if (original === undefined) delete process.env.GO_LIKE_E2E_CGROUP_PARENT
    else process.env.GO_LIKE_E2E_CGROUP_PARENT = original
    await supervisor.close()
  }
}, 10_000)

test("generic example direct script resolves supervisor assets from the repository root", async () => {
  if (process.platform === "win32") return
  const child = Bun.spawn([process.execPath, "run", "test:e2e"], {
    cwd: resolve(Root, "examples/retail-inventory-reservation"),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
    killSignal: "SIGKILL"
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ])
  expect(exitCode).toBe(0)
  expect(`${stdout}\n${stderr}`).not.toContain("prerequisite-native-helper-build-failed")
}, 35_000)

test("native POSIX supervisor bounds a helper that never sends CONTROLLER_READY", async () => {
  if (process.platform === "win32") return
  let targetStarted = false
  const supervisor = await createProcessSupervisor("managed", Root, {
    compileNativeHelper: async () => "/bin/cat"
  })
  try {
    await supervisor.preflight()
    const startedAt = performance.now()
    await expect(
      supervisor.run(Root, {
        cwd: ".",
        command: [process.execPath, "-e", "process.exit(0)"],
        timeoutMs: 10_000,
        onStdout() {
          targetStarted = true
        }
      })
    ).rejects.toThrow("CONTROLLER_READY exceeded the 5000ms protocol budget")
    expect(targetStarted).toBe(false)
    expect(performance.now() - startedAt).toBeLessThan(7_000)
  } finally {
    await supervisor.close()
  }
}, 10_000)

test("synthetic supervisor preserves termination policy definitions", async () => {
  const observed: (CommandDefinition["terminationPolicy"] | undefined)[] = []
  const supervisor = await createProcessSupervisor("managed", "/repo", {
    run: async (_root, definition) => {
      observed.push(definition.terminationPolicy)
      return commandResult()
    },
    compileNativeHelper: async () => "/repo/helper"
  })
  try {
    await supervisor.preflight()
    const base = { cwd: ".", command: ["bun", "fixture"], timeoutMs: 1_000 } as const
    await supervisor.run("/repo", base)
    await supervisor.run("/repo", { ...base, terminationPolicy: "combined" })
    await supervisor.run("/repo", { ...base, terminationPolicy: "hard-only" })
    expect(observed).toEqual([undefined, "combined", "hard-only"])
  } finally {
    await supervisor.close()
  }
})

test("native POSIX supervisor preserves argv, environment, output, and natural exit", async () => {
  if (process.platform === "win32") return
  const supervisor = await nativeSupervisor()
  const secret = "native-supervisor-secret"
  let streamed = ""
  try {
    const result = await supervisor.run(Root, {
      cwd: ".",
      command: [process.execPath, runnerFixture("diagnostics.ts"), "failure"],
      environment: { GO_LIKE_E2E_CANARY: secret },
      knownSecrets: [secret],
      timeoutMs: 2_000,
      onStdout: (value) => {
        streamed += value
      },
      onStderr: (value) => {
        streamed += value
      }
    })
    expect(result).toMatchObject({
      exitCode: 17,
      signal: null,
      termination: "exit",
      timedOut: false,
      abortReason: null,
      containment: "not-claimed",
      residual: "zero-observed"
    })
    expect(result.cleanupFailures).toEqual([])
    expect(`${result.stdout}${result.stderr}${streamed}`).not.toContain(secret)
    expect(`${result.stdout}${result.stderr}${streamed}`).toContain("<redacted>")
    expect(result.durationMs).toBeLessThan(2_000)
  } finally {
    await supervisor.close()
  }
}, 10_000)

test("native POSIX supervisor terminates after a streaming callback failure", async () => {
  if (process.platform === "win32") return
  const supervisor = await nativeSupervisor()
  try {
    const startedAt = performance.now()
    const result = await supervisor.run(Root, {
      cwd: ".",
      command: [
        "/bin/sh",
        "-c",
        "printf 'callback-ready\\n'; trap '' TERM; while :; do sleep 1; done"
      ],
      timeoutMs: 5_000,
      onStdout() {
        throw new Error("synthetic stream callback failure")
      }
    })
    expect(result).toMatchObject({
      exitCode: null,
      signal: null,
      termination: "supervisor-error",
      timedOut: false,
      abortReason: "Error: synthetic stream callback failure",
      containment: "not-claimed",
      residual: "zero-observed"
    })
    expect(performance.now() - startedAt).toBeLessThan(5_000)
  } finally {
    await supervisor.close()
  }
}, 10_000)

test("native POSIX supervisor reports exec failure without waiting for TARGET_STARTED", async () => {
  if (process.platform === "win32") return
  const supervisor = await nativeSupervisor()
  try {
    const result = await supervisor.run(Root, {
      cwd: ".",
      command: ["/definitely/missing/go-like-e2e-executable"],
      timeoutMs: 2_000
    })
    expect(result).toMatchObject({
      exitCode: null,
      signal: null,
      termination: "supervisor-error",
      timedOut: false,
      abortReason: null,
      containment: "not-claimed",
      residual: "zero-observed"
    })
    expect(result.durationMs).toBeLessThan(2_000)
  } finally {
    await supervisor.close()
  }
}, 10_000)

test("native POSIX supervisor reports target signal termination", async () => {
  if (process.platform === "win32") return
  const supervisor = await nativeSupervisor()
  try {
    const result = await supervisor.run(Root, {
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
  } finally {
    await supervisor.close()
  }
}, 10_000)

test("native POSIX supervisor times out and removes an inherited-pipe descendant", async () => {
  if (process.platform === "win32") return
  const directory = await mkdtemp(join(tmpdir(), "go-like-native-timeout-tree-"))
  const processIdPath = join(directory, "descendant.pid")
  const readyPath = join(directory, "descendant.ready")
  const supervisor = await nativeSupervisor()
  let descendantPid: number | null = null
  try {
    const result = await supervisor.run(Root, {
      cwd: ".",
      command: [
        process.execPath,
        runnerFixture("tree-parent.ts"),
        "inherit",
        processIdPath,
        readyPath
      ],
      timeoutMs: 750
    })
    const match = /DESCENDANT_PID=(\d+)/.exec(result.stdout)
    descendantPid = match === null ? null : Number(match[1])
    expect(result).toMatchObject({
      exitCode: null,
      signal: null,
      termination: "timeout",
      timedOut: true,
      abortReason: null,
      containment: "not-claimed",
      residual: "zero-observed"
    })
    expect(result.stdout).toContain("DESCENDANT_READY")
    expect(descendantPid).not.toBeNull()
    if (descendantPid !== null) {
      await waitForProcessExit(descendantPid)
      expect(await processIsRunning(descendantPid)).toBe(false)
    }
  } finally {
    if (descendantPid !== null && (await processIsRunning(descendantPid))) {
      process.kill(descendantPid, "SIGKILL")
    }
    await supervisor.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 12_000)

test("native POSIX timeout defaults to combined and hard-only skips TERM", async () => {
  if (process.platform === "win32") return
  const directory = await mkdtemp(join(tmpdir(), "go-like-native-termination-policy-"))
  const combinedMarker = join(directory, "combined.term")
  const hardOnlyMarker = join(directory, "hard-only.term")
  const supervisor = await nativeSupervisor()
  const command = [
    "/bin/sh",
    "-c",
    "trap 'printf term > \"$TERM_MARKER\"' TERM; printf ready; while :; do sleep 1; done"
  ] as const
  try {
    const combined = await supervisor.run(Root, {
      cwd: ".",
      command,
      environment: { TERM_MARKER: combinedMarker },
      timeoutMs: 750
    })
    const hardOnly = await supervisor.run(Root, {
      cwd: ".",
      command,
      environment: { TERM_MARKER: hardOnlyMarker },
      terminationPolicy: "hard-only",
      timeoutMs: 750
    })
    expect(combined).toMatchObject({ termination: "timeout", residual: "zero-observed" })
    expect(hardOnly).toMatchObject({ termination: "timeout", residual: "zero-observed" })
    expect(combined.stdout).toContain("ready")
    expect(hardOnly.stdout).toContain("ready")
    expect(await Bun.file(combinedMarker).exists()).toBe(true)
    expect(await Bun.file(hardOnlyMarker).exists()).toBe(false)
  } finally {
    await supervisor.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 12_000)

test("native POSIX hard-only abort skips TERM and preserves abort result", async () => {
  if (process.platform === "win32") return
  const directory = await mkdtemp(join(tmpdir(), "go-like-native-hard-only-abort-"))
  const termMarker = join(directory, "term.sent")
  const abortController = new AbortController()
  const supervisor = await nativeSupervisor()
  let ready = false
  const running = supervisor.run(Root, {
    cwd: ".",
    command: [
      "/bin/sh",
      "-c",
      "trap 'printf term > \"$TERM_MARKER\"' TERM; printf ready; while :; do sleep 1; done"
    ],
    environment: { TERM_MARKER: termMarker },
    terminationPolicy: "hard-only",
    signal: abortController.signal,
    timeoutMs: 5_000,
    onStdout(value) {
      if (value.includes("ready")) ready = true
    }
  })
  try {
    const deadline = performance.now() + 2_000
    while (!ready && performance.now() < deadline) await Bun.sleep(5)
    expect(ready).toBe(true)
    abortController.abort("hard-only-abort")
    const result = await running
    expect(result).toMatchObject({
      termination: "abort",
      abortReason: "hard-only-abort",
      residual: "zero-observed"
    })
    expect(await Bun.file(termMarker).exists()).toBe(false)
  } finally {
    abortController.abort("hard-only-abort")
    await running.catch(() => {})
    await supervisor.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 10_000)

test("native POSIX supervisor preserves a structured in-flight abort result", async () => {
  if (process.platform === "win32") return
  const directory = await mkdtemp(join(tmpdir(), "go-like-native-abort-tree-"))
  const processIdPath = join(directory, "descendant.pid")
  const readyPath = join(directory, "descendant.ready")
  const abortController = new AbortController()
  const reason = Object.freeze({ code: "NATIVE_IN_FLIGHT_ABORT" })
  const listenerBaseline = getEventListeners(abortController.signal, "abort").length
  const supervisor = await nativeSupervisor()
  let descendantPid: number | null = null
  const running = supervisor.run(Root, {
    cwd: ".",
    command: [process.execPath, runnerFixture("tree-parent.ts"), "wait", processIdPath, readyPath],
    timeoutMs: 5_000,
    signal: abortController.signal
  })
  try {
    const readyDeadline = performance.now() + 2_000
    while (!(await Bun.file(readyPath).exists()) && performance.now() < readyDeadline) {
      await Bun.sleep(5)
    }
    expect(await Bun.file(readyPath).exists()).toBe(true)
    descendantPid = Number(await Bun.file(processIdPath).text())
    abortController.abort(reason)
    const result = await running
    expect(result).toMatchObject({
      exitCode: null,
      signal: null,
      termination: "abort",
      timedOut: false,
      abortReason: "[object Object]",
      containment: "not-claimed",
      residual: "zero-observed"
    })
    expect(Number.isInteger(descendantPid)).toBe(true)
    await waitForProcessExit(descendantPid)
    expect(await processIsRunning(descendantPid)).toBe(false)
    expect(getEventListeners(abortController.signal, "abort")).toHaveLength(listenerBaseline)
  } finally {
    abortController.abort(reason)
    await running.catch(() => {})
    if (descendantPid !== null && (await processIsRunning(descendantPid))) {
      process.kill(descendantPid, "SIGKILL")
    }
    await supervisor.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 12_000)

test("native POSIX supervisor finalizes a silent descendant after its parent exits", async () => {
  if (process.platform === "win32") return
  const directory = await mkdtemp(join(tmpdir(), "go-like-native-finalize-tree-"))
  const processIdPath = join(directory, "descendant.pid")
  const readyPath = join(directory, "descendant.ready")
  const supervisor = await nativeSupervisor()
  let descendantPid: number | null = null
  try {
    const result = await supervisor.run(Root, {
      cwd: ".",
      command: [
        process.execPath,
        runnerFixture("tree-parent.ts"),
        "exit",
        processIdPath,
        readyPath
      ],
      timeoutMs: 5_000
    })
    descendantPid = Number(await Bun.file(processIdPath).text())
    expect(result).toMatchObject({
      exitCode: 0,
      signal: null,
      termination: "exit",
      timedOut: false,
      containment: "not-claimed",
      residual: "zero-observed"
    })
    expect(Number.isInteger(descendantPid)).toBe(true)
    await waitForProcessExit(descendantPid)
    expect(await processIsRunning(descendantPid)).toBe(false)
  } finally {
    if (descendantPid !== null && (await processIsRunning(descendantPid))) {
      process.kill(descendantPid, "SIGKILL")
    }
    await supervisor.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 12_000)

test("macOS native protocol reports TERM for combined and KILL-only hard termination", async () => {
  if (process.platform !== "darwin") return
  const { artifactDirectory, nativeHelperPath, closeNativeSupervisor } =
    await testHookNativeSupervisor()
  try {
    const combined = await nativePosixTerminationEvidence(nativeHelperPath, 0x0004)
    const hardOnly = await nativePosixTerminationEvidence(nativeHelperPath, 0x0008)
    expect(combined.termSent).toBe(true)
    expect(combined.killRounds).toBeGreaterThan(0)
    expect(hardOnly.termSent).toBe(false)
    expect(hardOnly.killRounds).toBeGreaterThan(0)
  } finally {
    await closeNativeSupervisor()
    await rm(artifactDirectory, { recursive: true, force: true })
    expect(await Bun.file(artifactDirectory).exists()).toBe(false)
  }
}, 15_000)

test("macOS native helper default combined timeout bounds repeated KILL rounds", async () => {
  if (process.platform !== "darwin") return
  const directory = await mkdtemp(join(tmpdir(), "go-like-native-fork-storm-"))
  const processIdPath = join(directory, "target.pid")
  const readyPath = join(directory, "descendant.ready")
  const { supervisor, artifactDirectory } = await testHookNativeSupervisor()
  try {
    const startedAt = performance.now()
    const result = await supervisor.run(Root, {
      cwd: ".",
      command: [
        process.execPath,
        runnerFixture("fork-storm.ts"),
        directory,
        processIdPath,
        readyPath
      ],
      environment: {
        GO_LIKE_E2E_TEST_SIGNAL_BARRIER_DIR: directory,
        GO_LIKE_E2E_TEST_SKIP_KILL_ROUNDS: "2"
      },
      timeoutMs: 750
    })
    expect(result).toMatchObject({
      exitCode: null,
      signal: null,
      termination: "timeout",
      timedOut: true,
      containment: "not-claimed",
      residual: "zero-observed"
    })
    expect(result.cleanupFailures).toEqual([])
    expect(result.stdout).toContain("FORK_STORM_READY")
    for (const stage of ["term", "kill-1", "kill-2", "kill-3"] as const) {
      expect(await Bun.file(join(directory, `${stage}.ready`)).exists()).toBe(true)
      expect(await Bun.file(join(directory, `${stage}.release`)).exists()).toBe(true)
    }
    expect(performance.now() - startedAt).toBeLessThan(4_000)
  } finally {
    await supervisor.close()
    expect(await Bun.file(artifactDirectory).exists()).toBe(false)
    await terminateForkStormFixture(processIdPath, directory)
    await rm(directory, { recursive: true, force: true })
  }
}, 15_000)

test("macOS native helper reports a forced bounded inconclusive observation", async () => {
  if (process.platform !== "darwin") return
  const { supervisor, artifactDirectory } = await testHookNativeSupervisor()
  try {
    const startedAt = performance.now()
    const result = await supervisor.run(Root, {
      cwd: ".",
      command: [process.execPath, "-e", "process.exit(0)"],
      environment: { GO_LIKE_E2E_TEST_FORCE_INCONCLUSIVE: "1" },
      timeoutMs: 2_000
    })
    expect(result).toMatchObject({
      exitCode: 0,
      signal: null,
      termination: "exit",
      containment: "not-claimed",
      residual: "inconclusive"
    })
    expect(result.cleanupFailures.map((failure) => failure.code)).toContain(
      "process-residual-inconclusive"
    )
    expect(performance.now() - startedAt).toBeLessThan(4_000)
  } finally {
    await supervisor.close()
    expect(await Bun.file(artifactDirectory).exists()).toBe(false)
  }
}, 10_000)

test("native POSIX supervisor bounds inherited output from an unsupported breakaway", async () => {
  if (process.platform !== "darwin") return
  const directory = await mkdtemp(join(tmpdir(), "go-like-native-breakaway-tree-"))
  const processIdPath = join(directory, "descendant.pid")
  const readyPath = join(directory, "descendant.ready")
  const supervisor = await nativeSupervisor()
  let descendantPid: number | null = null
  try {
    const startedAt = performance.now()
    const result = await supervisor.run(Root, {
      cwd: ".",
      command: [process.execPath, runnerFixture("breakaway-parent.ts"), processIdPath, readyPath],
      timeoutMs: 5_000
    })
    descendantPid = Number(await Bun.file(processIdPath).text())
    expect(result.stdout).toContain(`BREAKAWAY_PID=${descendantPid}`)
    expect(result).toMatchObject({
      exitCode: 0,
      signal: null,
      termination: "exit",
      timedOut: false,
      containment: "not-claimed",
      residual: "present"
    })
    expect(result.cleanupFailures.map((failure) => failure.code)).toContain(
      "process-residual-present"
    )
    expect(result.cleanupFailures.map((failure) => failure.code)).toContain("stream-drain-failed")
    expect(performance.now() - startedAt).toBeLessThan(8_000)
  } finally {
    if (descendantPid !== null && (await processIsRunning(descendantPid))) {
      process.kill(descendantPid, "SIGKILL")
      await waitForProcessExit(descendantPid)
    }
    await supervisor.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 12_000)

test("definition fails when process cleanup reports an inconclusive output drain", async () => {
  const inconclusive = commandResult({
    residual: "inconclusive",
    cleanupFailures: [
      {
        code: "stream-drain-failed",
        category: "stream-drain",
        summary: "synthetic inherited pipe remained open"
      }
    ]
  })
  await expect(
    runE2eRequest("/repo", { kind: "scope", scope: "suites", processMode: "managed" }, undefined, {
      definitions: [Definition],
      validatePlan: async () => {},
      createSupervisor: async () => syntheticSupervisor(async () => inconclusive),
      runtimeProbe: { bunVersion: () => RequiredRuntimeVersions.bun },
      write: () => {}
    })
  ).rejects.toThrow("process cleanup failed")
})

test("definition fails when process cleanup reports a residual", async () => {
  const residual = commandResult({
    residual: "present",
    cleanupFailures: [
      {
        code: "process-residual-present",
        category: "process-cleanup",
        summary: "synthetic residual"
      }
    ]
  })
  await expect(
    runE2eRequest("/repo", { kind: "scope", scope: "suites", processMode: "managed" }, undefined, {
      definitions: [Definition],
      validatePlan: async () => {},
      createSupervisor: async () => syntheticSupervisor(async () => residual),
      runtimeProbe: { bunVersion: () => RequiredRuntimeVersions.bun },
      write: () => {}
    })
  ).rejects.toThrow("process cleanup failed")
})

test("definition failures report the actual timeout and residual outcome", async () => {
  const logs: string[] = []
  const timeoutResult = commandResult({
    exitCode: null,
    termination: "timeout",
    timedOut: true,
    durationMs: 19,
    residual: "present"
  })
  await expect(
    runE2eRequest("/repo", { kind: "scope", scope: "suites", processMode: "managed" }, undefined, {
      definitions: [Definition],
      validatePlan: async () => {},
      createSupervisor: async () => syntheticSupervisor(async () => timeoutResult),
      runtimeProbe: { bunVersion: () => RequiredRuntimeVersions.bun },
      write: (value) => logs.push(value)
    })
  ).rejects.toThrow("supervision-fixture exceeded")
  const output = logs.join("")
  expect(output).toContain(
    "FAIL supervision-fixture durationMs=19 termination=timeout containment=not-claimed residual=present"
  )
  expect(output).toContain("termination=exit=0,signal=0,timeout=1,abort=0,supervisor-error=0")
  expect(output).toContain("residual=present status=failed")
})

test("supervisor close failure is collected after a successful definition", async () => {
  const logs: string[] = []
  await expect(
    runE2eRequest("/repo", { kind: "scope", scope: "suites", processMode: "managed" }, undefined, {
      definitions: [Definition],
      validatePlan: async () => {},
      createSupervisor: async () =>
        syntheticSupervisor(
          async () => commandResult(),
          async () => {
            throw new Error("synthetic supervisor close failure")
          }
        ),
      runtimeProbe: { bunVersion: () => RequiredRuntimeVersions.bun },
      write: (value) => logs.push(value)
    })
  ).rejects.toThrow("synthetic supervisor close failure")
  const output = logs.join("")
  expect(output).toContain("PASS supervision-fixture")
  expect(output).toContain("termination=exit=1,signal=0,timeout=0,abort=0,supervisor-error=1")
  expect(output).toContain("residual=inconclusive status=failed")
})

test("supervisor close failure preserves an earlier definition failure", async () => {
  const primaryResult = commandResult({ exitCode: 23 })
  const closeFailure = new Error("synthetic supervisor close failure")
  let failure: unknown = null
  try {
    await runE2eRequest(
      "/repo",
      { kind: "scope", scope: "suites", processMode: "managed" },
      undefined,
      {
        definitions: [Definition],
        validatePlan: async () => {},
        createSupervisor: async () =>
          syntheticSupervisor(
            async () => primaryResult,
            async () => {
              throw closeFailure
            }
          ),
        runtimeProbe: { bunVersion: () => RequiredRuntimeVersions.bun },
        write: () => {}
      }
    )
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(AggregateError)
  const failures = (failure as AggregateError).errors
  expect(failures).toHaveLength(2)
  expect(failures[0]).toBeInstanceOf(Error)
  expect((failures[0] as Error).message).toContain("supervision-fixture exited 23")
  expect(failures[1]).toBe(closeFailure)
})
