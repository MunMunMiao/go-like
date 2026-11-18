import { expect, test } from "bun:test"

import { background } from "@go-like/core/context"
import { LogField } from "@go-like/core/telemetry"
import { LogSeverityNumber, withRemoteSpanContext } from "@go-like/core/telemetry/provider"
import {
  logHandlerConformance,
  meterProviderConformance,
  propagatorConformance,
  tracerProviderConformance,
  type LogHandlerSubject,
  type MeterProviderSubject,
  type TracerProviderSubject
} from "@go-like/core/testing"
import type { SpanContext } from "@go-like/core/trace"
import {
  context,
  trace,
  type Context as OtelContext,
  type SpanContext as OtelSpanContext
} from "@opentelemetry/api"
import { ExportResultCode, W3CTraceContextPropagator } from "@opentelemetry/core"
import {
  AggregationTemporality,
  DataPointType,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type ResourceMetrics
} from "@opentelemetry/sdk-metrics"
import {
  SimpleSpanProcessor,
  TracerProvider,
  type ReadableSpan,
  type SpanExporter
} from "@opentelemetry/sdk-trace"

import {
  newOtelLogHandler,
  newOtelMeterProvider,
  newOtelPropagator,
  newOtelTracerProvider,
  type OtelLogHandler
} from "../src/index"

const remoteContext: SpanContext = Object.freeze({
  traceId: "0123456789abcdef0123456789abcdef",
  spanId: "0123456789abcdef",
  traceFlags: 1,
  traceState: "congo=t61rcWkgMzE",
  isRemote: true
})

/** Runs socket cases in order. Later cases shut the shared provider down. */
async function runCases(
  cases: readonly { readonly name: string; run: () => Promise<void> }[]
): Promise<void> {
  for (const item of cases) {
    try {
      await item.run()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`${item.name}: ${message}`)
    }
  }
}

/** Keeps finished spans after provider shutdown. The SDK memory exporter clears them. */
function retainingExporter(): { readonly exporter: SpanExporter; readonly spans: ReadableSpan[] } {
  const spans: ReadableSpan[] = []
  return {
    spans,
    exporter: {
      export(batch, resultCallback) {
        spans.push(...batch)
        resultCallback({ code: ExportResultCode.SUCCESS })
      },
      shutdown() {
        return Promise.resolve()
      },
      forceFlush() {
        return Promise.resolve()
      }
    }
  }
}

function spanContextOf(value: OtelSpanContext): SpanContext {
  return Object.freeze({
    traceId: value.traceId,
    spanId: value.spanId,
    traceFlags: value.traceFlags,
    traceState: value.traceState?.serialize() ?? "",
    isRemote: value.isRemote === true
  })
}

function tracerSubject(): TracerProviderSubject & { readonly close: () => Promise<void> } {
  const retained = retainingExporter()
  const native = new TracerProvider({
    spanProcessors: [new SimpleSpanProcessor({ exporter: retained.exporter })]
  })
  const provider = newOtelTracerProvider(native)
  return {
    provider,
    implicitSpanContext() {
      const active = trace.getSpan(context.active())
      return active === undefined ? null : spanContextOf(active.spanContext())
    },
    finished() {
      return Promise.resolve(
        retained.spans.map((span) =>
          Object.freeze({
            name: span.name,
            context: spanContextOf(span.spanContext()),
            parentSpanId: span.parentSpanContext?.spanId ?? null,
            links: span.links.map((link) => spanContextOf(link.context))
          })
        )
      )
    },
    close: () => provider.lifecycle.stop(background())
  }
}

function metricValue(
  dataPointType: DataPointType,
  value: number | { readonly sum?: number }
): number | undefined {
  if (dataPointType === DataPointType.HISTOGRAM && typeof value === "object") return value.sum
  return typeof value === "number" ? value : undefined
}

function metricRows(resources: readonly ResourceMetrics[]): {
  readonly name: string
  readonly attributes: Readonly<Record<string, string | number | boolean>>
  readonly value: number
}[] {
  const latest = resources.at(-1)
  if (latest === undefined) return []
  const rows: {
    readonly name: string
    readonly attributes: Readonly<Record<string, string | number | boolean>>
    readonly value: number
  }[] = []
  for (const scope of latest.scopeMetrics) {
    for (const metric of scope.metrics) {
      for (const point of metric.dataPoints) {
        const value = metricValue(metric.dataPointType, point.value)
        if (value === undefined) continue
        const attributes: Record<string, string | number | boolean> = {}
        for (const [key, attribute] of Object.entries(point.attributes)) {
          if (
            typeof attribute === "string" ||
            typeof attribute === "number" ||
            typeof attribute === "boolean"
          ) {
            attributes[key] = attribute
          }
        }
        rows.push(
          Object.freeze({
            name: metric.descriptor.name,
            attributes: Object.freeze(attributes),
            value
          })
        )
      }
    }
  }
  return rows
}

function meterSubject(): MeterProviderSubject & { readonly close: () => Promise<void> } {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 })
  const native = new MeterProvider({ readers: [reader] })
  const provider = newOtelMeterProvider(native)
  return {
    provider,
    async collect() {
      try {
        await reader.forceFlush()
      } catch {
        // Shutdown already flushed the reader. The exporter still holds the last snapshot.
      }
      return metricRows(exporter.getMetrics())
    },
    close: () => provider.lifecycle.stop(background())
  }
}

interface StoredLog {
  readonly body: unknown
  readonly eventName: string | undefined
  readonly exception: unknown
  readonly attributes: Readonly<Record<string, unknown>> | undefined
  readonly context: OtelContext | undefined
  readonly severityNumber: number | undefined
}

function logSubject(): LogHandlerSubject & { readonly handlers: OtelLogHandler[] } {
  const stored: StoredLog[] = []
  const handlers: OtelLogHandler[] = []
  return {
    handlers,
    newHandler() {
      let shutdowns = 0
      const handler = newOtelLogHandler({
        getLogger(name: string, version?: string) {
          expect(name).toBe("go-like")
          expect(version).toBeUndefined()
          return {
            enabled: () => true,
            emit(record: {
              readonly body?: unknown
              readonly eventName?: string
              readonly exception?: unknown
              readonly attributes?: Readonly<Record<string, unknown>>
              readonly context?: OtelContext
              readonly severityNumber?: number
            }) {
              stored.push({
                body: record.body,
                eventName: record.eventName,
                exception: record.exception,
                attributes: record.attributes,
                context: record.context,
                severityNumber: record.severityNumber
              })
            }
          }
        },
        shutdown() {
          shutdowns += 1
          expect(shutdowns).toBe(1)
          return Promise.resolve()
        }
      } as never)
      handlers.push(handler)
      return handler
    },
    written() {
      return Promise.resolve(
        stored.map((record) => {
          const span =
            record.context === undefined ? undefined : trace.getSpanContext(record.context)
          const row: Record<string, unknown> = { message: record.body }
          if (record.eventName !== undefined && record.eventName !== "")
            row[LogField.event] = record.eventName
          if (span !== undefined) {
            row[LogField.traceId] = span.traceId
            row[LogField.spanId] = span.spanId
            row[LogField.traceFlags] = span.traceFlags.toString(16).padStart(2, "0")
          }
          if (record.exception !== undefined) row.exception = record.exception
          return Object.freeze(row)
        })
      )
    }
  }
}

test("tracer, meter, log, and propagator sockets", async () => {
  const traces = tracerSubject()
  const meters = meterSubject()
  const logs = logSubject()
  try {
    await runCases(tracerProviderConformance(traces))
    await runCases(meterProviderConformance(meters))
    await runCases(logHandlerConformance(logs))
    await runCases(propagatorConformance(() => newOtelPropagator(new W3CTraceContextPropagator())))
    expect(logs.handlers.length).toBeGreaterThan(0)
    const traced = withRemoteSpanContext(background(), remoteContext)
    expect(LogSeverityNumber.info).toBe(9)
    void traced
  } finally {
    await traces.close()
    await meters.close()
  }
})
