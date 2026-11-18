import type { Context } from "@go-like/core/context"
import type { Instrument, InstrumentDescriptor } from "@go-like/core/metric"
import type { Attributes, Scope, TelemetryLifecycle } from "@go-like/core/telemetry"
import { resourceFromContext } from "@go-like/core/telemetry/provider"
import { Counter, Gauge, Histogram, type Registry, type RegistryContentType } from "prom-client"

import { prometheusName, sanitizePrometheusName } from "./naming"

/** Label values prom-client accepts for one sample. */
type LabelValue = string | number

/** Keeps only declared attributes and renames `.` to `_` in the label key. */
function labels(
  keys: ReadonlyMap<string, string>,
  attributes: Attributes
): Record<string, LabelValue> {
  const out: Record<string, LabelValue> = {}
  for (const [key, value] of Object.entries(attributes)) {
    const label = keys.get(key)
    if (label === undefined) continue
    out[label] =
      typeof value === "number" ? value : Array.isArray(value) ? value.join(",") : String(value)
  }
  return out
}

/** Rejects values that do not expose the prom-client registry read contract. */
function requireRegistry(registry: Registry<RegistryContentType>): Registry<RegistryContentType> {
  if (typeof registry?.getSingleMetric !== "function" || typeof registry.metrics !== "function") {
    throw new TypeError("registry must be a prom-client Registry")
  }
  return registry
}

/**
 * Adapts an application-owned prom-client Registry to core `MeterProvider`.
 * The registry is never the prom-client global. `start` registers `target_info` and returns.
 */
export function newPrometheusMeterProvider(registry: Registry<RegistryContentType>) {
  const owned = requireRegistry(registry)
  const created = new Map<
    string,
    { readonly kind: InstrumentDescriptor["kind"]; readonly instrument: Instrument }
  >()
  const lifecycle: TelemetryLifecycle = Object.freeze({
    start(ctx: Context): Promise<void> {
      const resource = resourceFromContext(ctx)
      const resourceKeys = Object.keys(resource)
      if (resourceKeys.length > 0 && owned.getSingleMetric("target_info") === undefined) {
        const labelNames = resourceKeys.map(sanitizePrometheusName)
        const info = new Gauge({
          name: "target_info",
          help: "Target metadata",
          labelNames,
          registers: [owned]
        })
        info.set(
          labels(
            new Map(resourceKeys.map((key) => [key, sanitizePrometheusName(key)] as const)),
            resource
          ),
          1
        )
      }
      return Promise.resolve()
    },
    stop(_ctx: Context): Promise<void> {
      return Promise.resolve()
    }
  })
  return Object.freeze({
    instrument(_scope: Scope, descriptor: InstrumentDescriptor): Instrument {
      const name = prometheusName(descriptor)
      const existing = created.get(name)
      if (existing !== undefined) {
        if (existing.kind !== descriptor.kind) {
          throw new TypeError(`metric ${name} already registered as ${existing.kind}`)
        }
        return existing.instrument
      }
      const keys = new Map(
        descriptor.attributeKeys.map((key) => [key, sanitizePrometheusName(key)] as const)
      )
      const labelNames = [...keys.values()]
      const help = descriptor.description === "" ? descriptor.name : descriptor.description
      let instrument: Instrument
      switch (descriptor.kind) {
        case "counter": {
          const counter = new Counter({ name, help, labelNames, registers: [owned] })
          instrument = {
            record(_ctx, value, attributes): void {
              counter.inc(labels(keys, attributes), value)
            }
          }
          break
        }
        case "up_down_counter": {
          const gauge = new Gauge({ name, help, labelNames, registers: [owned] })
          instrument = {
            record(_ctx, value, attributes): void {
              gauge.inc(labels(keys, attributes), value)
            }
          }
          break
        }
        case "gauge": {
          const gauge = new Gauge({ name, help, labelNames, registers: [owned] })
          instrument = {
            record(_ctx, value, attributes): void {
              gauge.set(labels(keys, attributes), value)
            }
          }
          break
        }
        case "histogram": {
          const histogram = new Histogram({
            name,
            help,
            labelNames,
            registers: [owned],
            ...(descriptor.buckets === null ? {} : { buckets: [...descriptor.buckets] })
          })
          instrument = {
            record(_ctx, value, attributes): void {
              histogram.observe(labels(keys, attributes), value)
            }
          }
          break
        }
      }
      created.set(name, { kind: descriptor.kind, instrument })
      return instrument
    },
    lifecycle
  })
}
