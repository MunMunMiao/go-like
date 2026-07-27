import { Counter, Registry } from "prom-client"

const {
  createPrometheusHandler,
  measureBroker,
  measureClient,
  measureUnaryMiddleware,
  measureWebHandler,
  newRequestMetrics
} = await import("@likego/prometheus")
const registry = new Registry()
const counter = new Counter({
  name: "likego_runtime_smoke_total",
  help: "Runtime smoke counter.",
  registers: [registry]
})
counter.inc()
const metrics = newRequestMetrics(registry)
const measuredWeb = measureWebHandler(() => new Response("ok"), metrics)
const measured = measuredWeb(new Request("https://service.test/ready", { method: "POST" }))
if (!(measured instanceof Response) || measured.status !== 200) {
  throw new Error("request metrics did not preserve the synchronous Web Handler contract")
}
const response = await createPrometheusHandler(registry)(
  new Request("https://service.test/metrics")
)
const body = await response.text()
if (
  response.status !== 200 ||
  !body.includes("likego_runtime_smoke_total 1") ||
  !body.includes('likego_requests_total{component="web",operation="POST",outcome="success"} 1')
) {
  throw new Error("metrics runtime smoke failed")
}
if (
  typeof measureClient !== "function" ||
  typeof measureUnaryMiddleware !== "function" ||
  typeof measureBroker !== "function"
) {
  throw new Error("request metrics instrumentation exports are missing")
}
registry.clear()
