import type { Context } from "@go-like/core/context"
import type { Instrument, InstrumentDescriptor } from "@go-like/core/metric"
import { spanFromContext } from "@go-like/core/trace"
import type { Attributes, Scope } from "@go-like/core/telemetry"
import type { AttributeValue } from "@go-like/core/telemetry"
import type {
  Context as OtelContext,
  MeterProvider as ApiMeterProvider,
  MetricOptions
} from "@opentelemetry/api"

import { bridgedContext, otelAttributes } from "./bridge"
import { providerLifecycle, readShutdownTimeout } from "./lifecycle"
import type { OtelMeterProvider, OtelMetricsOptions, Shutdownable } from "./types"

function instrumentKey(scope: Scope, descriptor: InstrumentDescriptor): string {
  return JSON.stringify([
    scope.name,
    scope.version ?? null,
    descriptor.kind,
    descriptor.name,
    descriptor.unit,
    descriptor.description,
    descriptor.attributeKeys,
    descriptor.buckets
  ])
}

function declaredAttributes(
  keys: readonly string[],
  attributes: Attributes
): ReturnType<typeof otelAttributes> {
  if (keys.length === 0) return otelAttributes({})
  const allowed = new Set(keys)
  const selected: Record<string, AttributeValue> = {}
  for (const key of Object.keys(attributes)) {
    if (!allowed.has(key)) continue
    const value = attributes[key]
    if (value !== undefined) selected[key] = value
  }
  return otelAttributes(selected)
}

/**
 * Adapts an application SDK MeterProvider.
 * Each descriptor is one native instrument. Exemplar context is attached only for a span this plug created.
 */
export function newOtelMeterProvider(
  provider: ApiMeterProvider & Shutdownable,
  options: OtelMetricsOptions = {}
): OtelMeterProvider {
  if (typeof provider?.getMeter !== "function" || typeof provider.shutdown !== "function") {
    throw new TypeError("provider must be an OpenTelemetry SDK MeterProvider")
  }
  const instruments = new Map<string, Instrument>()
  const lifecycle = providerLifecycle(provider, readShutdownTimeout(options.shutdownTimeoutMs))
  return Object.freeze({
    instrument(scope: Scope, descriptor: InstrumentDescriptor): Instrument {
      const key = instrumentKey(scope, descriptor)
      const cached = instruments.get(key)
      if (cached !== undefined) return cached
      const meter =
        scope.version === undefined
          ? provider.getMeter(scope.name)
          : provider.getMeter(scope.name, scope.version)
      const metricOptions: MetricOptions = {
        ...(descriptor.unit === "" ? {} : { unit: descriptor.unit }),
        ...(descriptor.description === "" ? {} : { description: descriptor.description }),
        ...(descriptor.buckets === null
          ? {}
          : { advice: { explicitBucketBoundaries: [...descriptor.buckets] } })
      }
      const exemplar = (ctx: Context): OtelContext | undefined =>
        bridgedContext(spanFromContext(ctx))
      let created: Instrument
      switch (descriptor.kind) {
        case "counter": {
          const counter = meter.createCounter(descriptor.name, metricOptions)
          created = {
            record: (ctx, value, attributes) => {
              counter.add(
                value,
                declaredAttributes(descriptor.attributeKeys, attributes),
                exemplar(ctx)
              )
            }
          }
          break
        }
        case "up_down_counter": {
          const counter = meter.createUpDownCounter(descriptor.name, metricOptions)
          created = {
            record: (ctx, value, attributes) => {
              counter.add(
                value,
                declaredAttributes(descriptor.attributeKeys, attributes),
                exemplar(ctx)
              )
            }
          }
          break
        }
        case "histogram": {
          const histogram = meter.createHistogram(descriptor.name, metricOptions)
          created = {
            record: (ctx, value, attributes) => {
              histogram.record(
                value,
                declaredAttributes(descriptor.attributeKeys, attributes),
                exemplar(ctx)
              )
            }
          }
          break
        }
        case "gauge": {
          const gauge = meter.createGauge(descriptor.name, metricOptions)
          created = {
            record: (ctx, value, attributes) => {
              gauge.record(
                value,
                declaredAttributes(descriptor.attributeKeys, attributes),
                exemplar(ctx)
              )
            }
          }
          break
        }
      }
      instruments.set(key, created)
      return created
    },
    lifecycle
  })
}
