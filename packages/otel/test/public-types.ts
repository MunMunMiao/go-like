import type { LogHandler } from "@go-like/core/log"
import type { MeterProvider } from "@go-like/core/metric"
import type { TelemetryLifecycle } from "@go-like/core/telemetry"
import type { Propagator, TracerProvider } from "@go-like/core/trace"
import type {
  LoggerProvider,
  MeterProvider as ApiMeterProvider,
  TextMapPropagator,
  TracerProvider as ApiTracerProvider
} from "@opentelemetry/api"
import type { MeterProvider as SdkMeterProvider } from "@opentelemetry/sdk-metrics"
import type { TracerProvider as SdkTracerProvider } from "@opentelemetry/sdk-trace"

import {
  newOtelLogHandler,
  newOtelMeterProvider,
  newOtelPropagator,
  newOtelTracerProvider,
  type OtelAlreadyStartedError,
  type OtelContextManagerMissingError,
  type OtelLogHandler,
  type OtelLogsOptions,
  type OtelMeterProvider,
  type OtelMetricsOptions,
  type OtelShutdownTimeoutError,
  type OtelTracerProvider,
  type OtelTracingOptions,
  type Shutdownable
} from "../src/index"

declare const sdkTracer: SdkTracerProvider
declare const sdkMeter: SdkMeterProvider
declare const apiTracer: ApiTracerProvider & Shutdownable
declare const apiMeter: ApiMeterProvider & Shutdownable
declare const apiLogger: LoggerProvider & Shutdownable
declare const textMap: TextMapPropagator

const tracingOptions: OtelTracingOptions = {
  shutdownTimeoutMs: 25_000,
  implicitParent: false,
  requireContextManager: true
}
const metricsOptions: OtelMetricsOptions = { shutdownTimeoutMs: 0 }
const logsOptions: OtelLogsOptions = {
  scope: { name: "go-like", version: "1" },
  shutdownTimeoutMs: 1
}
const tracer: OtelTracerProvider = newOtelTracerProvider(sdkTracer, tracingOptions)
const fromApiTracer: OtelTracerProvider = newOtelTracerProvider(apiTracer)
const meter: OtelMeterProvider = newOtelMeterProvider(sdkMeter, metricsOptions)
const fromApiMeter: OtelMeterProvider = newOtelMeterProvider(apiMeter)
const logs: OtelLogHandler = newOtelLogHandler(apiLogger, logsOptions)
const propagator: Propagator = newOtelPropagator(textMap)
const asTracer: TracerProvider = tracer
const asMeter: MeterProvider = meter
const asLogs: LogHandler = logs
const lifecycle: TelemetryLifecycle = tracer.lifecycle

declare const alreadyStarted: OtelAlreadyStartedError
declare const shutdownTimeout: OtelShutdownTimeoutError
declare const contextManagerMissing: OtelContextManagerMissingError
const startedCode: "GO_LIKE_OTEL_ALREADY_STARTED" = alreadyStarted.code
const startedStatus: OtelAlreadyStartedError["status"] = alreadyStarted.status
const timeoutCode: "GO_LIKE_OTEL_SHUTDOWN_TIMEOUT" = shutdownTimeout.code
const timeoutMs: number = shutdownTimeout.timeoutMs
const missingCode: "GO_LIKE_OTEL_CONTEXT_MANAGER_MISSING" = contextManagerMissing.code

void fromApiTracer
void fromApiMeter
void asTracer
void asMeter
void asLogs
void lifecycle
void propagator
void startedCode
void startedStatus
void timeoutCode
void timeoutMs
void missingCode
