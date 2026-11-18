/**
 * Prometheus metric plug.
 * Adapts an application-owned prom-client Registry to core `MeterProvider`, and serves that
 * registry from a Web `Handler`. The handler stays on `./metric` as the documented exception.
 */
import type { MeterProvider } from "@go-like/core/metric"
import type { TelemetryLifecycle } from "@go-like/core/telemetry"

export { createPrometheusHandler, type PrometheusHandlerOptions } from "./handler"
export { newPrometheusMeterProvider } from "./meter"

/**
 * Meter provider over an application-owned registry.
 * `start` registers `target_info` once and resolves. `stop` resolves immediately.
 */
export interface PrometheusMeterProvider extends MeterProvider {
  readonly lifecycle: TelemetryLifecycle
}
