/**
 * Compile-time drift guard against `@opentelemetry/api` and the SDK provider types.
 * A new span kind, severity number, or SDK shape that the bridge cannot accept fails here.
 */
import type { LogSeverityNumber } from "@go-like/core/telemetry/provider"
import type { Attributes as CoreAttributes } from "@go-like/core/telemetry"
import type { CarrierReader, CarrierWriter, SpanKind } from "@go-like/core/trace"
import type {
  Attributes as OtelAttributes,
  MeterProvider as ApiMeterProvider,
  SeverityNumber,
  SpanKind as OtelSpanKind,
  TextMapGetter,
  TextMapSetter,
  TracerProvider as ApiTracerProvider
} from "@opentelemetry/api"
import type { MeterProvider as SdkMeterProvider } from "@opentelemetry/sdk-metrics"
import type { TracerProvider as SdkTracerProvider } from "@opentelemetry/sdk-trace"

import type { Shutdownable } from "../src/index"
import type * as logs from "../src/log"
import type * as metrics from "../src/metric"
import type * as propagation from "../src/propagation"
import type * as traces from "../src/trace"
import type * as lifecycle from "../src/lifecycle"
import type * as pub from "../src/index"
import { otelSpanKinds } from "../src/trace"

type Assert<T extends true> = T
type Extends<A, B> = [A] extends [B] ? true : false

export type SdkTracerAccepted = Assert<Extends<SdkTracerProvider, ApiTracerProvider & Shutdownable>>
export type SdkMeterAccepted = Assert<Extends<SdkMeterProvider, ApiMeterProvider & Shutdownable>>
export type AttributesAccepted = Assert<Extends<CoreAttributes, OtelAttributes>>
export type DebugSeverity = Assert<
  Extends<(typeof LogSeverityNumber)["debug"], SeverityNumber.DEBUG>
>
export type InfoSeverity = Assert<Extends<(typeof LogSeverityNumber)["info"], SeverityNumber.INFO>>
export type WarnSeverity = Assert<Extends<(typeof LogSeverityNumber)["warn"], SeverityNumber.WARN>>
export type ErrorSeverity = Assert<
  Extends<(typeof LogSeverityNumber)["error"], SeverityNumber.ERROR>
>

/** A new core `SpanKind` fails this assignment and the map in `trace.ts`. */
export const kinds: Readonly<Record<SpanKind, OtelSpanKind>> = otelSpanKinds

export const getter: TextMapGetter<CarrierReader> = {
  get: (source, key) => source.get(key) ?? undefined,
  keys: (source) => [...source.keys()]
}
export const setter: TextMapSetter<CarrierWriter> = {
  set: (target, key, value) => {
    target.set(key, value)
  }
}

export type TracerProviderImplemented = Assert<
  Extends<typeof traces.newOtelTracerProvider, typeof pub.newOtelTracerProvider>
>
export type MeterProviderImplemented = Assert<
  Extends<typeof metrics.newOtelMeterProvider, typeof pub.newOtelMeterProvider>
>
export type LogHandlerImplemented = Assert<
  Extends<typeof logs.newOtelLogHandler, typeof pub.newOtelLogHandler>
>
export type PropagatorImplemented = Assert<
  Extends<typeof propagation.newOtelPropagator, typeof pub.newOtelPropagator>
>
export type DefaultTimeoutImplemented = Assert<
  Extends<typeof lifecycle.defaultOtelShutdownTimeoutMs, typeof pub.defaultOtelShutdownTimeoutMs>
>
