import { expect, test } from "bun:test"

import { background } from "../../src/context"
import { runJob } from "../../src/job/provider"
import { newTelemetryRecorder } from "../../src/testing/recorder"
import { newTelemetry, withTelemetry } from "../../src/telemetry/index"
import { withSpan } from "../../src/telemetry/internal/state"
import { beginCoreUnit, type CoreUnit } from "../../src/telemetry/internal/units"
import { injectRecord, withRemoteSpanContext } from "../../src/telemetry/provider"
import { inSpan, spanFromContext, type Span, type SpanContext } from "../../src/trace/index"

const staleContext: SpanContext = {
  traceId: "11111111111111111111111111111111",
  spanId: "1111111111111111",
  traceFlags: 1,
  traceState: "",
  isRemote: true
}
const upstreamContext: SpanContext = {
  traceId: "22222222222222222222222222222222",
  spanId: "2222222222222222",
  traceFlags: 1,
  traceState: "",
  isRemote: true
}

const inbound: readonly {
  readonly label: string
  readonly name: string
  readonly unit: CoreUnit
}[] = [
  {
    label: "http.server",
    name: "GET",
    unit: { kind: "http.server", method: "GET", scheme: "http" }
  },
  {
    label: "rpc.server",
    name: "Get",
    unit: { kind: "rpc.server", system: "go_like", method: "Get", stream: false }
  },
  {
    label: "messaging.process",
    name: "process orders",
    unit: {
      kind: "messaging.process",
      system: "memory",
      destination: "orders",
      subscription: "orders",
      bodySize: 0
    }
  },
  {
    label: "job.run",
    name: "run work",
    unit: {
      kind: "job.run",
      system: "memory",
      name: "work",
      trigger: "queue",
      id: "1",
      attempt: 1
    }
  }
]

/** Reads one inbound unit. The index is a fixture, not a search result. */
function inboundUnit(index: number): CoreUnit {
  const spec = inbound[index]
  if (spec === undefined) throw new Error(`missing inbound unit ${index}`)
  return spec.unit
}

/** Formats one W3C parent header for a known span identity. */
function parentHeader(context: SpanContext): string {
  const flags = (context.traceFlags & 0xff).toString(16).padStart(2, "0")
  return `00-${context.traceId}-${context.spanId}-${flags}`
}

/** Reads the latest recorded span of one unit name. */
function latestSpan(
  recorder: ReturnType<typeof newTelemetryRecorder>,
  name: string
): ReturnType<typeof recorder.spans>[number] | undefined {
  return recorder
    .spans()
    .filter((span) => span.name === name)
    .at(-1)
}

/** Builds a non-recording span whose identity accessor has the requested behavior. */
function inertSpan(read: () => SpanContext): Span {
  return {
    spanContext: read,
    isRecording: () => false,
    setAttributes() {},
    addEvent() {},
    setStatus() {},
    recordError() {},
    end() {}
  }
}

test("a valid carrier equal to the context span stays the remote parent", () => {
  const recorder = newTelemetryRecorder()
  const ctx = withRemoteSpanContext(withTelemetry(background(), recorder.telemetry), staleContext)
  const carrier = { traceparent: parentHeader(staleContext) }
  for (const spec of inbound) {
    const selected = spec.label === "http.server" ? new Headers(carrier) : carrier
    const scope = beginCoreUnit(ctx, spec.unit, selected)
    scope.end()
    const span = latestSpan(recorder, spec.name)
    expect(span?.root, spec.label).toBe(false)
    expect(span?.parent?.traceId, spec.label).toBe(staleContext.traceId)
    expect(span?.parent?.spanId, spec.label).toBe(staleContext.spanId)
  }
})

test("the same carrier propagates downstream when no tracer is installed", async () => {
  const telemetry = newTelemetry({})
  const ctx = withRemoteSpanContext(withTelemetry(background(), telemetry), staleContext)
  const carrier = { traceparent: parentHeader(staleContext) }
  for (const spec of inbound) {
    let injected = ""
    const scope = beginCoreUnit(ctx, spec.unit, carrier)
    scope.run((unitCtx) => {
      injected = injectRecord(unitCtx, {}).traceparent ?? ""
    })
    scope.end()
    expect(injected, spec.label).toContain(staleContext.traceId)
    expect(injected, spec.label).toContain(staleContext.spanId)
  }
  let queued = ""
  await runJob(
    ctx,
    {
      system: "memory",
      name: "work",
      trigger: "queue",
      id: "1",
      attempt: 1,
      metadata: carrier
    },
    async (jobCtx) => {
      queued = injectRecord(jobCtx, {}).traceparent ?? ""
    }
  )
  expect(queued).toContain(staleContext.traceId)
  expect(queued).toContain(staleContext.spanId)
})

test("absent and malformed carriers do not keep a stale remote or local parent", async () => {
  const recorder = newTelemetryRecorder()
  const base = withTelemetry(background(), recorder.telemetry)
  const remote = withRemoteSpanContext(base, staleContext)
  await inSpan(base, "explicit", async (spanCtx) => {
    const absent: readonly (Readonly<Record<string, string>> | null | undefined)[] = [
      undefined,
      null,
      {},
      { traceparent: "not-a-traceparent" },
      { traceparent: "00-00000000000000000000000000000000-0000000000000000-01" }
    ]
    for (const carrier of absent) {
      for (const spec of inbound) {
        if (spec.label === "rpc.server" && (carrier === null || carrier === undefined)) continue
        const scope = beginCoreUnit(remote, spec.unit, carrier)
        scope.end()
        const fromRemote = latestSpan(recorder, spec.name)
        expect(fromRemote?.root, `${spec.label} remote ${JSON.stringify(carrier)}`).toBe(true)
        expect(fromRemote?.parent, `${spec.label} remote`).toBeNull()
        const localScope = beginCoreUnit(spanCtx, spec.unit, carrier)
        localScope.end()
        const fromLocal = latestSpan(recorder, spec.name)
        expect(fromLocal?.root, `${spec.label} local`).toBe(true)
        expect(fromLocal?.parent, `${spec.label} local`).toBeNull()
      }
    }
  })
  const telemetry = newTelemetry({})
  const bare = withRemoteSpanContext(withTelemetry(background(), telemetry), staleContext)
  let injected = "unset"
  const scope = beginCoreUnit(bare, inboundUnit(2), {})
  scope.run((unitCtx) => {
    injected = injectRecord(unitCtx, {}).traceparent ?? ""
  })
  scope.end()
  expect(injected).toBe("")
})

test("rpc.server with a null carrier keeps an explicit parent and ignores an implicit one", async () => {
  const recorder = newTelemetryRecorder()
  const base = withTelemetry(background(), recorder.telemetry)
  const rpc = inboundUnit(1)
  await inSpan(base, "explicit", async (spanCtx) => {
    const localId = spanFromContext(spanCtx).spanContext().spanId
    const nested = beginCoreUnit(spanCtx, rpc, null)
    nested.end()
    const child = latestSpan(recorder, "Get")
    expect(child?.root).toBe(false)
    expect(child?.parent?.spanId).toBe(localId)
    const bare = withTelemetry(background(), recorder.telemetry)
    const rooted = beginCoreUnit(bare, rpc, null)
    rooted.end()
    const implicit = latestSpan(recorder, "Get")
    expect(implicit?.root).toBe(true)
    expect(implicit?.parent).toBeNull()
  })
  const remote = withRemoteSpanContext(base, staleContext)
  const kept = beginCoreUnit(remote, rpc, null)
  kept.end()
  const span = latestSpan(recorder, "Get")
  expect(span?.root).toBe(false)
  expect(span?.parent?.spanId).toBe(staleContext.spanId)
})

test("a valid carrier wins over an explicit local parent and an implicit parent", async () => {
  const recorder = newTelemetryRecorder()
  const base = withTelemetry(background(), recorder.telemetry)
  const carrier = { traceparent: parentHeader(upstreamContext) }
  await inSpan(base, "explicit", async (spanCtx) => {
    const localId = spanFromContext(spanCtx).spanContext().spanId
    for (const spec of inbound) {
      const scope = beginCoreUnit(spanCtx, spec.unit, carrier)
      scope.end()
      const span = latestSpan(recorder, spec.name)
      expect(span?.root, spec.label).toBe(false)
      expect(span?.parent?.spanId, spec.label).toBe(upstreamContext.spanId)
      expect(span?.parent?.spanId, spec.label).not.toBe(localId)
    }
  })
})

test("a local span is not treated as a failed extract when the carrier repeats it", async () => {
  const recorder = newTelemetryRecorder()
  const base = withTelemetry(background(), recorder.telemetry)
  await inSpan(base, "local", async (spanCtx) => {
    const local = spanFromContext(spanCtx).spanContext()
    const carrier = { traceparent: parentHeader(local) }
    for (const spec of inbound) {
      const scope = beginCoreUnit(spanCtx, spec.unit, carrier)
      scope.end()
      const span = latestSpan(recorder, spec.name)
      expect(span?.root, spec.label).toBe(false)
      expect(span?.parent?.traceId, spec.label).toBe(local.traceId)
      expect(span?.parent?.spanId, spec.label).toBe(local.spanId)
    }
  })
})

test("custom propagators succeed only when extraction installs a valid remote span", () => {
  const same = newTelemetryRecorder({
    propagator: {
      fields: () => ["traceparent"],
      inject() {},
      extract(ctx, carrier) {
        if (carrier.get("mode") === "same") return withRemoteSpanContext(ctx, staleContext)
        return ctx
      }
    }
  })
  const sameCtx = withRemoteSpanContext(withTelemetry(background(), same.telemetry), staleContext)
  for (const spec of inbound) {
    const scope = beginCoreUnit(sameCtx, spec.unit, { mode: "same" })
    scope.end()
    const span = latestSpan(same, spec.name)
    expect(span?.root, spec.label).toBe(false)
    expect(span?.parent?.spanId, spec.label).toBe(staleContext.spanId)
  }

  const staleOnly = newTelemetryRecorder({
    propagator: {
      fields: () => ["traceparent"],
      inject() {},
      extract(ctx) {
        return ctx
      }
    }
  })
  const staleCtx = withRemoteSpanContext(
    withTelemetry(background(), staleOnly.telemetry),
    staleContext
  )
  for (const spec of inbound) {
    beginCoreUnit(staleCtx, spec.unit, {}).end()
    const span = latestSpan(staleOnly, spec.name)
    expect(span?.root, `${spec.label} unchanged`).toBe(true)
    expect(span?.parent, `${spec.label} unchanged`).toBeNull()
  }

  const local = newTelemetryRecorder()
  const localSpan = local.tracerProvider.startSpan(background(), { name: "go-like" }, "local", {
    kind: "internal",
    attributes: {},
    links: [],
    root: true
  })
  const localPropagator = newTelemetryRecorder({
    propagator: {
      fields: () => ["traceparent"],
      inject() {},
      extract(ctx) {
        return withSpan(ctx, localSpan, null)
      }
    }
  })
  const localCtx = withRemoteSpanContext(
    withTelemetry(background(), localPropagator.telemetry),
    staleContext
  )
  beginCoreUnit(localCtx, inboundUnit(2), { mode: "local" }).end()
  expect(latestSpan(localPropagator, "process orders")?.parent).toBeNull()

  const invalid = newTelemetryRecorder({
    propagator: {
      fields: () => ["traceparent"],
      inject() {},
      extract(ctx) {
        return withSpan(
          ctx,
          inertSpan(() => ({
            traceId: "zz",
            spanId: "zz",
            traceFlags: 1,
            traceState: "",
            isRemote: true
          })),
          null
        )
      }
    }
  })
  const invalidCtx = withRemoteSpanContext(
    withTelemetry(background(), invalid.telemetry),
    staleContext
  )
  beginCoreUnit(invalidCtx, inboundUnit(0), { mode: "invalid" }).end()
  expect(latestSpan(invalid, "GET")?.root).toBe(true)
  expect(latestSpan(invalid, "GET")?.parent).toBeNull()

  const throwingSpan = newTelemetryRecorder({
    propagator: {
      fields: () => ["traceparent"],
      inject() {},
      extract(ctx) {
        return withSpan(
          ctx,
          inertSpan(() => {
            throw new Error("span context failed")
          }),
          null
        )
      }
    }
  })
  const throwingCtx = withRemoteSpanContext(
    withTelemetry(background(), throwingSpan.telemetry),
    staleContext
  )
  beginCoreUnit(throwingCtx, inboundUnit(3), { mode: "throw-span" }).end()
  expect(latestSpan(throwingSpan, "run work")?.root).toBe(true)
  expect(latestSpan(throwingSpan, "run work")?.parent).toBeNull()

  const throwing = newTelemetryRecorder({
    propagator: {
      fields: () => ["traceparent"],
      inject() {},
      extract() {
        throw new Error("extract failed")
      }
    }
  })
  const throwingParent = withRemoteSpanContext(
    withTelemetry(background(), throwing.telemetry),
    staleContext
  )
  beginCoreUnit(throwingParent, inboundUnit(2), { mode: "throw" }).end()
  expect(latestSpan(throwing, "process orders")?.root).toBe(true)
  expect(latestSpan(throwing, "process orders")?.parent).toBeNull()
})
