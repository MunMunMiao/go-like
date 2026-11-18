import { background } from "../context/index"
import type { LogHandler, LogRecord } from "../log/index"
import type { InstrumentDescriptor, MeterProvider } from "../metric/index"
import { LogField } from "../telemetry/semconv"
import { detachSpan, logCorrelation, withRemoteSpanContext } from "../telemetry/internal/state"
import {
  newTraceContextPropagator,
  spanFromContext,
  type Propagator,
  type SpanContext,
  type TracerProvider
} from "../trace/index"

import type { ConformanceCase } from "./case"

/** A log plug under test. */
export interface LogHandlerSubject {
  newHandler(): LogHandler
  /** Native output decoded to flat fields, oldest first. */
  written(): Promise<readonly Readonly<Record<string, unknown>>[]>
}

/** A tracer plug under test. */
export interface TracerProviderSubject {
  readonly provider: TracerProvider
  /** The plug's implicit span. Omit when `enter` is absent. */
  implicitSpanContext?(): SpanContext | null
  finished(): Promise<
    readonly {
      readonly name: string
      readonly context: SpanContext
      readonly parentSpanId: string | null
      readonly links: readonly SpanContext[]
    }[]
  >
}

/** A meter plug under test. */
export interface MeterProviderSubject {
  readonly provider: MeterProvider
  collect(): Promise<
    readonly {
      readonly name: string
      readonly attributes: Readonly<Record<string, string | number | boolean>>
      readonly value: number
    }[]
  >
}

const scope = Object.freeze({ name: "conformance" })
const remoteContext: SpanContext = Object.freeze({
  traceId: "0123456789abcdef0123456789abcdef",
  spanId: "0123456789abcdef",
  traceFlags: 1,
  traceState: "congo=t61rcWkgMzE",
  isRemote: true
})

/** Fails the case with a stable message. */
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/** One case. */
function conformance(name: string, run: () => Promise<void>): ConformanceCase {
  return { name, run }
}

/** Log handler cases, including D10 stop-before-start. */
export function logHandlerConformance(subject: LogHandlerSubject): readonly ConformanceCase[] {
  const ctx = background()
  return [
    conformance("handle does not throw", async () => {
      const handler = subject.newHandler()
      handler.handle(ctx, record("info", "hello"))
      const rows = await subject.written()
      assert(
        rows.some((row) => row.message === "hello"),
        "written record is missing"
      )
    }),
    conformance("enabled is monotonic", async () => {
      const handler = subject.newHandler()
      const debug = handler.enabled(ctx, "debug")
      const info = handler.enabled(ctx, "info")
      const warn = handler.enabled(ctx, "warn")
      const error = handler.enabled(ctx, "error")
      if (debug) assert(info && warn && error, "a debug handler must enable higher levels")
      if (info) assert(warn && error, "an info handler must enable higher levels")
      if (warn) assert(error, "a warn handler must enable error")
      assert(error === true || error === false, "enabled must return a boolean")
    }),
    conformance("withAttrs does not mutate the parent", async () => {
      const handler = subject.newHandler()
      if (typeof handler.withAttrs !== "function") return
      const input: Record<string, string> = { request_id: "one" }
      const child = handler.withAttrs(input)
      input.request_id = "mutated"
      handler.handle(ctx, record("info", "parent"))
      child.handle(ctx, record("info", "child"))
      const rows = await subject.written()
      const parent = rows.find((row) => row.message === "parent")
      const nested = rows.find((row) => row.message === "child")
      assert(parent?.request_id === undefined, "parent record gained bound attributes")
      assert(nested?.request_id === "one", "child record lost its copied attribute")
    }),
    conformance("correlation matches logCorrelation", async () => {
      const handler = subject.newHandler()
      const traced = withRemoteSpanContext(ctx, remoteContext)
      handler.handle(traced, record("info", "correlated", "go_like.app.ready"))
      const correlation = logCorrelation(traced)
      const rows = await subject.written()
      const row = rows.find((item) => item.message === "correlated")
      assert(correlation !== null, "remote span must correlate")
      assert(row?.[LogField.traceId] === correlation?.trace_id, "trace id mismatch")
      assert(row?.[LogField.spanId] === correlation?.span_id, "span id mismatch")
      assert(row?.[LogField.traceFlags] === correlation?.trace_flags, "trace flags mismatch")
      assert(row?.[LogField.event] === "go_like.app.ready", "event.name mismatch")
    }),
    conformance("exception is not copied into the message", async () => {
      const handler = subject.newHandler()
      const failure = new Error("secret failure text")
      handler.handle(
        ctx,
        record("error", "server failed", "go_like.server.failed", { [LogField.exception]: failure })
      )
      const rows = await subject.written()
      const row = rows.find((item) => item.message === "server failed")
      assert(row !== undefined, "exception record is missing")
      assert(row.message === "server failed", "message was replaced")
      assert(
        !JSON.stringify(row).includes("secret failure text"),
        "error text leaked into the record"
      )
      const slot = row.exception ?? row.err ?? row.error
      assert(slot === failure, "exception slot does not keep the Error identity")
    }),
    conformance("stop before start keeps previous records", async () => {
      const handler = subject.newHandler()
      handler.handle(ctx, record("info", "kept"))
      const lifecycle = handler.lifecycle
      assert(lifecycle !== undefined, "log handler lifecycle is required")
      await lifecycle.stop(ctx)
      const rows = await subject.written()
      assert(
        rows.some((row) => row.message === "kept"),
        "stop before start dropped records"
      )
    })
  ]
}

/** Tracer cases, including D39 span identity and D10. */
export function tracerProviderConformance(
  subject: TracerProviderSubject
): readonly ConformanceCase[] {
  const ctx = background()
  const start = {
    kind: "internal" as const,
    attributes: Object.freeze({}),
    links: Object.freeze([]),
    root: false
  }
  return [
    conformance("local and remote parents and root", async () => {
      const remote = withRemoteSpanContext(ctx, remoteContext)
      const child = subject.provider.startSpan(remote, scope, "remote-child", start)
      child.end()
      const rooted = subject.provider.startSpan(remote, scope, "rooted", { ...start, root: true })
      rooted.end()
      const finished = await subject.finished()
      const remoteChild = finished.find((span) => span.name === "remote-child")
      const rootSpan = finished.find((span) => span.name === "rooted")
      assert(remoteChild?.parentSpanId === remoteContext.spanId, "remote parent was dropped")
      assert(rootSpan?.parentSpanId === null, "root span kept a parent")
    }),
    conformance("links reach the backend and end is idempotent", async () => {
      const span = subject.provider.startSpan(ctx, scope, "linked", {
        ...start,
        root: true,
        links: Object.freeze([{ context: remoteContext, attributes: Object.freeze({}) }])
      })
      span.end()
      span.end()
      const finished = await subject.finished()
      const linked = finished.filter((item) => item.name === "linked")
      assert(linked.length === 1, "end recorded the span twice")
      assert(linked[0]?.links[0]?.spanId === remoteContext.spanId, "link was dropped")
    }),
    conformance("enter calls fn once and clears a detached context", async () => {
      const enter = subject.provider.enter
      assert(typeof enter === "function", "tracer enter is required")
      let calls = 0
      const value = enter(ctx, () => {
        calls += 1
        return 7
      })
      assert(calls === 1 && value === 7, "enter did not call fn once")
      const extracted = newTraceContextPropagator().extract(
        ctx,
        reader({ traceparent: `00-${remoteContext.traceId}-${remoteContext.spanId}-01` })
      )
      enter(detachSpan(extracted), () => {
        assert(subject.implicitSpanContext?.() === null, "detached enter kept an implicit span")
      })
      enter(ctx, () => {
        assert(
          subject.implicitSpanContext?.() === null,
          "enter without a span kept an implicit span"
        )
      })
    }),
    conformance("startSpan identity is preserved", async () => {
      const span = subject.provider.startSpan(ctx, scope, "identity", { ...start, root: true })
      span.setAttributes(Object.freeze({ "service.name": "orders" }))
      span.addEvent("go_like.server.failed", Object.freeze({ "go_like.lifecycle.tier": "server" }))
      span.setStatus("error", "ignored description")
      const same = span
      same.end()
      const finished = await subject.finished()
      const row = finished.find((item) => item.name === "identity")
      assert(
        row?.context.spanId === span.spanContext().spanId,
        "finished span is a different object"
      )
      assert(span.isRecording() === false, "ended span is still recording")
    }),
    conformance("stop before start keeps finished spans", async () => {
      const span = subject.provider.startSpan(ctx, scope, "durable", { ...start, root: true })
      span.end()
      const lifecycle = subject.provider.lifecycle
      assert(lifecycle !== undefined, "tracer lifecycle is required")
      await lifecycle.stop(ctx)
      const finished = await subject.finished()
      assert(
        finished.some((item) => item.name === "durable"),
        "stop before start dropped spans"
      )
    })
  ]
}

/** Meter cases, including D10. */
export function meterProviderConformance(
  subject: MeterProviderSubject
): readonly ConformanceCase[] {
  const ctx = background()
  return [
    conformance("four kinds keep declared attributes and buckets", async () => {
      const counter = subject.provider.instrument(
        scope,
        descriptor("counter", "conformance.counter", ["name"])
      )
      const upDown = subject.provider.instrument(
        scope,
        descriptor("up_down_counter", "conformance.up_down", ["name"])
      )
      const histogram = subject.provider.instrument(
        scope,
        descriptor("histogram", "conformance.histogram", ["name"], [0.005, 1])
      )
      const gauge = subject.provider.instrument(
        scope,
        descriptor("gauge", "conformance.gauge", ["name"])
      )
      const again = subject.provider.instrument(
        scope,
        descriptor("counter", "conformance.counter", ["name"])
      )
      assert(again === counter, "the same descriptor returned a new instrument")
      counter.record(ctx, 1, { name: "orders", extra: "drop" })
      upDown.record(ctx, -1, { name: "orders" })
      histogram.record(ctx, 0.5, { name: "orders" })
      gauge.record(ctx, 3, { name: "orders" })
      const rows = await subject.collect()
      assert(
        rows.some((row) => row.name === "conformance.counter" && row.value === 1),
        "counter sample is missing"
      )
      assert(
        rows.some((row) => row.name === "conformance.up_down" && row.value === -1),
        "up-down sample is missing"
      )
      assert(
        rows.some((row) => row.name === "conformance.histogram" && row.value === 0.5),
        "histogram sample is missing"
      )
      assert(
        rows.some((row) => row.name === "conformance.gauge" && row.value === 3),
        "gauge sample is missing"
      )
      const sample = rows.find((row) => row.name === "conformance.counter")
      assert(sample?.attributes.name === "orders", "declared attribute was dropped")
      assert(sample?.attributes.extra === undefined, "undeclared attribute was kept")
    }),
    conformance("stop before start keeps measurements", async () => {
      const counter = subject.provider.instrument(
        scope,
        descriptor("counter", "conformance.durable", [])
      )
      counter.record(ctx, 2, {})
      const lifecycle = subject.provider.lifecycle
      assert(lifecycle !== undefined, "meter lifecycle is required")
      await lifecycle.stop(ctx)
      const rows = await subject.collect()
      assert(
        rows.some((row) => row.name === "conformance.durable" && row.value === 2),
        "stop dropped measurements"
      )
    })
  ]
}

/** Propagator cases. The built-in W3C propagator is the reference subject. */
export function propagatorConformance(newPropagator: () => Propagator): readonly ConformanceCase[] {
  return [
    conformance("round trip and fields", async () => {
      const propagator = newPropagator()
      const traced = withRemoteSpanContext(background(), remoteContext)
      const carrier = recordCarrier()
      propagator.inject(traced, carrier)
      for (const key of Object.keys(carrier.values)) {
        assert(
          propagator.fields().some((field) => field.toLowerCase() === key.toLowerCase()),
          `injected ${key} is not declared by fields()`
        )
      }
      assert(carrier.keys().length > 0, "inject wrote no carrier keys")
      const extracted = propagator.extract(background(), carrier)
      const context = spanFromContext(extracted).spanContext()
      assert(context.traceId === remoteContext.traceId, "trace id did not round-trip")
      assert(context.spanId === remoteContext.spanId, "span id did not round-trip")
      assert(context.traceState === remoteContext.traceState, "tracestate did not round-trip")
    }),
    conformance("malformed input keeps the context", async () => {
      const propagator = newPropagator()
      const ctx = background()
      for (const traceparent of [
        "ff-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
        "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01-extra",
        "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01,00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
        "00-00000000000000000000000000000000-0123456789abcdef-01",
        "not a header"
      ]) {
        const next = propagator.extract(ctx, recordCarrier({ traceparent }))
        assert(next === ctx, `malformed traceparent changed the context: ${traceparent}`)
      }
    }),
    conformance("inject writes nothing without a span", async () => {
      const propagator = newPropagator()
      const carrier = recordCarrier()
      propagator.inject(background(), carrier)
      assert(Object.keys(carrier.values).length === 0, "inject wrote a header without a span")
    })
  ]
}

/** Builds one log record. */
function record(
  level: LogRecord["level"],
  message: string,
  event = "",
  attrs: LogRecord["attrs"] = Object.freeze({})
): LogRecord {
  return Object.freeze({ time: 0, level, message, event, attrs })
}

/** Builds one instrument descriptor. */
function descriptor(
  kind: InstrumentDescriptor["kind"],
  name: string,
  attributeKeys: readonly string[],
  buckets: readonly number[] | null = null
): InstrumentDescriptor {
  return Object.freeze({
    kind,
    name,
    unit: "",
    description: "",
    attributeKeys: Object.freeze(attributeKeys),
    buckets
  })
}

/** A carrier that is both a reader and a writer. */
function recordCarrier(initial: Record<string, string> = {}): {
  values: Record<string, string>
  get(key: string): string | null
  keys(): readonly string[]
  set(key: string, value: string): void
} {
  const values = { ...initial }
  return {
    values,
    get(key) {
      const found = Object.keys(values).find((item) => item.toLowerCase() === key.toLowerCase())
      return found === undefined ? null : (values[found] ?? null)
    },
    keys: () => Object.keys(values),
    set(key, value) {
      values[key] = value
    }
  }
}

/** Adapts a record to the propagator reader. */
function reader(values: Record<string, string>): {
  get(key: string): string | null
  keys(): readonly string[]
} {
  return recordCarrier(values)
}
