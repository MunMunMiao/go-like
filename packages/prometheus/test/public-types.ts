import { background } from "@go-like/core/context"
import type { MeterProvider } from "@go-like/core/metric"
import type { TelemetryLifecycle } from "@go-like/core/telemetry"
import type { Handler } from "@go-like/core/web"
import {
  createPrometheusHandler,
  newPrometheusMeterProvider,
  type PrometheusHandlerOptions,
  type PrometheusMeterProvider
} from "@go-like/prometheus/metric"
import { Registry } from "prom-client"

const registry: Registry = new Registry()
const options: PrometheusHandlerOptions = { path: "/internal/metrics" }
const provider: PrometheusMeterProvider = newPrometheusMeterProvider(registry)
const asMeter: MeterProvider = provider
const lifecycle: TelemetryLifecycle = provider.lifecycle
const started: Promise<void> = lifecycle.start(background())
const stopped: Promise<void> = lifecycle.stop(background())
const handler: Handler = createPrometheusHandler(registry, options)

void [asMeter, started, stopped, handler]
