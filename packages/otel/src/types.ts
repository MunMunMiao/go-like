import type { Server } from "@likego/core"
import type { MeterProvider } from "@opentelemetry/sdk-metrics"
import type { TracerProvider } from "@opentelemetry/sdk-trace"

/** Default owner wait boundary; it never claims that a provider is terminal. */
export const defaultOtelShutdownTimeoutMs = 25_000

/** Official providers configured by the application through OpenTelemetry APIs. */
export interface OtelProviders {
  readonly tracerProvider?: TracerProvider
  readonly meterProvider?: MeterProvider
}

/** Lifecycle-only structural Server for application-configured native providers. */
export interface OtelServer extends Server {}

export interface OtelAlreadyStartedError extends Error {
  readonly name: "OtelAlreadyStartedError"
  readonly code: "LIKEGO_OTEL_ALREADY_STARTED"
  readonly status: "starting" | "running" | "stopping" | "stopped" | "failed"
}

export interface OtelShutdownTimeoutError extends Error {
  readonly name: "OtelShutdownTimeoutError"
  readonly code: "LIKEGO_OTEL_SHUTDOWN_TIMEOUT"
  readonly timeoutMs: number
}
