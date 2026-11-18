/**
 * OpenTelemetry plug.
 * Adapts application-owned SDK providers to the core trace, metric, log, and propagation sockets.
 * The package depends only on `@opentelemetry/api`. The application registers a ContextManager and
 * does not register a global propagator.
 */
export { defaultOtelShutdownTimeoutMs } from "./lifecycle"
export { newOtelLogHandler } from "./log"
export { newOtelMeterProvider } from "./metric"
export { newOtelPropagator } from "./propagation"
export { newOtelTracerProvider } from "./trace"
export type {
  OtelAlreadyStartedError,
  OtelContextManagerMissingError,
  OtelLogHandler,
  OtelLogsOptions,
  OtelMeterProvider,
  OtelMetricsOptions,
  OtelShutdownTimeoutError,
  OtelTracerProvider,
  OtelTracingOptions,
  Shutdownable
} from "./types"
