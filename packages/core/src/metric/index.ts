/**
 * Metric entry.
 * Declares the meter socket and the lazy typed handles application code records through.
 */
import type { Context } from "../context/index"
import type { AttributeValue, Attributes, Scope, TelemetryLifecycle } from "../telemetry/types"
import { armInstrumentDiagnostics } from "../telemetry/internal/events"
import {
  newCounterHandle,
  newGaugeHandle,
  newHistogramHandle,
  newUpDownCounterHandle,
  recordHandle
} from "../telemetry/internal/instruments"

/** Instrument kind. */
export type InstrumentKind = "counter" | "up_down_counter" | "histogram" | "gauge"

/** Fully resolved instrument definition passed to a meter provider. */
export interface InstrumentDescriptor {
  readonly kind: InstrumentKind
  /** `^[A-Za-z][A-Za-z0-9_./-]{0,254}$` */
  readonly name: string
  /** UCUM unit. Empty when the caller did not set one. */
  readonly unit: string
  readonly description: string
  /** Complete attribute schema. Undeclared keys are dropped at record time. */
  readonly attributeKeys: readonly string[]
  /** Histogram bucket advice. Null asks the provider for its default. */
  readonly buckets: readonly number[] | null
}

/** One created instrument. Counters reject negative values. */
export interface Instrument {
  record(ctx: Context, value: number, attributes: Attributes): void
}

/**
 * Metric backend.
 * `instrument` is called at most once per provider and handle. `stop` before `start` must be accepted.
 */
export interface MeterProvider {
  instrument(scope: Scope, descriptor: InstrumentDescriptor): Instrument
  /** Native lifecycle owned by the bundle after admission. Absent for pull-only providers. */
  readonly lifecycle?: TelemetryLifecycle
}

/** Attributes accepted by a handle whose schema is `K`. An empty schema accepts no attributes. */
export type MetricAttributes<K extends string> = [K] extends [never]
  ? Readonly<Record<string, never>>
  : Readonly<Partial<Record<K, AttributeValue>>>

/** Options shared by every handle. `attributeKeys` is the complete label schema. */
export interface InstrumentOptions<K extends string> {
  readonly unit?: string
  readonly description?: string
  readonly attributeKeys?: readonly K[]
  /** Defaults to `{ name: "app" }`. */
  readonly scope?: Scope
}

/** Histogram options, including optional bucket advice. */
export interface HistogramOptions<K extends string> extends InstrumentOptions<K> {
  readonly buckets?: readonly number[]
}

/** Monotonic counter. `add` rejects a negative value when a meter is installed. */
export interface Counter<K extends string = never> {
  add(ctx: Context, value: number, attributes?: MetricAttributes<K>): void
}

/** Counter that accepts negative deltas. */
export interface UpDownCounter<K extends string = never> {
  add(ctx: Context, value: number, attributes?: MetricAttributes<K>): void
}

/** Distribution of observed values. */
export interface Histogram<K extends string = never> {
  record(ctx: Context, value: number, attributes?: MetricAttributes<K>): void
}

/** Current value of one measurement. */
export interface Gauge<K extends string = never> {
  record(ctx: Context, value: number, attributes?: MetricAttributes<K>): void
}

/** Creates a lazy counter. The provider instrument is created on first use. */
export function newCounter<const K extends string = never>(
  name: string,
  options?: InstrumentOptions<K>
): Counter<K> {
  armInstrumentDiagnostics()
  const handle = newCounterHandle(name, options)
  return {
    /** Records one non-negative sample into every meter on ctx. */
    add(ctx: Context, value: number, attributes?: MetricAttributes<K>): void {
      recordHandle(ctx, handle, value, attributes)
    }
  }
}

/** Creates a lazy up-down counter. */
export function newUpDownCounter<const K extends string = never>(
  name: string,
  options?: InstrumentOptions<K>
): UpDownCounter<K> {
  armInstrumentDiagnostics()
  const handle = newUpDownCounterHandle(name, options)
  return {
    /** Records one sample into every meter on ctx. */
    add(ctx: Context, value: number, attributes?: MetricAttributes<K>): void {
      recordHandle(ctx, handle, value, attributes)
    }
  }
}

/** Creates a lazy histogram. */
export function newHistogram<const K extends string = never>(
  name: string,
  options?: HistogramOptions<K>
): Histogram<K> {
  armInstrumentDiagnostics()
  const handle = newHistogramHandle(name, options)
  return {
    /** Records one observation into every meter on ctx. */
    record(ctx: Context, value: number, attributes?: MetricAttributes<K>): void {
      recordHandle(ctx, handle, value, attributes)
    }
  }
}

/** Creates a lazy gauge. */
export function newGauge<const K extends string = never>(
  name: string,
  options?: InstrumentOptions<K>
): Gauge<K> {
  armInstrumentDiagnostics()
  const handle = newGaugeHandle(name, options)
  return {
    /** Records the current value into every meter on ctx. */
    record(ctx: Context, value: number, attributes?: MetricAttributes<K>): void {
      recordHandle(ctx, handle, value, attributes)
    }
  }
}
