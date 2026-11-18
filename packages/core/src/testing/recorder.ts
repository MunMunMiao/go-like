import { background, type Context } from "../context/index"
import type { LogAttrs, LogHandler, LogLevel, LogRecord } from "../log/index"
import type { Instrument, InstrumentDescriptor, MeterProvider } from "../metric/index"
import { newTelemetry } from "../telemetry/index"
import { LogField } from "../telemetry/semconv"
import { isValidSpanContext, logCorrelation, spanFromContext } from "../telemetry/internal/state"
import type { Attributes, CompletionLogMode, Scope, Telemetry } from "../telemetry/types"
import type {
  Propagator,
  Span,
  SpanContext,
  SpanKind,
  SpanLink,
  SpanStatusCode,
  TracerProvider
} from "../trace/index"

/** One span captured by the recorder. */
export interface RecordedSpan {
  readonly scope: Scope
  readonly name: string
  readonly kind: SpanKind
  readonly context: SpanContext
  readonly parent: SpanContext | null
  readonly root: boolean
  readonly links: readonly SpanLink[]
  readonly attributes: Attributes
  readonly events: readonly { readonly name: string; readonly attributes: Attributes }[]
  readonly status: SpanStatusCode
  readonly ended: boolean
}

/** One measurement captured by the recorder. */
export interface RecordedMeasurement {
  readonly scope: Scope
  readonly descriptor: InstrumentDescriptor
  readonly value: number
  readonly attributes: Attributes
  readonly spanContext: SpanContext | null
}

/** One log captured by the recorder, including the span that was active. */
export interface RecordedLog {
  readonly record: LogRecord
  readonly spanContext: SpanContext | null
}

/** Options for the in-memory recorder. */
export interface RecorderOptions {
  readonly propagator?: Propagator | null
  /** Defaults to `"all"` so tests can see successful completion records. */
  readonly completionLogs?: CompletionLogMode
  /** Defaults to `"debug"`. */
  readonly level?: LogLevel
}

/** In-memory telemetry used by core tests and by the conformance suites. */
export interface TelemetryRecorder {
  readonly telemetry: Telemetry
  readonly tracerProvider: TracerProvider
  readonly meterProvider: MeterProvider
  readonly logHandler: LogHandler
  spans(): readonly RecordedSpan[]
  measurements(): readonly RecordedMeasurement[]
  logs(): readonly RecordedLog[]
  reset(): void
}

const rank: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }
const emptyAttributes: Attributes = Object.freeze({})

/** Creates a recorder. Provider `start` resolves immediately so App stop can join the terminal. */
export function newTelemetryRecorder(options: RecorderOptions = {}): TelemetryRecorder {
  const minimum = options.level ?? "debug"
  const spans: RecordedSpan[] = []
  const measurements: RecordedMeasurement[] = []
  const logs: RecordedLog[] = []
  const instruments = new Map<string, Instrument>()
  let implicit: Span | null = null
  let next = 1

  /** Allocates one non-zero trace or span id. */
  function identity(bytes: number): string {
    const raw = next.toString(16).padStart(bytes * 2, "0")
    next += 1
    return raw.slice(-bytes * 2)
  }

  /** Reads a valid span carried by ctx. The inactive placeholder is not a parent. */
  function carried(ctx: Context): Span | null {
    try {
      const span = spanFromContext(ctx)
      return isValidSpanContext(span.spanContext()) ? span : null
    } catch {
      return null
    }
  }

  /** Reads the active span identity for a log or measurement. */
  function activeContext(ctx: Context): SpanContext | null {
    const span = carried(ctx) ?? implicit
    if (span === null) return null
    try {
      const context = span.spanContext()
      return isValidSpanContext(context) ? context : null
    } catch {
      return null
    }
  }

  const tracerProvider: TracerProvider = {
    /** Records one span. `root` ignores both the context span and the implicit span. */
    startSpan(ctx, scope, name, start): Span {
      const parentSpan = start.root ? null : (carried(ctx) ?? implicit)
      let parent: SpanContext | null = null
      if (parentSpan !== null) {
        try {
          const context = parentSpan.spanContext()
          parent = isValidSpanContext(context) ? context : null
        } catch {
          parent = null
        }
      }
      const context: SpanContext = {
        traceId: parent?.traceId ?? identity(16),
        spanId: identity(8),
        traceFlags: 1,
        traceState: parent?.traceState ?? "",
        isRemote: false
      }
      const attributes: Record<string, Attributes[string]> = { ...start.attributes }
      const events: { name: string; attributes: Attributes }[] = []
      const recorded: {
        scope: Scope
        name: string
        kind: SpanKind
        context: SpanContext
        parent: SpanContext | null
        root: boolean
        links: SpanLink[]
        attributes: Attributes
        events: { name: string; attributes: Attributes }[]
        status: SpanStatusCode
        ended: boolean
      } = {
        scope,
        name,
        kind: start.kind,
        context,
        parent,
        root: start.root,
        links: start.links.slice(),
        attributes,
        events,
        status: "unset",
        ended: false
      }
      const span: Span = {
        /** Returns this span's identity. */
        spanContext() {
          return context
        },
        /** Reports whether `end` has not run. */
        isRecording() {
          return !recorded.ended
        },
        /** Merges attributes while the span is recording. */
        setAttributes(nextAttributes) {
          if (recorded.ended) return
          Object.assign(attributes, nextAttributes)
        },
        /** Appends one event while the span is recording. */
        addEvent(eventName, eventAttributes) {
          if (recorded.ended) return
          events.push({ name: eventName, attributes: eventAttributes ?? emptyAttributes })
        },
        /** Records status without keeping a description. */
        setStatus(code) {
          if (recorded.ended) return
          recorded.status = code
        },
        /** User API. The recorder keeps the error off the completion message. */
        recordError() {},
        /** Ends once. */
        end() {
          recorded.ended = true
        }
      }
      spans.push(recorded)
      return span
    },
    /** Installs the context span as the implicit parent for the synchronous call. */
    enter(ctx, fn) {
      const previous = implicit
      implicit = carried(ctx)
      try {
        return fn()
      } finally {
        implicit = previous
      }
    },
    /** Resolves immediately. `stop` before `start` leaves recorded spans in place. */
    lifecycle: {
      start() {
        return Promise.resolve()
      },
      stop() {
        return Promise.resolve()
      }
    }
  }

  const meterProvider: MeterProvider = {
    /** Returns the same instrument for the same descriptor fields. */
    instrument(scope, descriptor) {
      const key = JSON.stringify(descriptor)
      const existing = instruments.get(key)
      if (existing !== undefined) return existing
      const created: Instrument = {
        /** Keeps only the descriptor's attribute keys. */
        record(ctx, value, attributes) {
          const filtered: Record<string, Attributes[string]> = {}
          for (const name of descriptor.attributeKeys) {
            const item = attributes[name]
            if (item !== undefined) filtered[name] = item
          }
          measurements.push({
            scope,
            descriptor,
            value,
            attributes: Object.freeze(filtered),
            spanContext: activeContext(ctx)
          })
        }
      }
      instruments.set(key, created)
      return created
    },
    lifecycle: {
      start() {
        return Promise.resolve()
      },
      stop() {
        return Promise.resolve()
      }
    }
  }

  /** Builds one handler. Bound attributes are copied so the caller cannot mutate them later. */
  function createHandler(bound: LogAttrs): LogHandler {
    const handler: LogHandler = {
      /** Enables every level at or above the recorder minimum. */
      enabled(_ctx, level) {
        return rank[level] >= rank[minimum]
      },
      /** Stores the record. The message is never replaced with `exception.message`. */
      handle(ctx, record) {
        const correlation = logCorrelation(ctx)
        const merged: Record<string, LogRecord["attrs"][string]> = { ...bound, ...record.attrs }
        if (correlation !== null) {
          merged[LogField.traceId] = correlation.trace_id
          merged[LogField.spanId] = correlation.span_id
          merged[LogField.traceFlags] = correlation.trace_flags
        }
        logs.push({
          record: Object.freeze({ ...record, attrs: Object.freeze(merged) }),
          spanContext: activeContext(ctx)
        })
      },
      /** Returns a child handler. The parent binding is left unchanged. */
      withAttrs(attrs) {
        return createHandler(Object.freeze({ ...bound, ...attrs }))
      },
      lifecycle: {
        start() {
          return Promise.resolve()
        },
        stop() {
          return Promise.resolve()
        }
      }
    }
    return handler
  }

  const logHandler = createHandler(Object.freeze({}))
  const telemetry = newTelemetry({
    tracerProvider,
    meterProviders: [meterProvider],
    logHandlers: [logHandler],
    completionLogs: options.completionLogs ?? "all",
    ...(options.propagator !== undefined ? { propagator: options.propagator } : {})
  })

  const recorder = {
    telemetry,
    tracerProvider,
    meterProvider,
    logHandler,
    spans: () => spans.slice(),
    measurements: () => measurements.slice(),
    logs: () => logs.slice(),
    implicitSpanContext() {
      if (implicit === null) return null
      try {
        return implicit.spanContext()
      } catch {
        return null
      }
    },
    reset() {
      spans.length = 0
      measurements.length = 0
      logs.length = 0
      instruments.clear()
    }
  }
  return recorder
}

/** A background context for suites that do not care about cancellation. */
export function recorderContext(): Context {
  return background()
}
