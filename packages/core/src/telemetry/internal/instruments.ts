import type { Context } from "../../context/index"
import type {
  Instrument,
  InstrumentDescriptor,
  InstrumentKind,
  MeterProvider
} from "../../metric/index"
import type { AttributeValue, Attributes, Scope } from "../types"

/** Attributes a caller may pass, including omitted keys. */
type RecordAttributes = Readonly<Record<string, AttributeValue | undefined>>
import { coreVersion } from "../../internal/version"
import { AttributeKey, MetricName } from "../semconv"
import type { Attributes as TelemetryAttributes } from "../types"

import { stateFrom } from "./state"

const instrumentName = /^[A-Za-z][A-Za-z0-9_./-]{0,254}$/
const durationBuckets = Object.freeze([
  0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10
])
const jobBuckets = Object.freeze([0.01, 0.1, 0.5, 1, 5, 10, 30, 60, 300, 900, 3600])
const coreInstrumentScope: Scope = Object.freeze({ name: "go-like", version: coreVersion })
const appScope: Scope = Object.freeze({ name: "app" })

/** Cached instrument handle. Provider instruments are created on first use. */
interface Handle {
  readonly kind: InstrumentKind
  readonly descriptor: InstrumentDescriptor
  readonly scope: Scope
  readonly cache: Map<MeterProvider, Instrument | null>
}

type FailureReporter = (ctx: Context, name: string, error: unknown) => void

/** Default reporter. Diagnostics are installed once the log path is loaded. */
function ignoreInstrumentFailure(): void {}

let reportFailure: FailureReporter = ignoreInstrumentFailure

/** Installs the one reporter used when `MeterProvider.instrument` throws. */
export function onInstrumentFailure(report: FailureReporter): void {
  if (reportFailure === ignoreInstrumentFailure) ignoreInstrumentFailure()
  reportFailure = report
}

/** Creates a lazy counter handle. */
export function newCounterHandle(
  name: string,
  options?: {
    readonly unit?: string
    readonly description?: string
    readonly attributeKeys?: readonly string[]
    readonly scope?: Scope
  }
): Handle {
  return createHandle("counter", name, options, null)
}

/** Creates a lazy up-down counter handle. */
export function newUpDownCounterHandle(
  name: string,
  options?: {
    readonly unit?: string
    readonly description?: string
    readonly attributeKeys?: readonly string[]
    readonly scope?: Scope
  }
): Handle {
  return createHandle("up_down_counter", name, options, null)
}

/** Creates a lazy histogram handle. */
export function newHistogramHandle(
  name: string,
  options?: {
    readonly unit?: string
    readonly description?: string
    readonly attributeKeys?: readonly string[]
    readonly scope?: Scope
    readonly buckets?: readonly number[]
  }
): Handle {
  return createHandle("histogram", name, options, options?.buckets ?? null)
}

/** Creates a lazy gauge handle. */
export function newGaugeHandle(
  name: string,
  options?: {
    readonly unit?: string
    readonly description?: string
    readonly attributeKeys?: readonly string[]
    readonly scope?: Scope
  }
): Handle {
  return createHandle("gauge", name, options, null)
}

/** Records one value into every meter installed on ctx. No meters means one lookup and return. */
export function recordHandle(
  ctx: Context,
  handle: Handle,
  value: number,
  attributes?: RecordAttributes
): void {
  const meters = stateFrom(ctx)?.meters
  if (meters === undefined || meters.length === 0) return
  if (!Number.isFinite(value)) throw new RangeError("metric value must be a finite number")
  if (handle.kind === "counter" && value < 0) {
    throw new RangeError("counter value must not be negative")
  }
  const filtered = filterAttributes(handle.descriptor.attributeKeys, attributes)
  for (const provider of meters) {
    const instrument = resolveInstrument(ctx, provider, handle)
    if (instrument === null) continue
    try {
      instrument.record(ctx, value, filtered)
    } catch {
      // A provider record failure stays inside the instrument call.
    }
  }
}

/** Adds one core counter sample. */
export function recordCoreCounter(
  ctx: Context,
  name: string,
  value: number,
  attributes?: TelemetryAttributes
): void {
  recordHandle(ctx, coreHandle(name), value, attributes)
}

/** Records one core histogram sample. */
export function recordCoreHistogram(
  ctx: Context,
  name: string,
  value: number,
  attributes?: TelemetryAttributes
): void {
  recordHandle(ctx, coreHandle(name), value, attributes)
}

/** Records one core gauge sample. */
export function recordCoreGauge(ctx: Context, name: string, value: number): void {
  recordHandle(ctx, coreHandle(name), value)
}

/** Adjusts the in-flight HTTP request gauge by `delta`. */
export function recordHttpActive(
  ctx: Context,
  method: string,
  scheme: "http" | "https",
  delta: number
): void {
  recordHandle(ctx, coreHandle(MetricName.httpServerActiveRequests), delta, {
    [AttributeKey.httpRequestMethod]: method,
    [AttributeKey.urlScheme]: scheme
  })
}

/** Duration histogram buckets core advises, in seconds. */
export function durationBucketAdvice(): readonly number[] {
  return durationBuckets
}

/** Job duration histogram buckets core advises, in seconds. */
export function jobBucketAdvice(): readonly number[] {
  return jobBuckets
}

const coreHandles = new Map<string, Handle>()

/** Returns the process-wide handle for one core metric. */
function coreHandle(name: string): Handle {
  const existing = coreHandles.get(name)
  if (existing !== undefined) return existing
  const created = createCoreHandle(name)
  coreHandles.set(name, created)
  return created
}

/** Builds one core metric handle from the semantic-convention catalog. */
function createCoreHandle(name: string): Handle {
  switch (name) {
    case MetricName.rpcServerCallDuration:
    case MetricName.rpcClientCallDuration:
      return createHandle(
        "histogram",
        name,
        {
          unit: "s",
          description: "RPC call duration",
          attributeKeys: [
            AttributeKey.rpcSystemName,
            AttributeKey.rpcMethod,
            AttributeKey.rpcStatusCode,
            AttributeKey.errorType
          ],
          scope: coreInstrumentScope
        },
        durationBuckets
      )
    case MetricName.rpcStreamMessages:
      return createHandle(
        "counter",
        name,
        {
          unit: "{message}",
          description: "RPC stream messages",
          attributeKeys: [
            AttributeKey.rpcSystemName,
            AttributeKey.rpcMethod,
            AttributeKey.rpcDirection
          ],
          scope: coreInstrumentScope
        },
        null
      )
    case MetricName.httpServerRequestDuration:
      return createHandle(
        "histogram",
        name,
        {
          unit: "s",
          description: "HTTP server request duration",
          attributeKeys: [
            AttributeKey.httpRequestMethod,
            AttributeKey.httpResponseStatusCode,
            AttributeKey.urlScheme,
            AttributeKey.errorType
          ],
          scope: coreInstrumentScope
        },
        durationBuckets
      )
    case MetricName.httpServerActiveRequests:
      return createHandle(
        "up_down_counter",
        name,
        {
          unit: "{request}",
          description: "HTTP server active requests",
          attributeKeys: [AttributeKey.httpRequestMethod, AttributeKey.urlScheme],
          scope: coreInstrumentScope
        },
        null
      )
    case MetricName.messagingClientOperationDuration:
      return createHandle(
        "histogram",
        name,
        {
          unit: "s",
          description: "Messaging client operation duration",
          attributeKeys: [
            AttributeKey.messagingSystemName,
            AttributeKey.messagingOperationName,
            AttributeKey.messagingOperationType,
            AttributeKey.errorType
          ],
          scope: coreInstrumentScope
        },
        durationBuckets
      )
    case MetricName.messagingProcessDuration:
      return createHandle(
        "histogram",
        name,
        {
          unit: "s",
          description: "Messaging process duration",
          attributeKeys: [
            AttributeKey.messagingSystemName,
            AttributeKey.messagingOperationName,
            AttributeKey.errorType
          ],
          scope: coreInstrumentScope
        },
        durationBuckets
      )
    case MetricName.jobRunDuration:
      return createHandle(
        "histogram",
        name,
        {
          unit: "s",
          description: "Job run duration",
          attributeKeys: [
            AttributeKey.jobName,
            AttributeKey.jobTrigger,
            AttributeKey.jobSystem,
            AttributeKey.errorType
          ],
          scope: coreInstrumentScope
        },
        jobBuckets
      )
    case MetricName.appReady:
      return createHandle(
        "gauge",
        name,
        { unit: "1", description: "Application readiness", scope: coreInstrumentScope },
        null
      )
    case MetricName.configReloads:
      return createHandle(
        "counter",
        name,
        {
          unit: "{reload}",
          description: "Configuration reloads",
          attributeKeys: [AttributeKey.errorType],
          scope: coreInstrumentScope
        },
        null
      )
    case MetricName.registryWatchUpdates:
      return createHandle(
        "counter",
        name,
        {
          unit: "{update}",
          description: "Registry watch updates",
          attributeKeys: [AttributeKey.registryService, AttributeKey.errorType],
          scope: coreInstrumentScope
        },
        null
      )
    case MetricName.retryAttempts:
      return createHandle(
        "counter",
        name,
        {
          unit: "{attempt}",
          description: "Retry attempts",
          attributeKeys: [AttributeKey.operation],
          scope: coreInstrumentScope
        },
        null
      )
    case MetricName.circuitBreakerTransitions:
      return createHandle(
        "counter",
        name,
        {
          unit: "{transition}",
          description: "Circuit breaker transitions",
          attributeKeys: [
            AttributeKey.operation,
            AttributeKey.circuitBreakerName,
            AttributeKey.circuitBreakerState
          ],
          scope: coreInstrumentScope
        },
        null
      )
    case MetricName.rateLimitRejections:
      return createHandle(
        "counter",
        name,
        {
          unit: "{rejection}",
          description: "Rate limit rejections",
          attributeKeys: [AttributeKey.operation],
          scope: coreInstrumentScope
        },
        null
      )
    default:
      throw new TypeError(`unknown core metric ${name}`)
  }
}

/** Validates the instrument name and freezes one handle. */
function createHandle(
  kind: InstrumentKind,
  name: string,
  options:
    | {
        readonly unit?: string
        readonly description?: string
        readonly attributeKeys?: readonly string[]
        readonly scope?: Scope
      }
    | undefined,
  buckets: readonly number[] | null
): Handle {
  if (!instrumentName.test(name)) throw new TypeError("metric name is invalid")
  const attributeKeys = Object.freeze([...(options?.attributeKeys ?? [])])
  const descriptor: InstrumentDescriptor = Object.freeze({
    kind,
    name,
    unit: options?.unit ?? "",
    description: options?.description ?? "",
    attributeKeys,
    buckets: buckets === null ? null : Object.freeze([...buckets])
  })
  return {
    kind,
    descriptor,
    scope: options?.scope ?? appScope,
    cache: new Map()
  }
}

/** Creates the provider instrument once and caches a failure as an absence. */
function resolveInstrument(
  ctx: Context,
  provider: MeterProvider,
  handle: Handle
): Instrument | null {
  const cached = handle.cache.get(provider)
  if (cached !== undefined) return cached
  try {
    const created = provider.instrument(handle.scope, handle.descriptor)
    if (created === null || typeof created !== "object" || typeof created.record !== "function") {
      throw new TypeError("meter provider returned an invalid instrument")
    }
    handle.cache.set(provider, created)
    return created
  } catch (error) {
    handle.cache.set(provider, null)
    reportFailure(ctx, handle.descriptor.name, error)
    return null
  }
}

/** Keeps only declared attribute keys whose values are attribute values. */
function filterAttributes(
  keys: readonly string[],
  attributes: RecordAttributes | undefined
): Attributes {
  if (attributes === undefined || keys.length === 0) return Object.freeze({})
  const allowed = new Set(keys)
  const selected: Record<string, AttributeValue> = {}
  for (const key of Object.keys(attributes)) {
    if (!allowed.has(key)) continue
    const value = attributes[key]
    if (value === undefined || !isAttributeValue(value)) continue
    selected[key] = value
  }
  return Object.freeze(selected)
}

/** Reports whether a value can be stored on a metric attribute. */
function isAttributeValue(value: unknown): value is AttributeValue {
  if (typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (!Array.isArray(value)) return false
  return value.every(
    (item) =>
      typeof item === "string" ||
      typeof item === "boolean" ||
      (typeof item === "number" && Number.isFinite(item))
  )
}
