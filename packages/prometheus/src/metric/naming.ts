import type { InstrumentDescriptor } from "@go-like/core/metric"

const unitSuffix: Readonly<Record<string, string>> = Object.freeze({
  s: "seconds",
  ms: "milliseconds",
  By: "bytes",
  "1": ""
})

/** Replaces every character outside `[a-zA-Z0-9_]` with `_`. */
export function sanitizePrometheusName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]/g, "_")
}

/**
 * Maps one core instrument descriptor onto a Prometheus metric name.
 * Counters gain `_total`. Known units gain their suffix. `{...}` units do not.
 */
export function prometheusName(descriptor: InstrumentDescriptor): string {
  let name = sanitizePrometheusName(descriptor.name)
  const unit = descriptor.unit
  const suffix = unit.startsWith("{") ? "" : (unitSuffix[unit] ?? sanitizePrometheusName(unit))
  if (suffix !== "" && !name.endsWith(`_${suffix}`)) name = `${name}_${suffix}`
  if (descriptor.kind === "counter" && !name.endsWith("_total")) name = `${name}_total`
  return name
}
