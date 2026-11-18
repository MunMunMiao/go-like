import { background } from "@go-like/core/context"
import { newOtelMeterProvider, newOtelPropagator, newOtelTracerProvider } from "@go-like/otel"
import { W3CTraceContextPropagator } from "@opentelemetry/core"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { MeterProvider } from "@opentelemetry/sdk-metrics"
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace"

const resource = resourceFromAttributes({ "service.name": "otel-node-runtime" })
const spans = new InMemorySpanExporter()
const tracerProvider = new TracerProvider({
  resource,
  spanProcessors: [new SimpleSpanProcessor({ exporter: spans })]
})
const meterProvider = new MeterProvider({ resource, readers: [] })
const traces = newOtelTracerProvider(tracerProvider)
const metrics = newOtelMeterProvider(meterProvider)
const propagator = newOtelPropagator(new W3CTraceContextPropagator())
const traceRunning = traces.lifecycle.start(background())
const metricRunning = metrics.lifecycle.start(background())
await Promise.resolve()

const span = traces.startSpan(background(), { name: "runtime" }, "runtime", {
  kind: "internal",
  attributes: {},
  links: [],
  root: true
})
span.end()
const counter = metrics.instrument(
  { name: "runtime" },
  {
    kind: "counter",
    name: "runtime.counter",
    unit: "",
    description: "",
    attributeKeys: [],
    buckets: null
  }
)
counter.record(background(), 1, {})
if (spans.getFinishedSpans().some((item) => item.name === "runtime") !== true) {
  throw new Error("runtime span was not exported")
}
const carrier = {
  value: "",
  get: () => null,
  keys: () => [],
  set(_key: string, value: string) {
    this.value = value
  }
}
const enter = traces.enter
if (enter === undefined) throw new Error("enter is required")
propagator.inject(
  enter(background(), () => background()),
  carrier
)
if (!propagator.fields().includes("traceparent")) {
  throw new Error("W3C propagator did not declare traceparent")
}

await traces.lifecycle.stop(background())
await metrics.lifecycle.stop(background())
await traceRunning
await metricRunning
if (
  typeof tracerProvider.getTracer !== "function" ||
  typeof meterProvider.getMeter !== "function"
) {
  throw new Error("official provider APIs were replaced")
}

console.log("otel-node-runtime ok")
