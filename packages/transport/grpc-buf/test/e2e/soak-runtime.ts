import { create, toBinary } from "@bufbuild/protobuf"
import { connectNodeAdapter } from "@connectrpc/connect-node"
import { background, withTimeout } from "@go-like/context"
import { address, newClient, withEndpoint } from "@go-like/transport-grpc-buf/native"
import { createServer } from "node:http2"

import { newServerForTest, type NativeHTTP2Server } from "../../src/server"
import {
  newOrderServiceClient,
  registerOrderServiceHandler
} from "../../.artifacts/gen/order/v1/order_like.js"
import { GetOrderRequestSchema, OrderSchema } from "../../.artifacts/gen/order/v1/order_pb.js"
import type { GrpcSoakLoad, GrpcSoakOptions, GrpcSoakTerminal } from "../../../../../e2e/grpc-soak"
import { errorSummary } from "../../../../../e2e/harness/diagnostics"

const runtime = typeof Bun === "undefined" ? "node" : "bun"
const version = typeof Bun === "undefined" ? process.versions.node : Bun.version

async function serve(): Promise<void> {
  let requests = 0
  let sessions = 0
  let activeSessions = 0
  let rssPeak = process.memoryUsage().rss
  const sample = setInterval(() => {
    rssPeak = Math.max(rssPeak, process.memoryUsage().rss)
  }, 1_000)
  const server = newServerForTest(
    {
      createAdapter: connectNodeAdapter,
      createServer(_options, handler) {
        const host = createServer({}, handler)
        host.on("session", (session) => {
          sessions += 1
          activeSessions += 1
          session.once("close", () => {
            activeSessions -= 1
          })
        })
        return host as unknown as NativeHTTP2Server
      }
    },
    address("127.0.0.1:0")
  )
  registerOrderServiceHandler(server, {
    getOrder(_ctx, request) {
      requests += 1
      return { id: request.id, state: "READY" }
    },
    delete$(_ctx, request) {
      return { id: request.id }
    },
    async *watchOrders() {},
    async uploadEvents() {
      return { count: 0 }
    },
    async *syncOrders() {}
  })
  let stop: () => void = () => {}
  const shutdown = new Promise<void>((resolveStop) => {
    stop = resolveStop
  })
  process.once("SIGTERM", stop)
  process.once("SIGINT", stop)
  const running = server.start(background())
  void running.catch(() => {})
  try {
    const endpoint = await server.endpoint(background())
    console.log(
      JSON.stringify({ kind: "grpc-soak-ready", endpoint, pid: process.pid, runtime, version })
    )
    await Promise.race([shutdown, running])
  } finally {
    rssPeak = Math.max(rssPeak, process.memoryUsage().rss)
    clearInterval(sample)
    process.removeListener("SIGTERM", stop)
    process.removeListener("SIGINT", stop)
    const [ctx, cancel] = withTimeout(background(), 3_000)
    try {
      await server.stop(ctx)
      await running
    } finally {
      cancel()
    }
  }
  const terminal: GrpcSoakTerminal = {
    kind: "grpc-soak-terminal",
    requests,
    sessions,
    activeSessions,
    serverClosed: true,
    rssPeak
  }
  console.log(JSON.stringify(terminal))
}

async function load(endpoint: string, options: GrpcSoakOptions): Promise<void> {
  const client = newClient(withEndpoint(endpoint))
  const api = newOrderServiceClient(client)
  const request = { id: "x".repeat(options.payloadBytes) }
  const requestBytes = toBinary(
    GetOrderRequestSchema,
    create(GetOrderRequestSchema, request)
  ).byteLength
  const responseBytes = toBinary(
    OrderSchema,
    create(OrderSchema, { ...request, state: "READY" })
  ).byteLength
  // ponytail: 0.1ms buckets through 1s; overflow quantiles use observed max, use HDR if finer tails matter.
  const buckets = new Float64Array(10_001)
  let successes = 0
  let failures = 0
  let totalLatency = 0
  let maximumLatency = 0
  const errors: string[] = []
  const rssBefore = process.memoryUsage().rss
  let rssPeak = rssBefore
  const sample = setInterval(() => {
    rssPeak = Math.max(rssPeak, process.memoryUsage().rss)
  }, 1_000)
  const started = performance.now()
  let elapsedMs = 0
  async function worker(): Promise<void> {
    while (performance.now() - started < options.durationMs) {
      const callStarted = performance.now()
      const [ctx, cancel] = withTimeout(background(), 5_000)
      try {
        const response = await api.getOrder(ctx, request)
        if (response.id !== request.id || response.state !== "READY")
          throw new Error("response mismatch")
        const latency = performance.now() - callStarted
        const bucket = Math.min(Math.ceil(latency * 10), buckets.length - 1)
        buckets[bucket] = (buckets[bucket] ?? 0) + 1
        successes += 1
        totalLatency += latency
        maximumLatency = Math.max(maximumLatency, latency)
      } catch (error) {
        failures += 1
        if (errors.length < 5) errors.push(errorSummary(error).slice(0, 500))
      } finally {
        cancel()
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: options.concurrency }, worker))
    elapsedMs = performance.now() - started
  } finally {
    clearInterval(sample)
    const [ctx, cancel] = withTimeout(background(), 5_000)
    try {
      await client.close(ctx)
    } finally {
      cancel()
    }
  }
  function quantile(fraction: number): number {
    let count = 0
    for (let index = 0; index < buckets.length; index += 1) {
      count += buckets[index] ?? 0
      if (count >= Math.ceil(successes * fraction)) {
        return index === buckets.length - 1 ? maximumLatency : index / 10
      }
    }
    return 0
  }
  const rssAfter = process.memoryUsage().rss
  const result: GrpcSoakLoad = {
    kind: "grpc-soak-load",
    runtime,
    version,
    requests: successes + failures,
    successes,
    failures,
    errorRate: failures / Math.max(1, successes + failures),
    errors,
    elapsedMs,
    requestsPerSecond: successes / (elapsedMs / 1_000),
    requestBytes,
    responseBytes,
    latencyMs: {
      histogramBucketWidth: 0.1,
      histogramBuckets: buckets.length,
      mean: totalLatency / Math.max(1, successes),
      p50UpperBound: quantile(0.5),
      p95UpperBound: quantile(0.95),
      p99UpperBound: quantile(0.99),
      max: maximumLatency
    },
    memory: { rssBefore, rssAfter, rssPeak: Math.max(rssPeak, rssAfter) },
    clientClosed: true
  }
  console.log(JSON.stringify(result))
  if (failures !== 0 || successes === 0) process.exitCode = 1
}

if (process.argv[2] === "server") await serve()
else if (
  process.argv[2] === "load" &&
  process.argv[3] !== undefined &&
  process.argv[4] !== undefined
) {
  await load(process.argv[3], JSON.parse(process.argv[4]) as GrpcSoakOptions)
} else throw new TypeError("gRPC soak runtime expects server or load <endpoint> <options>")
