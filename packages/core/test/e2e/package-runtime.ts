import { spawn } from "node:child_process"
import process from "node:process"
import { fileURLToPath } from "node:url"

import { runtimeExports } from "../support/public-api"

/** Runs the source struct depth checks in a fresh process so they do not register a second core copy. */
function assertSourceStruct(): Promise<void> {
  const file = fileURLToPath(new URL("./struct-source-runtime.ts", import.meta.url))
  const args = "Bun" in globalThis ? [file] : ["--import", "tsx", file]
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] })
    const output = child.stdout
    const errors = child.stderr
    if (output === null || errors === null) {
      child.kill()
      reject(new Error("struct source runtime did not pipe output"))
      return
    }
    const timer = setTimeout(() => child.kill(), 30_000)
    let settled = false
    let stdout = ""
    let stderr = ""
    output.setEncoding("utf8")
    errors.setEncoding("utf8")
    output.on("data", (chunk: string) => {
      stdout += chunk
    })
    errors.on("data", (chunk: string) => {
      stderr += chunk
    })
    child.on("error", (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`struct source runtime exited ${code}\n${stdout}\n${stderr}`))
    })
  })
}

async function load<T extends object>(path: string): Promise<T> {
  const href = new URL(`../../dist/${path}`, import.meta.url).href
  return (await import(href)) as T
}

function assertExports(actual: object, expected: readonly string[], label: string): void {
  const keys = Object.keys(actual).sort()
  if (JSON.stringify(keys) !== JSON.stringify([...expected])) {
    throw new Error(`unexpected ${label} exports: ${keys.join(",")}`)
  }
}

const dist = {
  ".": "index.js",
  "./node": "node/index.js",
  "./lifecycle": "lifecycle/index.js",
  "./log": "log/index.js",
  "./metric": "metric/index.js",
  "./context": "context/index.js",
  "./metadata": "metadata/index.js",
  "./struct": "struct/index.js",
  "./health": "health/index.js",
  "./resilience": "resilience/index.js",
  "./telemetry": "telemetry/index.js",
  "./telemetry/provider": "telemetry/provider.js",
  "./testing": "testing/index.js",
  "./trace": "trace/index.js",
  "./transport": "transport/index.js",
  "./transport/provider": "transport/provider.js",
  "./transport/memory": "transport/memory/index.js",
  "./transport/http": "transport/http/index.js",
  "./transport/http/node": "transport/http/node.js",
  "./server": "server/index.js",
  "./client": "client/index.js",
  "./web": "web/index.js",
  "./web/node": "web/node.js",
  "./web/bun": "web/bun.js",
  "./registry": "registry/index.js",
  "./registry/provider": "registry/provider.js",
  "./registry/memory": "registry/memory.js",
  "./config": "config/index.js",
  "./config/provider": "config/provider.js",
  "./config/node": "config/node.js",
  "./fetch": "fetch/index.js",
  "./cache": "cache/index.js",
  "./cache/memory": "cache/memory/index.js",
  "./store": "store/index.js",
  "./store/provider": "store/provider.js",
  "./store/memory": "store/memory/index.js",
  "./broker": "broker/index.js",
  "./broker/provider": "broker/provider.js",
  "./broker/memory": "broker/memory/index.js"
} as const

for (const [key, path] of Object.entries(dist)) {
  const expected = runtimeExports[key as keyof typeof runtimeExports]
  assertExports(
    await load<object>(path),
    expected,
    `@go-like/core${key === "." ? "" : key.slice(1)}`
  )
}

const context = await load<typeof import("../../src/context/index")>("context/index.js")
const [ctx, cancel] = context.withCancel(context.background())
const signal = ctx.done()
cancel()
if (signal === null || !signal.aborted || ctx.err() !== context.canceled) {
  throw new Error("built @go-like/core/context cancellation runtime failed")
}

const metadata = await load<typeof import("../../src/metadata/index")>("metadata/index.js")
const snapshot = metadata.append(metadata.newMetadata({ Trace: "one" }), "trace", "two")
const replaced = metadata.set(snapshot, "TRACE", "replacement")
const removed = metadata.remove(replaced, "trace")
if (
  metadata.get(snapshot, "TRACE") !== "one" ||
  metadata.values(snapshot, "trace")[1] !== "two" ||
  metadata.get(replaced, "trace") !== "replacement" ||
  metadata.get(removed, "trace") !== null
) {
  throw new Error("built @go-like/core/metadata multi-value runtime failed")
}

const health = await load<typeof import("../../src/health/index")>("health/index.js")
const lateRejections: unknown[] = []
const runtimeName = "Bun" in globalThis ? "bun" : "node"
process.on("unhandledRejection", (reason) => {
  lateRejections.push(reason)
})
const probes = health.newProbeRegistry()
let rejectLate: (error: Error) => void = (error) => {
  throw error
}
probes.register(
  "live",
  "late",
  () =>
    new Promise<void>((_resolve, reject) => {
      rejectLate = reject
    }),
  { timeoutMs: 0 }
)
const report = await probes.check(context.background(), "live")
rejectLate(new Error("late rejection should be observed"))
await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 10))
if (report.ok !== false || lateRejections.length !== 0) {
  throw new Error(`${runtimeName} late rejection probe failed`)
}

const resilience = await load<typeof import("../../src/resilience/index")>("resilience/index.js")
const attempts: number[] = []
const transient = new Error("transient")
const backoff = resilience.exponentialBackoff({ initialDelayMs: 0, maxDelayMs: 0 })
const value = await resilience.retry(
  context.background(),
  (_attemptContext, attempt) => {
    attempts.push(attempt)
    if (attempt === 1) throw transient
    return "recovered"
  },
  {
    authorization: "idempotent",
    maxAttempts: 2,
    shouldRetry: (_attemptContext, failure) => failure === transient,
    backoff
  }
)
const breaker = resilience.newCircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 100 })
const protectedValue = await breaker.execute(context.background(), () => value)
const limiter = resilience.newTokenBucketLimiter({
  capacity: 1,
  refillTokens: 1,
  refillIntervalMs: 1_000
})
const first = limiter.allow(context.background())
const second = limiter.allow(context.background())
if (
  protectedValue !== "recovered" ||
  attempts.join(",") !== "1,2" ||
  !first.allowed ||
  second.allowed
) {
  throw new Error("published resilience runtime failed")
}

const Struct = await load<typeof import("../../src/struct/index")>("struct/index.js")
const Quote = Struct.struct.object({
  id: Struct.struct.bigint().alias("quote_id"),
  requestedAt: Struct.struct.date().alias("requested_at")
})
const requestedAt = new Date("2026-08-03T05:05:06.000Z")
const wire = Struct.encodeJson(Quote, { id: 9007199254740993n, requestedAt }) as {
  quote_id: string
  requested_at: string
}
if (wire.quote_id !== "9007199254740993" || wire.requested_at !== "2026-08-03T05:05:06.000Z") {
  throw new Error("built @go-like/core/struct JSON encode failed")
}
const decoded = Struct.decodeJson(Quote, wire)
if (decoded.id !== 9007199254740993n || decoded.requestedAt.getTime() !== requestedAt.getTime()) {
  throw new Error("built @go-like/core/struct JSON decode failed")
}
await assertSourceStruct()

const core = await load<typeof import("../../src/index")>("index.js")
let resolveDone: () => void = () => undefined
const done = new Promise<void>((resolveDonePromise) => {
  resolveDone = resolveDonePromise
})
const subject = {
  async start() {
    await done
  },
  async stop() {
    resolveDone()
  }
}
const app = core.newApp(core.name("package-runtime"), core.server(subject))
const running = app.run()
await Promise.resolve()
await app.stop()
await running
if (app.name() !== "package-runtime")
  throw new Error("built @go-like/core lifecycle runtime failed")
console.log(`core-runtime ok ${runtimeName}`)
