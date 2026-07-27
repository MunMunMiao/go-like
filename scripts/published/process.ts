import type { CommandResult } from "./contracts"

export interface CommandOptions {
  readonly cwd: string
  readonly timeoutMs?: number
}

export const publishedCommandTimeoutMs = 180_000
const terminationGraceMs = 1_000
const outputDrainTimeoutMs = 2_000

interface FulfilledSettlement<T> {
  readonly kind: "fulfilled"
  readonly value: T
}

interface RejectedSettlement {
  readonly kind: "rejected"
  readonly reason: unknown
}

interface TimeoutSettlement {
  readonly kind: "timeout"
}

type TimedSettlement<T> = FulfilledSettlement<T> | RejectedSettlement | TimeoutSettlement

interface StreamCapture {
  readonly done: Promise<void>
  cancel(reason: Error): Promise<void>
  text(): string
}

function commandTimeout(value: number | undefined): number {
  const resolved = value ?? publishedCommandTimeoutMs
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > 2_147_483_647) {
    throw new RangeError("published command timeout must be a positive safe timer duration")
  }
  return resolved
}

function boundedOutput(stdout: string, stderr: string): string {
  const output = `${stdout}${stderr}`.trim()
  return output.length <= 4_000 ? output : `…${output.slice(-4_000)}`
}

/** Settles one promise within a caller-owned deadline and observes late rejection. */
async function settleWithin<T>(work: Promise<T>, timeoutMs: number): Promise<TimedSettlement<T>> {
  return await new Promise<TimedSettlement<T>>(function settle(resolve) {
    let settled = false
    const timer = setTimeout(function timedOut(): void {
      if (settled) return
      settled = true
      const result: TimeoutSettlement = Object.freeze({ kind: "timeout" })
      resolve(result)
    }, timeoutMs)
    work.then(
      function fulfilled(value): void {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const result: FulfilledSettlement<T> = Object.freeze({ kind: "fulfilled", value })
        resolve(result)
      },
      function rejected(reason: unknown): void {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const result: RejectedSettlement = Object.freeze({ kind: "rejected", reason })
        resolve(result)
      }
    )
  })
}

/** Captures one subprocess pipe while retaining an explicit cancellation path. */
function captureStream(stream: ReadableStream<Uint8Array>): StreamCapture {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let output = ""
  const done = (async function read(): Promise<void> {
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        output += decoder.decode(chunk.value, { stream: true })
      }
      output += decoder.decode()
    } finally {
      reader.releaseLock()
    }
  })()
  return Object.freeze({
    done,
    async cancel(reason: Error): Promise<void> {
      await reader.cancel(reason)
    },
    text(): string {
      return output
    }
  })
}

/** Returns whether a POSIX detached process group still contains a process. */
function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0)
    return true
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH")
  }
}

/** Sends one signal to a detached process tree without shell interpolation. */
function signalProcessTree(subprocess: Bun.Subprocess, signal: "SIGTERM" | "SIGKILL"): void {
  if (process.platform === "win32") {
    const command =
      signal === "SIGKILL"
        ? ["taskkill", "/PID", String(subprocess.pid), "/T", "/F"]
        : ["taskkill", "/PID", String(subprocess.pid), "/T"]
    try {
      const result = Bun.spawnSync(command, { stdout: "ignore", stderr: "ignore" })
      if (result.exitCode === 0) return
    } catch {
      // Direct termination remains available when taskkill cannot be invoked.
    }
  } else {
    try {
      process.kill(-subprocess.pid, signal)
      return
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return
    }
  }
  try {
    subprocess.kill(signal)
  } catch {
    // A concurrently exited process needs no further termination.
  }
}

/** Terminates a complete detached process tree, escalating after one short grace period. */
async function terminateProcessTree(subprocess: Bun.Subprocess): Promise<void> {
  if (process.platform === "win32") {
    signalProcessTree(subprocess, "SIGKILL")
    return
  }
  signalProcessTree(subprocess, "SIGTERM")
  const deadline = performance.now() + terminationGraceMs
  while (processGroupExists(subprocess.pid) && performance.now() < deadline) {
    await Bun.sleep(25)
  }
  if (processGroupExists(subprocess.pid)) signalProcessTree(subprocess, "SIGKILL")
}

/** Cancels inherited pipe readers without making cancellation another unbounded wait. */
async function cancelCaptures(captures: readonly StreamCapture[], reason: Error): Promise<void> {
  const cancellation = Promise.allSettled(
    captures.map(function cancel(capture): Promise<void> {
      return capture.cancel(reason)
    })
  )
  await settleWithin(cancellation, terminationGraceMs)
}

/** Runs one argv-only command and captures complete output without shell interpolation. */
export async function runCommand(
  args: readonly string[],
  options: CommandOptions
): Promise<CommandResult> {
  if (args.length === 0) throw new TypeError("published command argv must be non-empty")
  const timeoutMs = commandTimeout(options.timeoutMs)
  const argv: string[] = []
  for (const value of args) argv.push(value)
  const subprocess = Bun.spawn(argv, {
    cwd: options.cwd,
    detached: true,
    stdout: "pipe",
    stderr: "pipe"
  })
  const stdout = captureStream(subprocess.stdout)
  const stderr = captureStream(subprocess.stderr)
  const complete = Promise.all([subprocess.exited, stdout.done, stderr.done]).then(
    function completed(values): number {
      return values[0]
    }
  )
  const settlement = await settleWithin(complete, timeoutMs)
  if (settlement.kind === "fulfilled") {
    if (process.platform !== "win32" && processGroupExists(subprocess.pid)) {
      await terminateProcessTree(subprocess)
      throw new Error(`published command ${argv[0]} exited while descendants remained`)
    }
    return Object.freeze({
      exitCode: settlement.value,
      stdout: stdout.text(),
      stderr: stderr.text()
    })
  }

  const failure =
    settlement.kind === "timeout"
      ? new Error(`published command ${argv[0]} exceeded ${timeoutMs}ms`)
      : new Error(`published command ${argv[0]} output capture failed`, {
          cause: settlement.reason
        })
  await terminateProcessTree(subprocess)
  const drained = await settleWithin(complete, outputDrainTimeoutMs)
  if (drained.kind !== "fulfilled") {
    await cancelCaptures([stdout, stderr], failure)
    await settleWithin(complete, terminationGraceMs)
  }
  if (settlement.kind === "rejected") throw failure
  const output = boundedOutput(stdout.text(), stderr.text())
  throw new Error(`${failure.message}${output.length === 0 ? "" : `: ${output}`}`)
}

export function commandOutput(result: CommandResult): string {
  return `${result.stdout}${result.stderr}`
}

export function requireCommandSuccess(label: string, result: CommandResult): void {
  if (result.exitCode !== 0) {
    const detail = commandOutput(result).trim()
    throw new Error(
      `${label} failed with exit ${result.exitCode}${detail.length === 0 ? "" : `: ${detail}`}`
    )
  }
}
