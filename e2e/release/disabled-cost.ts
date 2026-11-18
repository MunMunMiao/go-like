/**
 * D36 release gate.
 *
 * Measures the disabled-path cost of every core instrumentation entry the four final paths run:
 * unary RPC over the in-memory transport, one Web request, one in-memory broker delivery, and one
 * job run. Each entry runs on a Context of depth 8 with no telemetry installed and is compared,
 * round by round and interleaved with its own measurement, against `ctx.value(missingKey)` on the
 * same Context. A median more than 20 ns over the bare lookup fails the build.
 *
 * `injectRecord` is gated on the carrier the publish path hands it: `snapshotBrokerMessage`
 * freezes and registers the record, so the disabled path returns it by identity. Anything else,
 * including a user-frozen object, still takes the full copy.
 * Extraction runs only after the guard admits a Context, so the disabled path has no extraction
 * call of its own; the guard entry covers that single lookup.
 *
 * The four final operations are also timed end to end, with telemetry absent and with a Telemetry
 * whose providers record nothing. Those medians are reported, not gated: they carry protocol and
 * transport work that the 20 ns lookup budget never covered.
 *
 * Bun runs this file in-process. Bun also spawns a child `node` process on the built dist, so the
 * Node numbers come from Node itself. Run the whole script again when a run is noisy; the round
 * count, iteration count, and threshold are fixed.
 */
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { cpus, loadavg } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const repoDir = fileURLToPath(new URL("../..", import.meta.url))
const distDir = join(repoDir, "packages/core/dist")
const scriptPath = fileURLToPath(import.meta.url)
const nodeChildFlag = "--disabled-cost-node-child"
const thresholdNs = 20
const rounds = 5
const iterations = 1_000_000
const warmupIterations = 100_000
const operationRounds = 5
const operationIterations = 200
const operationWarmup = 20
const contextDepth = 8
const missingKey = Object.freeze({ name: "go-like.disabled-cost.missing" })
const benchUnit = Object.freeze({
  kind: "rpc.client",
  system: "go-like",
  method: "disabled.cost/Probe",
  stream: false
} as const)
const noopLogHandler = Object.freeze({
  enabled: () => true,
  handle: () => {}
})
const noopInstrument = Object.freeze({
  record: () => {}
})
const noopSpan = Object.freeze({
  spanContext: () => ({
    traceId: "0".repeat(32),
    spanId: "0".repeat(16),
    traceFlags: 0,
    traceState: "",
    isRemote: false
  }),
  isRecording: () => false,
  setAttributes: () => {},
  addEvent: () => {},
  setStatus: () => {},
  recordError: () => {},
  end: () => {}
})
const noopTracerProvider = Object.freeze({
  startSpan: () => noopSpan
})
const noopMeterProvider = Object.freeze({
  instrument: () => noopInstrument
})

type RuntimeName = "bun" | "node"
type Context = import("@go-like/core/context").Context

interface EntryPoint {
  readonly name: string
  readonly call: () => unknown
}

interface SampleSet {
  readonly baseline: number[]
  readonly cost: number[]
}

interface OperationFixture {
  readonly name: string
  run(): Promise<void>
  close(): Promise<void>
}

interface OperationSamples {
  readonly absent: number[]
  readonly telemetry: number[]
}

let sink = 0

/** Returns the running JavaScript runtime without depending on a global. */
function runtimeName(): RuntimeName {
  return Object.hasOwn(process.versions, "bun") ? "bun" : "node"
}

const distBase = new URL("../../packages/core/dist/", import.meta.url)

/** Resolves one built dist module URL. */
function dist(entry: string): string {
  return new URL(entry, distBase).href
}

/** Keeps loopback calls off any session proxy. */
function loopbackBypass(current: string | undefined, alternate: string | undefined): string {
  const parts = `${current ?? ""},${alternate ?? ""},127.0.0.1,localhost,::1`
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
  return [...new Set(parts)].join(",")
}

/** Sorts a copy of the samples and returns the middle one. */
function median(samples: readonly number[]): number {
  if (samples.length === 0) throw new Error("median requires at least one sample")
  const sorted = [...samples].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

/** Measures one entry for a fixed number of calls and returns nanoseconds per call. */
function measure(call: () => unknown, count: number): number {
  const started = performance.now()
  for (let index = 0; index < count; index += 1) sink += call() === undefined ? 0 : 1
  return ((performance.now() - started) * 1_000_000) / count
}

/** Rotates the entry order so each round starts on a different entry. */
function rotate(entries: readonly EntryPoint[], offset: number): EntryPoint[] {
  const start = offset % entries.length
  return [...entries.slice(start), ...entries.slice(0, start)]
}

/** Builds the depth-8 Context every entry measurement uses. */
function depthContext(context: typeof import("@go-like/core/context")): Context {
  let ctx = context.background()
  for (let index = 0; index < contextDepth; index += 1) {
    ctx = context.withValue(ctx, Object.freeze({ depth: index }), index)
  }
  return ctx
}

/** Loads the core dist APIs shared by every measurement. */
async function loadCore(): Promise<{
  readonly context: typeof import("@go-like/core/context")
  readonly provider: typeof import("@go-like/core/telemetry/provider")
  readonly telemetry: typeof import("@go-like/core/telemetry")
  readonly log: typeof import("@go-like/core/log")
  readonly metric: typeof import("@go-like/core/metric")
  readonly trace: typeof import("@go-like/core/trace")
  readonly struct: typeof import("@go-like/core/struct")
  readonly transport: typeof import("@go-like/core/transport")
  readonly memory: typeof import("@go-like/core/transport/memory")
  readonly server: typeof import("@go-like/core/server")
  readonly client: typeof import("@go-like/core/client")
  readonly broker: typeof import("@go-like/core/broker/memory")
  readonly brokerProvider: typeof import("@go-like/core/broker/provider")
  readonly job: typeof import("@go-like/core/job/provider")
  readonly web: typeof import("@go-like/core/web/node")
  readonly webBun: typeof import("@go-like/core/web/bun")
}> {
  return {
    context: (await import(dist("context/index.js"))) as typeof import("@go-like/core/context"),
    provider: (await import(
      dist("telemetry/provider.js")
    )) as typeof import("@go-like/core/telemetry/provider"),
    telemetry: (await import(
      dist("telemetry/index.js")
    )) as typeof import("@go-like/core/telemetry"),
    log: (await import(dist("log/index.js"))) as typeof import("@go-like/core/log"),
    metric: (await import(dist("metric/index.js"))) as typeof import("@go-like/core/metric"),
    trace: (await import(dist("trace/index.js"))) as typeof import("@go-like/core/trace"),
    struct: (await import(dist("struct/index.js"))) as typeof import("@go-like/core/struct"),
    transport: (await import(
      dist("transport/index.js")
    )) as typeof import("@go-like/core/transport"),
    memory: (await import(
      dist("transport/memory/index.js")
    )) as typeof import("@go-like/core/transport/memory"),
    server: (await import(dist("server/index.js"))) as typeof import("@go-like/core/server"),
    client: (await import(dist("client/index.js"))) as typeof import("@go-like/core/client"),
    broker: (await import(
      dist("broker/memory/index.js")
    )) as typeof import("@go-like/core/broker/memory"),
    brokerProvider: (await import(
      dist("broker/provider.js")
    )) as typeof import("@go-like/core/broker/provider"),
    job: (await import(dist("job/provider.js"))) as typeof import("@go-like/core/job/provider"),
    web: (await import(dist("web/node.js"))) as typeof import("@go-like/core/web/node"),
    webBun: (await import(dist("web/bun.js"))) as typeof import("@go-like/core/web/bun")
  }
}

type Core = Awaited<ReturnType<typeof loadCore>>

/** Returns the four instrumentation entries and their call sites. */
function entryPoints(core: Core, ctx: Context): readonly EntryPoint[] {
  const headers = new Headers()
  const record = core.brokerProvider.snapshotBrokerMessage({
    headers: { source: "disabled-cost" },
    body: new Uint8Array(0)
  }).headers
  const counter = core.metric.newCounter("go_like.disabled_cost", { attributeKeys: [] })
  return [
    { name: "observing", call: () => core.provider.observing(ctx) },
    { name: "beginUnit", call: () => core.provider.beginUnit(ctx, benchUnit) },
    { name: "injectHeaders", call: () => core.provider.injectHeaders(ctx, headers) },
    { name: "injectRecord", call: () => core.provider.injectRecord(ctx, record) },
    { name: "log.info", call: () => core.log.info(ctx, "disabled cost") },
    { name: "counter.add", call: () => counter.add(ctx, 1) },
    { name: "spanFromContext", call: () => core.trace.spanFromContext(ctx).isRecording() }
  ]
}

/** Measures every entry against the bare lookup with interleaved rounds. */
function measureEntries(
  runtime: RuntimeName,
  entries: readonly EntryPoint[],
  ctx: Context
): boolean {
  for (const entry of entries) {
    measure(() => ctx.value(missingKey), warmupIterations)
    measure(entry.call, warmupIterations)
  }
  const samples = new Map<string, SampleSet>()
  for (const entry of entries) samples.set(entry.name, { baseline: [], cost: [] })
  for (let round = 0; round < rounds; round += 1) {
    const ordered = rotate(entries, round)
    for (const entry of ordered) {
      const set = samples.get(entry.name)
      if (set === undefined) throw new Error(`missing sample set for ${entry.name}`)
      if (round % 2 === 0) {
        set.baseline.push(measure(() => ctx.value(missingKey), iterations))
        set.cost.push(measure(entry.call, iterations))
      } else {
        set.cost.push(measure(entry.call, iterations))
        set.baseline.push(measure(() => ctx.value(missingKey), iterations))
      }
    }
  }
  let passed = true
  for (const entry of entries) {
    const set = samples.get(entry.name)
    if (set === undefined) throw new Error(`missing sample set for ${entry.name}`)
    const baseline = median(set.baseline)
    const cost = median(set.cost)
    const delta = cost - baseline
    const result = delta > thresholdNs ? "fail" : "pass"
    if (result === "fail") passed = false
    const spread = Math.max(...set.cost) - Math.min(...set.cost)
    process.stdout.write(
      `runtime=${runtime} entry=${entry.name} baseline_ns=${baseline.toFixed(1)} ` +
        `cost_ns=${cost.toFixed(1)} delta_ns=${delta.toFixed(1)} ` +
        `threshold_ns=${thresholdNs} spread_ns=${spread.toFixed(1)} result=${result}\n`
    )
  }
  return passed
}

/** Builds one Telemetry whose tracer, meter, and log handler discard every record. */
function noopTelemetry(core: Core): import("@go-like/core/telemetry").Telemetry {
  return core.telemetry.newTelemetry({
    tracerProvider: noopTracerProvider,
    meterProviders: [noopMeterProvider],
    logHandlers: [noopLogHandler]
  })
}

/** Creates the in-memory unary RPC fixture. */
async function rpcFixture(core: Core, ctx: Context, address: string): Promise<OperationFixture> {
  const request = core.struct.struct.object({ value: core.struct.struct.number() })
  const response = core.struct.struct.object({ value: core.struct.struct.number() })
  const service = core.transport.defineService("disabled.cost.v1", { add: { request, response } })
  const memory = core.memory.newMemoryTransport()
  const server = core.server.newServer(core.server.transport(memory), core.server.address(address))
  service.registerHandler(server, {
    add(_ctx: Context, value: { value: number }): { value: number } {
      return { value: value.value }
    }
  })
  const running = server.start(ctx)
  await server.endpoint(ctx)
  const connection = core.client.newClient(
    core.client.withTransport(memory),
    core.client.withEndpoint(address)
  )
  const proxy = service.newClient(connection)
  return {
    name: "rpc.unary",
    async run(): Promise<void> {
      await proxy.add(ctx, { value: 1 })
    },
    async close(): Promise<void> {
      await connection.close(ctx)
      await server.stop(ctx)
      await running
    }
  }
}

/** Creates one Web request fixture on the host owned by the running runtime. */
async function webFixture(
  core: Core,
  ctx: Context,
  runtime: RuntimeName
): Promise<OperationFixture> {
  const handler = (): Response => new Response("ok")
  const server =
    runtime === "bun"
      ? core.webBun.newBunServer(handler, core.webBun.port(0))
      : core.web.newNodeServer(handler, core.web.port(0))
  const running = server.start(ctx)
  const endpoint = await server.endpoint(ctx)
  return {
    name: "web.request",
    async run(): Promise<void> {
      const response = await fetch(endpoint)
      await response.text()
    },
    async close(): Promise<void> {
      await server.stop(ctx)
      await running
    }
  }
}

/** Creates the in-memory broker delivery fixture. */
async function brokerFixture(core: Core, ctx: Context): Promise<OperationFixture> {
  const broker = core.broker.newMemoryBroker()
  const subscription = await broker.subscribe(ctx, "disabled.cost", async () => {})
  const body = new Uint8Array(0)
  return {
    name: "broker.delivery",
    async run(): Promise<void> {
      await broker.publish(ctx, "disabled.cost", { headers: {}, body })
    },
    async close(): Promise<void> {
      await subscription.unsubscribe(ctx)
    }
  }
}

/** Creates the scheduled job run fixture. */
function jobFixture(core: Core, ctx: Context): OperationFixture {
  const info = Object.freeze({
    system: "memory",
    name: "disabled-cost",
    trigger: "schedule" as const,
    id: null,
    attempt: 0,
    metadata: null
  })
  return {
    name: "job.run",
    async run(): Promise<void> {
      await core.job.runJob(ctx, info, async () => 1)
    },
    async close(): Promise<void> {}
  }
}

/** Builds every final-path fixture for one telemetry mode. */
async function operationFixtures(
  core: Core,
  ctx: Context,
  runtime: RuntimeName,
  mode: "absent" | "telemetry"
): Promise<readonly OperationFixture[]> {
  const suffix = mode === "absent" ? "absent" : "telemetry"
  return [
    await rpcFixture(core, ctx, `memory://disabled-cost-${suffix}`),
    await webFixture(core, ctx, runtime),
    await brokerFixture(core, ctx),
    jobFixture(core, ctx)
  ]
}

/** Measures one fixture for a round and returns its per-operation median in nanoseconds. */
async function measureOperation(fixture: OperationFixture, count: number): Promise<number> {
  const samples: number[] = []
  for (let index = 0; index < count; index += 1) {
    const started = performance.now()
    await fixture.run()
    samples.push((performance.now() - started) * 1_000_000)
  }
  return median(samples)
}

/** Measures all four final operations with and without telemetry. */
async function measureOperations(core: Core, runtime: RuntimeName): Promise<void> {
  const absentCtx = core.context.background()
  const telemetryCtx = core.telemetry.withTelemetry(core.context.background(), noopTelemetry(core))
  const absent = await operationFixtures(core, absentCtx, runtime, "absent")
  const telemetry = await operationFixtures(core, telemetryCtx, runtime, "telemetry")
  const samples = new Map<string, OperationSamples>()
  for (const fixture of absent) {
    samples.set(fixture.name, { absent: [], telemetry: [] })
  }
  try {
    for (const fixture of absent) {
      for (let index = 0; index < operationWarmup; index += 1) await fixture.run()
    }
    for (const fixture of telemetry) {
      for (let index = 0; index < operationWarmup; index += 1) await fixture.run()
    }
    for (let round = 0; round < operationRounds; round += 1) {
      const ordered = round % 2 === 0 ? absent : [...absent].reverse()
      const telemetryByName = new Map(telemetry.map((fixture) => [fixture.name, fixture]))
      for (const fixture of ordered) {
        const telemetryFixture = telemetryByName.get(fixture.name)
        if (telemetryFixture === undefined)
          throw new Error(`missing telemetry fixture ${fixture.name}`)
        const set = samples.get(fixture.name)
        if (set === undefined) throw new Error(`missing operation samples ${fixture.name}`)
        set.absent.push(await measureOperation(fixture, operationIterations))
        set.telemetry.push(await measureOperation(telemetryFixture, operationIterations))
      }
    }
  } finally {
    for (const fixture of [...absent, ...telemetry]) await fixture.close()
  }
  for (const fixture of absent) {
    const set = samples.get(fixture.name)
    if (set === undefined) throw new Error(`missing operation samples ${fixture.name}`)
    const absentMedian = median(set.absent)
    const telemetryMedian = median(set.telemetry)
    process.stdout.write(
      `runtime=${runtime} operation=${fixture.name} mode=absent ` +
        `median_us=${(absentMedian / 1_000).toFixed(2)} rounds=${operationRounds} ` +
        `iterations=${operationIterations}\n`
    )
    process.stdout.write(
      `runtime=${runtime} operation=${fixture.name} mode=noop-telemetry ` +
        `median_us=${(telemetryMedian / 1_000).toFixed(2)} rounds=${operationRounds} ` +
        `iterations=${operationIterations} overhead_us=${((telemetryMedian - absentMedian) / 1_000).toFixed(2)}\n`
    )
  }
}

/** Runs the entry gate and the reported operation timings for one runtime. */
async function runBenchmark(runtime: RuntimeName): Promise<boolean> {
  const core = await loadCore()
  const ctx = depthContext(core.context)
  const load = loadavg()
  process.stdout.write(
    `runtime=${runtime} machine cpus=${cpus().length} loadavg_1m=${load[0]?.toFixed(2) ?? "0"} ` +
      `loadavg_5m=${load[1]?.toFixed(2) ?? "0"} loadavg_15m=${load[2]?.toFixed(2) ?? "0"}\n`
  )
  const passed = measureEntries(runtime, entryPoints(core, ctx), ctx)
  await measureOperations(core, runtime)
  process.stdout.write(`runtime=${runtime} entries=${passed ? "pass" : "fail"}\n`)
  return passed
}

/** Runs one child command to completion with a hard timeout, streaming its output. */
function runProcess(command: string, args: readonly string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const bypass = loopbackBypass(process.env.NO_PROXY, process.env.no_proxy)
    const child = spawn(command, [...args], {
      cwd: repoDir,
      env: {
        ...process.env,
        NO_PROXY: bypass,
        no_proxy: bypass
      },
      stdio: ["ignore", "pipe", "pipe"]
    })
    child.stdout.on("data", (chunk: Buffer) => process.stdout.write(chunk))
    child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk))
    const timer = setTimeout(() => child.kill("SIGKILL"), 240_000)
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve(code ?? 1)
    })
  })
}

/** Runs the Node half in a child process on the built dist. */
async function runNodeChild(): Promise<boolean> {
  const code = await runProcess("node", [scriptPath, nodeChildFlag])
  if (code !== 0) {
    process.stderr.write(`disabled-cost: node child exited ${code}\n`)
    return false
  }
  return true
}

if (!existsSync(distDir)) {
  process.stderr.write(
    `disabled-cost: missing ${distDir}; run "bun run build" before the release gate\n`
  )
  process.exitCode = 1
} else if (runtimeName() === "bun" && !process.argv.includes(nodeChildFlag)) {
  const bunPassed = await runBenchmark("bun")
  const nodePassed = await runNodeChild()
  if (!bunPassed || !nodePassed) process.exitCode = 1
} else {
  const passed = await runBenchmark("node")
  if (!passed) process.exitCode = 1
}
