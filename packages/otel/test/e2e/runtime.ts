import { background, type Context } from "@likego/context"
import {
  newOtelServer,
  traceBroker,
  traceClient,
  traceUnaryMiddleware,
  traceWebHandler
} from "@likego/otel"
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

const response = Object.freeze({ header: Object.freeze({}), body: new Uint8Array([2]) })
const client = traceClient(
  {
    async call() {
      return response
    },
    async close() {}
  },
  tracer
)
if (
  (await client.call(background(), {
    service: "runtime",
    endpoint: "read",
    message: { header: {}, body: new Uint8Array([1]) }
  })) !== response
) {
  throw new Error("traced Client did not preserve its response")
}

const unary = traceUnaryMiddleware(tracer)(async (_ctx, message) => message)
if ((await unary(background(), response)) !== response) {
  throw new Error("traced unary middleware did not preserve its response")
}

const webResponse = new Response("web")
const web = traceWebHandler(() => webResponse, tracer)
if (web(new Request("https://runtime.example.test/web")) !== webResponse) {
  throw new Error("traced Web handler changed its synchronous response")
}

let delivery: ((ctx: Context) => PromiseLike<void> | void) | null = null
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
