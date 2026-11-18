import { expect, test } from "bun:test"

import { background } from "@go-like/core/context"
import { newTelemetry, withTelemetry } from "@go-like/core/telemetry"
import { inSpan, spanFromContext, type SpanContext } from "@go-like/core/trace"
import {
  ROOT_CONTEXT,
  context,
  createContextKey,
  propagation,
  trace,
  type Context as OtelContext,
  type TextMapPropagator
} from "@opentelemetry/api"
import {
  CompositePropagator,
  ExportResultCode,
  W3CBaggagePropagator,
  W3CTraceContextPropagator
} from "@opentelemetry/core"
import { SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace"

import { newOtelPropagator, newOtelTracerProvider } from "../src/index"

const sampled = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01"
const start = Object.freeze({
  kind: "internal" as const,
  attributes: Object.freeze({}),
  links: Object.freeze([]),
  root: false
})

function carrier(values: Record<string, string> = {}): {
  readonly values: Record<string, string>
  get(key: string): string | null
  keys(): readonly string[]
  set(key: string, value: string): void
} {
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

function installManager(): () => void {
  let current: OtelContext = ROOT_CONTEXT
  const manager = {
    active: () => current,
    with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
      next: OtelContext,
      fn: F,
      thisArg?: ThisParameterType<F>,
      ...args: A
    ): ReturnType<F> {
      const previous = current
      current = next
      try {
        return fn.apply(thisArg, args)
      } finally {
        current = previous
      }
    },
    bind<T>(next: OtelContext, target: T): T {
      if (typeof target !== "function") return target
      return ((...args: unknown[]) =>
        manager.with(next, target as (...values: unknown[]) => unknown, undefined, ...args)) as T
    },
    enable() {
      return this
    },
    disable() {
      current = ROOT_CONTEXT
      return this
    }
  }
  context.disable()
  if (!context.setGlobalContextManager(manager)) {
    throw new Error("context manager was not installed")
  }
  return () => {
    context.disable()
  }
}

function emptyPropagator(): TextMapPropagator {
  return {
    inject() {},
    extract(value) {
      return value
    },
    fields: () => []
  }
}

test("extract keeps the context when the carrier has no span", () => {
  const propagator = newOtelPropagator(
    new CompositePropagator({
      propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()]
    })
  )
  const ctx = background()
  expect(propagator.extract(ctx, carrier())).toBe(ctx)
  expect(propagator.extract(ctx, carrier({ baggage: "user=ada" }))).toBe(ctx)
  expect(propagator.extract(ctx, carrier({ traceparent: "not a header" }))).toBe(ctx)
  expect(() => newOtelPropagator({} as never)).toThrow(TypeError)
  const source = {
    get: (_key: string): string | null => null,
    keys: (): readonly string[] => ["traceparent"]
  }
  const forwarding = newOtelPropagator({
    inject() {},
    extract(value, _carrier, getter) {
      expect(getter?.get(source, "missing")).toBeUndefined()
      expect(getter?.keys?.(source)).toEqual(["traceparent"])
      return value
    },
    fields: () => []
  })
  expect(forwarding.extract(background(), carrier())).toBeDefined()
})

test("extract stores the OTel context on the remote span and detach drops it", () => {
  const restore = installManager()
  try {
    const native = new TracerProvider({ spanProcessors: [] })
    const traces = newOtelTracerProvider(native)
    const propagator = newOtelPropagator(
      new CompositePropagator({
        propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()]
      })
    )
    const extracted = propagator.extract(
      background(),
      carrier({ traceparent: sampled, baggage: "user=ada" })
    )
    const remote = spanFromContext(extracted).spanContext()
    expect(remote.spanId).toBe("0123456789abcdef")
    expect(remote.isRemote).toBe(true)
    expect(remote.traceState).toBe("")
    const enter = traces.enter
    if (enter === undefined) throw new Error("enter is required")
    enter(extracted, () => {
      expect(trace.getSpan(context.active())?.spanContext().spanId).toBe("0123456789abcdef")
      expect(propagation.getBaggage(context.active())?.getEntry("user")?.value).toBe("ada")
    })
    const child = traces.startSpan(extracted, { name: "bridge" }, "child", start)
    child.end()
    expect(child.spanContext().traceId).toBe(remote.traceId)

    const tel = newTelemetry({ tracerProvider: traces })
    const rooted = withTelemetry(background(), tel)
    enter(rooted, () => {
      expect(trace.getSpan(context.active())).toBeUndefined()
      expect(propagation.getBaggage(context.active())).toBeUndefined()
    })
  } finally {
    restore()
  }
})

test("a local child uses the stored OTel context and root ignores the active span", async () => {
  const restore = installManager()
  const retained: { readonly name: string; readonly parent: string | null }[] = []
  const native = new TracerProvider({
    spanProcessors: [
      new SimpleSpanProcessor({
        exporter: {
          export(batch, callback) {
            for (const span of batch) {
              retained.push({ name: span.name, parent: span.parentSpanContext?.spanId ?? null })
            }
            callback({ code: ExportResultCode.SUCCESS })
          },
          shutdown: () => Promise.resolve()
        }
      })
    ]
  })
  const traces = newOtelTracerProvider(native, { implicitParent: true })
  const active = native.getTracer("third-party").startSpan("active")
  try {
    context.with(trace.setSpan(ROOT_CONTEXT, active), () => {
      const orphan = traces.startSpan(background(), { name: "app" }, "orphan", start)
      orphan.end()
      const rooted = traces.startSpan(background(), { name: "app" }, "rooted", {
        ...start,
        root: true
      })
      rooted.end()
    })
    const tel = newTelemetry({ tracerProvider: traces })
    await inSpan(withTelemetry(background(), tel), "parent", (_ctx, parent) => {
      const child = traces.startSpan(_ctx, { name: "app", version: "1" }, "nested", start)
      expect(child.spanContext()).toBe(child.spanContext())
      child.setAttributes(Object.freeze({ "service.name": "orders" }))
      child.addEvent("bare")
      child.addEvent("rich", Object.freeze({ "go_like.lifecycle.tier": "server" }))
      child.setStatus("ok")
      child.setStatus("unset")
      child.setStatus("error", "kept off the wire by core")
      child.recordError(new Error("secret failure text"))
      child.recordError("plain", Object.freeze({ "error.type": "Error" }))
      child.end()
      child.end()
      expect(child.isRecording()).toBe(false)
      expect(child.spanContext().traceId).toBe(parent.spanContext().traceId)
      const linked = traces.startSpan(background(), { name: "app" }, "linked-empty", {
        ...start,
        root: true,
        links: Object.freeze([
          {
            context: Object.freeze({
              traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              spanId: "aaaaaaaaaaaaaaaa",
              traceFlags: 0,
              traceState: "",
              isRemote: true
            }) satisfies SpanContext,
            attributes: Object.freeze({})
          }
        ])
      })
      linked.end()
    })
    expect(retained.find((span) => span.name === "orphan")?.parent).toBe(
      active.spanContext().spanId
    )
    expect(retained.find((span) => span.name === "rooted")?.parent).toBeNull()
    expect(retained.find((span) => span.name === "nested")?.parent).not.toBeNull()
    const described = retained.find((span) => span.name === "nested")
    expect(described).toBeDefined()
    void described
  } finally {
    active.end()
    await traces.lifecycle.stop(background())
    restore()
  }
})

test("start warns when the context manager or the global propagator is missing", async () => {
  context.disable()
  propagation.setGlobalPropagator(new W3CTraceContextPropagator())
  const records: string[] = []
  const native = new TracerProvider({ spanProcessors: [] })
  const traces = newOtelTracerProvider(native)
  const tel = newTelemetry({
    logHandlers: [
      {
        enabled: () => true,
        handle(_ctx, record) {
          records.push(record.event)
        }
      }
    ]
  })
  const running = traces.lifecycle.start(withTelemetry(background(), tel))
  await Promise.resolve()
  await Promise.resolve()
  expect(records).toContain("go_like.otel.context_manager_missing")
  expect(records).toContain("go_like.otel.global_propagator")
  await traces.lifecycle.stop(background())
  await running

  records.length = 0
  const restore = installManager()
  propagation.disable()
  if (!propagation.setGlobalPropagator(emptyPropagator())) {
    throw new Error("empty propagator was not installed")
  }
  const quiet = newOtelTracerProvider(new TracerProvider({ spanProcessors: [] }), {
    requireContextManager: true
  })
  const second = quiet.lifecycle.start(withTelemetry(background(), tel))
  await Promise.resolve()
  await Promise.resolve()
  expect(records).toEqual([])
  await quiet.lifecycle.stop(background())
  await second
  restore()
  propagation.disable()
  expect(createContextKey("unused").toString()).toContain("Symbol")
})
