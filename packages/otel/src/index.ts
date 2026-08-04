import type { MeterProvider } from "@opentelemetry/sdk-metrics"
import type { TracerProvider } from "@opentelemetry/sdk-trace"

import { otelShutdownTimeout, newOtelServerWithProviders, type OtelOption } from "./runtime"
import type { OtelProviders, OtelServer } from "./types"

export { traceBroker } from "./broker"
export { measureClient, measureClientMiddleware, traceClient } from "./client"
export { defaultOtelShutdownTimeoutMs } from "./types"
export { otelShutdownTimeout }
export {
  newRequestMetrics,
  type RequestComponent,
  type RequestMetrics,
  type RequestOutcome
} from "./instrumentation"
export { measureUnaryMiddleware, traceUnaryMiddleware, traceWebHandler } from "./server"
export type {
  OtelAlreadyStartedError,
  OtelProviders,
  OtelServer,
  OtelShutdownTimeoutError
} from "./types"

/** Creates a lifecycle-only Server over official application-configured providers. */
export function newOtelServer(
  providers: OtelProviders,
  ...options: readonly OtelOption[] /* go-like-typed-rest: preserves the Go-style functional-option ABI. */
): OtelServer {
  const nativeProviders: {
    readonly tracerProvider?: TracerProvider
    readonly meterProvider?: MeterProvider
  } = providers
  return newOtelServerWithProviders(nativeProviders, options)
}
