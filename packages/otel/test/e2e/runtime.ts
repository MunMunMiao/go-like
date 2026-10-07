import { background, type Context } from "@go-like/context"
import { newMetadata } from "@go-like/metadata"
import { newServerContext, type TransportInfo } from "@go-like/transport"
import {
  newOtelServer,
  traceBroker,
  traceClient,
  traceUnaryMiddleware,
  traceWebHandler
} from "@go-like/otel"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { MeterProvider } from "@opentelemetry/sdk-metrics"
import { TracerProvider } from "@opentelemetry/sdk-trace"

const resource = resourceFromAttributes({ "service.name": "otel-node-runtime" })
const tracerProvider = new TracerProvider({ resource, spanProcessors: [] })
const meterProvider = new MeterProvider({ resource, readers: [] })
const tracer = tracerProvider.getTracer("runtime")
const meter = meterProvider.getMeter("runtime")
const server = newOtelServer({ tracerProvider, meterProvider })
const running = server.start(background())
await Promise.resolve()

const response = new Response(new Uint8Array([2]))
const metadataHeaders = newMetadata()
const info: TransportInfo = {
  kind: () => "http",
  endpoint: () => "",
  operation: () => "runtime/read",
  requestHeaders: () => metadataHeaders,
  replyHeaders: () => metadataHeaders,
  peerIdentity: () => null
}
const client = traceClient(
  {
    async call() {
      return response
    },
    async stream() {
      throw new Error("unused")
    },
    async close() {}
  },
  tracer
)
const traced = await client.call(background(), {
  service: "runtime",
  endpoint: "read",
  headers: {},
  body: new Uint8Array([1])
})
if (!(traced instanceof Response) || new Uint8Array(await traced.arrayBuffer())[0] !== 2) {
  throw new Error("traced Client did not preserve its response bytes")
}

const request = new Request("https://runtime.example.test/runtime/read", { method: "POST" })
const unaryResponse = new Response(null, { status: 204 })
const unary = traceUnaryMiddleware(tracer)(async () => unaryResponse)
if ((await unary(newServerContext(background(), info), request)) !== unaryResponse) {
  throw new Error("traced unary middleware did not preserve its response")
}

const webResponse = new Response("web")
const web = traceWebHandler(() => webResponse, tracer)
const webResult = web(new Request("https://runtime.example.test/web"))
if (!(webResult instanceof Response) || (await webResult.text()) !== "web") {
  throw new Error("traced Web handler changed its synchronous response")
}

let delivery: ((ctx: Context) => Promise<void> | void) | null = null
const broker = traceBroker(
  {
    async publish(ctx) {
      if (delivery !== null) await delivery(ctx)
    },
    async subscribe(_ctx, topic, handler) {
      delivery = async (ctx) => {
        await handler(ctx, {
          topic,
          message: { headers: {}, body: new Uint8Array([3]) },
          native: Object.freeze({ runtime: true })
        })
      }
      return Object.freeze({
        topic,
        unsubscribe: async () => {}
      })
    },
    string() {
      return "runtime"
    }
  },
  tracer
)
await broker.subscribe(background(), "runtime", async () => {})
await broker.publish(background(), "runtime", { headers: {}, body: new Uint8Array([3]) })

if (typeof tracer.startSpan !== "function") {
  throw new Error("official Tracer API is unavailable")
}
if (typeof meter.createCounter !== "function") {
  throw new Error("official Meter API is unavailable")
}

await server.stop(background())
await running

console.log("otel-node-runtime ok")
