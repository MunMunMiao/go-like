import { background } from "@go-like/core/context"
import { Counter, Registry } from "prom-client"

const { createPrometheusHandler, newPrometheusMeterProvider } =
  await import("@go-like/prometheus/metric")
const registry = new Registry()
const raw = new Counter({
  name: "go_like_e2e_runtime_total",
  help: "Runtime E2E counter.",
  registers: [registry]
})
raw.inc()
const provider = newPrometheusMeterProvider(registry)
const measured = provider.instrument(
  { name: "e2e" },
  {
    kind: "counter",
    name: "go_like.requests",
    unit: "1",
    description: "Requests observed by the meter provider.",
    attributeKeys: ["operation"],
    buckets: null
  }
)
measured.record(background(), 1, { operation: "POST" })
await provider.lifecycle.start(background())
const response = await createPrometheusHandler(registry)(
  new Request("https://service.test/metrics")
)
const body = await response.text()
if (
  response.status !== 200 ||
  !body.includes("go_like_e2e_runtime_total 1") ||
  !body.includes('go_like_requests_total{operation="POST"} 1')
) {
  throw new Error("metrics runtime E2E failed")
}
registry.clear()
