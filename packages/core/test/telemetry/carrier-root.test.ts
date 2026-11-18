import { expect, test } from "bun:test"

import { snapshotBrokerMessage } from "../../src/broker/provider"
import { background } from "../../src/context"
import { runJob } from "../../src/job/provider"
import { newTelemetryRecorder } from "../../src/testing/recorder"
import { AttributeKey, withTelemetry } from "../../src/telemetry/index"
import { beginCoreUnit } from "../../src/telemetry/internal/units"
import { injectRecord } from "../../src/telemetry/provider"
import { withRemoteSpanContext } from "../../src/telemetry/provider"
import type { SpanContext } from "../../src/trace/index"

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

const runInfo = {
  system: "memory",
  name: "work",
  trigger: "queue" as const,
  id: "1",
  attempt: 1
}

test("an empty carrier does not keep a stale remote parent", async () => {
  const recorder = newTelemetryRecorder()
  const ctx = withRemoteSpanContext(withTelemetry(background(), recorder.telemetry), staleContext)
  let injected = ""
  await runJob(ctx, { ...runInfo, metadata: {} }, async (jobCtx) => {
    injected = injectRecord(jobCtx, {}).traceparent ?? ""
  })
  const span = recorder.spans().find((item) => item.name === "run work")
  expect(span?.root).toBe(true)
  expect(span?.parent).toBeNull()
  expect(injected.includes(staleContext.traceId)).toBe(false)
  expect(injected.length).toBeGreaterThan(0)
})

test("a carrier parent replaces the stale span", async () => {
  const recorder = newTelemetryRecorder()
  const base = withTelemetry(background(), recorder.telemetry)
  const stale = withRemoteSpanContext(base, staleContext)
  const headers = injectRecord(withRemoteSpanContext(base, upstreamContext), {})
  await runJob(stale, { ...runInfo, metadata: headers }, async () => {})
  const span = recorder.spans().find((item) => item.name === "run work")
  expect(span?.root).toBe(false)
  expect(span?.parent?.traceId).toBe(upstreamContext.traceId)
  expect(span?.parent?.spanId).toBe(upstreamContext.spanId)
})

test("a throwing propagator does not keep the stale span", () => {
  const recorder = newTelemetryRecorder({
    propagator: {
      fields: () => ["traceparent"],
      inject() {},
      extract() {
        throw new Error("extract failed")
      }
    }
  })
  const ctx = withRemoteSpanContext(withTelemetry(background(), recorder.telemetry), staleContext)
  const unit = beginCoreUnit(
    ctx,
    {
      kind: "messaging.process",
      system: "memory",
      destination: "orders",
      subscription: "orders",
      bodySize: 0
    },
    {}
  )
  unit.end()
  const span = recorder.spans().find((item) => item.name === "process orders")
  expect(span?.root).toBe(true)
  expect(span?.parent).toBeNull()
})

test("rpc.server with a null carrier stays under the caller span", async () => {
  const recorder = newTelemetryRecorder()
  const ctx = withTelemetry(background(), recorder.telemetry)
  const { inSpan } = await import("../../src/trace/index")
  await inSpan(ctx, "outer", async (spanCtx) => {
    const unit = beginCoreUnit(
      spanCtx,
      { kind: "rpc.server", system: "go_like", method: "Get", stream: false },
      null
    )
    unit.end()
  })
  const span = recorder.spans().find((item) => item.name === "Get")
  expect(span?.root).toBe(false)
  expect(span?.parent).not.toBeNull()
})

test("throw undefined is a failed unit and keeps its identity", async () => {
  const recorder = newTelemetryRecorder()
  const ctx = withTelemetry(background(), recorder.telemetry)
  let thrown: unknown = "missing"
  try {
    await runJob(
      ctx,
      {
        system: "memory",
        name: "work",
        trigger: "queue",
        id: "1",
        attempt: 1,
        metadata: null
      },
      async () => {
        throw undefined
      }
    )
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeUndefined()
  const span = recorder.spans().find((item) => item.name === "run work")
  expect(span?.status).toBe("error")
  expect(span?.attributes[AttributeKey.outcome]).toBe("failure")
})

test("an own __proto__ header survives injection", () => {
  const recorder = newTelemetryRecorder()
  const ctx = withRemoteSpanContext(withTelemetry(background(), recorder.telemetry), staleContext)
  const headers = Object.fromEntries([["__proto__", "own-value"]])
  const copied = injectRecord(ctx, headers)
  expect(Object.getOwnPropertyDescriptor(copied, "__proto__")?.value).toBe("own-value")
  expect(typeof copied.traceparent).toBe("string")
  expect(copied.traceparent).toContain(staleContext.traceId)
})

test("injectRecord keeps an own getter and replaces a propagator field", () => {
  const recorder = newTelemetryRecorder()
  const ctx = withRemoteSpanContext(withTelemetry(background(), recorder.telemetry), staleContext)
  const headers = Object.fromEntries([["__proto__", "own-value"]])
  let sourceReads = 0
  let traceparentReads = 0
  Object.defineProperty(headers, "source", {
    configurable: true,
    enumerable: true,
    get() {
      sourceReads += 1
      return "api"
    }
  })
  Object.defineProperty(headers, "traceparent", {
    configurable: true,
    enumerable: true,
    get() {
      traceparentReads += 1
      return "caller-parent"
    }
  })
  Object.defineProperty(headers, "count", {
    configurable: true,
    enumerable: true,
    get() {
      return 3
    }
  })
  const copied = injectRecord(ctx, headers)
  expect(sourceReads).toBe(1)
  expect(traceparentReads).toBe(0)
  expect(copied.source).toBe("api")
  expect(Object.getOwnPropertyDescriptor(copied, "source")?.value).toBe("api")
  expect(Object.getOwnPropertyDescriptor(copied, "__proto__")?.value).toBe("own-value")
  expect(Object.hasOwn(copied, "count")).toBe(false)
  expect(copied.traceparent).toContain(staleContext.traceId)
  expect(copied.traceparent).not.toBe("caller-parent")
})

test("a user-frozen record is still normalized when no propagator is installed", () => {
  const headers: Record<string, string> = { source: "api" }
  Object.defineProperty(headers, "count", { enumerable: true, value: 3 })
  Object.freeze(headers)
  const copied = injectRecord(background(), headers)
  expect(copied).not.toBe(headers)
  expect(copied.source).toBe("api")
  expect(Object.hasOwn(copied, "count")).toBe(false)
  expect(Object.getPrototypeOf(copied)).toBeNull()
  expect(Object.isFrozen(copied)).toBe(true)
})

test("a core snapshot is returned unchanged when no propagator is installed", () => {
  const snapshot = snapshotBrokerMessage({ headers: { source: "api" }, body: new Uint8Array() })
  expect(Object.getPrototypeOf(snapshot.headers)).toBeNull()
  expect(injectRecord(background(), snapshot.headers)).toBe(snapshot.headers)
})

test("a propagator still copies and replaces owned fields on both carrier sources", () => {
  const recorder = newTelemetryRecorder()
  const ctx = withRemoteSpanContext(withTelemetry(background(), recorder.telemetry), staleContext)
  const snapshot = snapshotBrokerMessage({
    headers: { traceparent: "stale", source: "api" },
    body: new Uint8Array()
  })
  const fromSnapshot = injectRecord(ctx, snapshot.headers)
  expect(fromSnapshot).not.toBe(snapshot.headers)
  expect(fromSnapshot.source).toBe("api")
  expect(fromSnapshot.traceparent).toContain(staleContext.traceId)
  expect(fromSnapshot.traceparent).not.toBe("stale")
  const user: Record<string, string> = { traceparent: "stale", source: "api" }
  const fromUser = injectRecord(ctx, user)
  expect(fromUser).not.toBe(user)
  expect(fromUser.traceparent).toContain(staleContext.traceId)
  expect(fromUser.traceparent).not.toBe("stale")
})

test("injectRecord fails when an accepted own getter throws", () => {
  const recorder = newTelemetryRecorder()
  const ctx = withRemoteSpanContext(withTelemetry(background(), recorder.telemetry), staleContext)
  const headers: Record<string, string> = Object.create(null)
  Object.defineProperty(headers, "__proto__", {
    configurable: true,
    enumerable: true,
    get() {
      return "from-getter"
    }
  })
  Object.defineProperty(headers, "source", {
    configurable: true,
    enumerable: true,
    get() {
      throw new Error("source getter failed")
    }
  })
  expect(() => injectRecord(ctx, headers)).toThrow("source getter failed")
})
