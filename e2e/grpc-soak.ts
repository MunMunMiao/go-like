import { mkdir, writeFile } from "node:fs/promises"
import { arch, platform, release } from "node:os"
import { dirname, resolve } from "node:path"
import { parseArgs } from "node:util"

import { errorSummary } from "./harness/diagnostics"
import { runCommand, type CommandResult } from "./harness/process"

export interface GrpcSoakOptions {
  readonly runtime: "bun" | "node"
  readonly durationMs: number
  readonly concurrency: number
  readonly payloadBytes: number
}

export interface GrpcSoakReady {
  readonly kind: "grpc-soak-ready"
  readonly endpoint: string
  readonly pid: number
  readonly runtime: string
  readonly version: string
}

export interface GrpcSoakLoad {
  readonly kind: "grpc-soak-load"
  readonly runtime: string
  readonly version: string
  readonly requests: number
  readonly successes: number
  readonly failures: number
  readonly errorRate: number
  readonly errors: readonly string[]
  readonly elapsedMs: number
  readonly requestsPerSecond: number
  readonly requestBytes: number
  readonly responseBytes: number
  readonly latencyMs: {
    readonly histogramBucketWidth: number
    readonly histogramBuckets: number
    readonly mean: number
    readonly p50UpperBound: number
    readonly p95UpperBound: number
    readonly p99UpperBound: number
    readonly max: number
  }
  readonly memory: {
    readonly rssBefore: number
    readonly rssAfter: number
    readonly rssPeak: number
  }
  readonly clientClosed: boolean
}

export interface GrpcSoakTerminal {
  readonly kind: "grpc-soak-terminal"
  readonly requests: number
  readonly sessions: number
  readonly activeSessions: number
  readonly serverClosed: boolean
  readonly rssPeak: number
}

const Root = resolve(import.meta.dir, "..")
const Fixture = "packages/transport/grpc-buf/test/e2e/soak-runtime.ts"

function boundedInteger(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${label} must be an integer between 1 and ${maximum}`)
  }
  return value
}

/** Rejects unbounded workloads before starting any subprocess. */
export function validateGrpcSoakOptions(options: GrpcSoakOptions): void {
  if (options.runtime !== "bun" && options.runtime !== "node") {
    throw new TypeError("--runtime must be bun or node")
  }
  boundedInteger(options.durationMs, "--duration in milliseconds", 3_600_000)
  boundedInteger(options.concurrency, "--concurrency", 256)
  boundedInteger(options.payloadBytes, "--payload-bytes", 1_048_576)
}

export function parseGrpcSoakArgs(args: readonly string[]) {
  const { values } = parseArgs({
    args: [...args],
    options: {
      runtime: { type: "string", default: "bun" },
      duration: { type: "string", default: "30s" },
      concurrency: { type: "string", default: "8" },
      "payload-bytes": { type: "string", default: "256" },
      output: { type: "string" }
    }
  })
  const duration = /^(\d+)(ms|s|m)$/u.exec(values.duration)
  if (duration === null) throw new TypeError("--duration must use ms, s, or m")
  const options: GrpcSoakOptions = {
    runtime: values.runtime as GrpcSoakOptions["runtime"],
    durationMs:
      Number(duration[1]) * (duration[2] === "m" ? 60_000 : duration[2] === "s" ? 1_000 : 1),
    concurrency: Number(values.concurrency),
    payloadBytes: Number(values["payload-bytes"])
  }
  validateGrpcSoakOptions(options)
  const output = values.output ?? `.artifacts/soak/grpc-${options.runtime}.json`
  if (output.trim().length === 0) throw new TypeError("--output must not be empty")
  return { options, output }
}

function fixtureCommand(runtime: GrpcSoakOptions["runtime"], ...args: string[]): readonly string[] {
  return runtime === "bun"
    ? [process.execPath, Fixture, ...args]
    : ["node", "--import", "tsx", Fixture, ...args]
}

function checked(result: CommandResult, label: string): void {
  if (
    result.termination !== "exit" ||
    result.exitCode !== 0 ||
    result.cleanupFailures.length !== 0 ||
    result.residual !== "zero-observed"
  ) {
    throw new Error(
      `${label} failed: termination=${result.termination} exit=${result.exitCode} residual=${result.residual}: ${result.stderr.slice(-2_000)}`
    )
  }
}

function event<T>(output: string, kind: string): T {
  for (const line of output.split("\n")) {
    if (!line.startsWith("{")) continue
    const value = JSON.parse(line) as { kind?: string }
    if (value.kind === kind) return value as T
  }
  throw new Error(`subprocess did not report ${kind}`)
}

/** Runs one bounded loopback workload; results describe this local run, not production capacity. */
export async function runGrpcSoak(
  options: GrpcSoakOptions,
  runner: typeof runCommand = runCommand
) {
  validateGrpcSoakOptions(options)
  const startedAt = new Date().toISOString()
  const serverAbort = new AbortController()
  const loadAbort = new AbortController()
  const interrupt = () => {
    serverAbort.abort(new Error("gRPC soak interrupted"))
    loadAbort.abort(new Error("gRPC soak interrupted"))
  }
  process.once("SIGINT", interrupt)
  process.once("SIGTERM", interrupt)
  let serverProcess: Promise<CommandResult> | null = null
  let serverResult: CommandResult | null = null
  let loadResult: CommandResult | null = null
  let ready: GrpcSoakReady | null = null
  let load: GrpcSoakLoad | null = null
  let terminal: GrpcSoakTerminal | null = null
  const errors: string[] = []
  let startupTimer: ReturnType<typeof setTimeout> | undefined
  let stopTimer: ReturnType<typeof setTimeout> | undefined
  try {
    let stdout = ""
    let readyResolve: (ready: GrpcSoakReady) => void = () => {}
    const readiness = new Promise<GrpcSoakReady>((resolveReady, rejectReady) => {
      readyResolve = resolveReady
      startupTimer = setTimeout(
        () => rejectReady(new Error("gRPC server readiness exceeded 10s")),
        10_000
      )
    })
    serverProcess = runner(Root, {
      cwd: ".",
      command: fixtureCommand(options.runtime, "server"),
      timeoutMs: options.durationMs + 30_000,
      signal: serverAbort.signal,
      onStdout(chunk) {
        stdout += chunk
        if (!stdout.includes("\n")) return
        try {
          readyResolve(event<GrpcSoakReady>(stdout, "grpc-soak-ready"))
        } catch {
          // The final process result reports missing or malformed readiness output.
        }
      }
    })
    ready = await Promise.race([
      readiness,
      serverProcess.then((result) => {
        checked(result, "gRPC server startup")
        throw new Error("gRPC server exited before readiness")
      })
    ])
    clearTimeout(startupTimer)
    loadResult = await runner(Root, {
      cwd: ".",
      command: fixtureCommand(options.runtime, "load", ready.endpoint, JSON.stringify(options)),
      timeoutMs: options.durationMs + 15_000,
      signal: loadAbort.signal
    })
    load = event<GrpcSoakLoad>(loadResult.stdout, "grpc-soak-load")
    checked(loadResult, "gRPC load")
  } catch (error) {
    errors.push(errorSummary(error))
  } finally {
    clearTimeout(startupTimer)
    try {
      if (ready !== null) {
        stopTimer = setTimeout(
          () => serverAbort.abort(new Error("gRPC server stop exceeded 5s")),
          5_000
        )
        try {
          process.kill(ready.pid, "SIGTERM")
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
            errors.push(errorSummary(error))
            serverAbort.abort(error)
          }
        }
      } else {
        serverAbort.abort(new Error("gRPC server startup failed"))
      }
      if (serverProcess !== null) {
        serverResult = await serverProcess
        checked(serverResult, "gRPC server")
        terminal = event<GrpcSoakTerminal>(serverResult.stdout, "grpc-soak-terminal")
      }
    } catch (error) {
      errors.push(errorSummary(error))
      serverAbort.abort(error)
      // runCommand owns and reaps the complete process tree before settling.
      await serverProcess?.catch(() => {})
    } finally {
      clearTimeout(stopTimer)
      process.removeListener("SIGINT", interrupt)
      process.removeListener("SIGTERM", interrupt)
    }
  }
  if (load !== null && terminal !== null) {
    if (
      load.successes === 0 ||
      load.failures !== 0 ||
      load.requests !== load.successes ||
      load.elapsedMs < options.durationMs ||
      !load.clientClosed ||
      terminal.requests !== load.successes ||
      terminal.sessions !== 1 ||
      terminal.activeSessions !== 0 ||
      !terminal.serverClosed
    )
      errors.push("gRPC soak request, connection reuse, or cleanup invariant failed")
  } else if (errors.length === 0) {
    errors.push("gRPC soak evidence is incomplete")
  }
  return {
    schemaVersion: 1,
    status: errors.length === 0 ? "passed" : "failed",
    scope: "source-workspace-loopback-unary-h2c",
    serverInstrumentation: "private factory with real node:http2 and connectNodeAdapter",
    commands: {
      server: fixtureCommand(options.runtime, "server"),
      load:
        ready === null
          ? null
          : fixtureCommand(options.runtime, "load", ready.endpoint, JSON.stringify(options))
    },
    startedAt,
    finishedAt: new Date().toISOString(),
    environment: {
      platform: platform(),
      release: release(),
      arch: arch(),
      coordinatorBun: Bun.version
    },
    options,
    ready,
    load,
    terminal,
    processes: { server: serverResult, load: loadResult },
    errors
  }
}

if (import.meta.main) {
  try {
    const { options, output } = parseGrpcSoakArgs(process.argv.slice(2))
    const result = await runGrpcSoak(options)
    await mkdir(dirname(resolve(output)), { recursive: true })
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`)
    console.log(JSON.stringify(result))
    if (result.status !== "passed") process.exitCode = 1
  } catch (error) {
    console.error(errorSummary(error))
    process.exitCode = 1
  }
}
