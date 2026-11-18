import { expect, test } from "bun:test"

import { background } from "../../src/context"
import {
  AttributeKey,
  LogEvent,
  MetricName,
  SemconvValue,
  withTelemetry
} from "../../src/telemetry"
import { newTelemetryRecorder, type TelemetryRecorder } from "../../src/testing"
import type { RecordedLog, RecordedMeasurement, RecordedSpan } from "../../src/testing"

import { dispatching } from "./dispatching"

const secret = "secret-handler-detail"

/** Reads one span by its template name. */
function spanNamed(recorder: TelemetryRecorder, name: string): RecordedSpan {
  const span = recorder.spans().find((item) => item.name === name)
  if (span === undefined) throw new Error(`missing span ${name}`)
  return span
}

/** Reads one completion log. */
function completion(recorder: TelemetryRecorder): RecordedLog {
  const logged = recorder.logs().filter((item) => item.record.event === LogEvent.rpcServerCompleted)
  expect(logged).toHaveLength(1)
  const first = logged[0]
  if (first === undefined) throw new Error("missing rpc completion")
  return first
}

/** Reads the RPC server duration measurement. */
function duration(recorder: TelemetryRecorder): RecordedMeasurement {
  const measured = recorder
    .measurements()
    .filter((item) => item.descriptor.name === MetricName.rpcServerCallDuration)
  expect(measured).toHaveLength(1)
  const first = measured[0]
  if (first === undefined) throw new Error("missing rpc duration")
  return first
}

/** Drops trace correlation so the assertion is the unit's own attributes. */
function ownAttrs(log: RecordedLog): RecordedLog["record"]["attrs"] {
  const attrs = { ...log.record.attrs }
  delete attrs.trace_id
  delete attrs.span_id
  delete attrs.trace_flags
  return attrs
}

test("an invalid request URL is a client error before routing", async () => {
  const serving = await dispatching((server) => {
    server.registerHandler("orders", "get", () => new Response("ok"))
  })
  try {
    const response = await serving.dispatch(background(), {
      url: "http://[",
      method: "GET",
      headers: new Headers()
    } as Request)
    expect(response.status).toBe(400)
  } finally {
    await serving.stop()
  }
})

test("a successful RPC records the method span, duration, and info completion", async () => {
  const recorder = newTelemetryRecorder()
  const traced = withTelemetry(background(), recorder.telemetry)
  const serving = await dispatching((server) => {
    server.registerHandler("orders", "get", () => new Response(null))
  })
  try {
    const response = await serving.dispatch(
      traced,
      new Request("http://127.0.0.1/orders/get", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      })
    )
    expect(response.status).toBe(200)
    await response.arrayBuffer()
    const span = spanNamed(recorder, "orders/get")
    expect(span.kind).toBe("server")
    expect(span.root).toBe(true)
    expect(span.status).toBe("unset")
    expect(span.attributes).toMatchObject({
      [AttributeKey.rpcSystemName]: SemconvValue.rpcSystemGoLike,
      [AttributeKey.rpcMethod]: "orders/get",
      [AttributeKey.rpcStream]: false,
      [AttributeKey.outcome]: SemconvValue.outcomeSuccess,
      [AttributeKey.rpcStatusCode]: SemconvValue.rpcStatusOk
    })
    expect(span.attributes[AttributeKey.errorType]).toBeUndefined()
    expect(span.attributes[AttributeKey.durationMs]).toEqual(expect.any(Number))
    expect(JSON.stringify(span.attributes)).not.toContain(secret)
    const logged = completion(recorder)
    expect(logged.record.level).toBe("info")
    expect(logged.record.message).toBe(LogEvent.rpcServerCompleted)
    expect(ownAttrs(logged)).toMatchObject({
      [AttributeKey.outcome]: SemconvValue.outcomeSuccess,
      [AttributeKey.rpcStatusCode]: SemconvValue.rpcStatusOk
    })
    expect(ownAttrs(logged)[AttributeKey.errorType]).toBeUndefined()
    expect(logged.record.message).not.toContain(secret)
    const measured = duration(recorder)
    expect(measured.descriptor.unit).toBe("s")
    expect(measured.descriptor.attributeKeys).toEqual([
      AttributeKey.rpcSystemName,
      AttributeKey.rpcMethod,
      AttributeKey.rpcStatusCode,
      AttributeKey.errorType
    ])
    expect(measured.attributes).toEqual({
      [AttributeKey.rpcSystemName]: SemconvValue.rpcSystemGoLike,
      [AttributeKey.rpcMethod]: "orders/get",
      [AttributeKey.rpcStatusCode]: SemconvValue.rpcStatusOk
    })
    expect(measured.value).toBeGreaterThanOrEqual(0)
  } finally {
    await serving.stop()
  }
})

test("a registered caller fault keeps the method and records caller_fault", async () => {
  const recorder = newTelemetryRecorder()
  const traced = withTelemetry(background(), recorder.telemetry)
  const serving = await dispatching((server) => {
    server.registerHandler("orders", "get", () => new Response(null))
  })
  try {
    const response = await serving.dispatch(
      traced,
      new Request("http://127.0.0.1/orders/get", { method: "GET" })
    )
    expect(response.status).toBe(405)
    await response.arrayBuffer()
    const span = spanNamed(recorder, "orders/get")
    expect(span.status).toBe("unset")
    expect(span.attributes).toMatchObject({
      [AttributeKey.rpcMethod]: "orders/get",
      [AttributeKey.outcome]: SemconvValue.outcomeCallerFault,
      [AttributeKey.errorType]: "method_not_allowed",
      [AttributeKey.rpcStatusCode]: "method_not_allowed"
    })
    const logged = completion(recorder)
    expect(logged.record.level).toBe("info")
    expect(logged.record.message).toBe(LogEvent.rpcServerCompleted)
    expect(ownAttrs(logged)[AttributeKey.outcome]).toBe(SemconvValue.outcomeCallerFault)
    expect(ownAttrs(logged)[AttributeKey.errorType]).toBe("method_not_allowed")
    const measured = duration(recorder)
    expect(measured.attributes).toEqual({
      [AttributeKey.rpcSystemName]: SemconvValue.rpcSystemGoLike,
      [AttributeKey.rpcMethod]: "orders/get",
      [AttributeKey.rpcStatusCode]: "method_not_allowed",
      [AttributeKey.errorType]: "method_not_allowed"
    })
  } finally {
    await serving.stop()
  }
})

test("an unrouted RPC records span go_like and rpc.method _OTHER", async () => {
  const recorder = newTelemetryRecorder()
  const traced = withTelemetry(background(), recorder.telemetry)
  const serving = await dispatching((server) => {
    server.registerHandler("orders", "get", () => new Response(null))
  })
  try {
    const missing = await serving.dispatch(
      traced,
      new Request("http://127.0.0.1/missing/path", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      })
    )
    expect(missing.status).toBe(404)
    await missing.arrayBuffer()
    const span = spanNamed(recorder, "go_like")
    expect(span.kind).toBe("server")
    expect(span.status).toBe("unset")
    expect(span.attributes).toMatchObject({
      [AttributeKey.rpcMethod]: SemconvValue.other,
      [AttributeKey.outcome]: SemconvValue.outcomeCallerFault,
      [AttributeKey.errorType]: "not_found",
      [AttributeKey.rpcStatusCode]: "not_found"
    })
    const logged = completion(recorder)
    expect(logged.record.level).toBe("info")
    expect(logged.record.message).toBe(LogEvent.rpcServerCompleted)
    expect(duration(recorder).attributes[AttributeKey.rpcMethod]).toBe(SemconvValue.other)

    recorder.reset()
    const invalid = await serving.dispatch(traced, {
      url: "http://[",
      method: "GET",
      headers: new Headers()
    } as Request)
    expect(invalid.status).toBe(400)
    await invalid.arrayBuffer()
    const rejected = spanNamed(recorder, "go_like")
    expect(rejected.attributes).toMatchObject({
      [AttributeKey.rpcMethod]: SemconvValue.other,
      [AttributeKey.outcome]: SemconvValue.outcomeCallerFault,
      [AttributeKey.errorType]: "invalid_request",
      [AttributeKey.rpcStatusCode]: "invalid_request"
    })
    expect(completion(recorder).record.level).toBe("info")
  } finally {
    await serving.stop()
  }
})

test("a thrown handler records failure without the error text", async () => {
  const recorder = newTelemetryRecorder()
  const traced = withTelemetry(background(), recorder.telemetry)
  const serving = await dispatching((server) => {
    server.registerHandler("orders", "get", () => {
      throw new Error(secret)
    })
  })
  try {
    const response = await serving.dispatch(
      traced,
      new Request("http://127.0.0.1/orders/get", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      })
    )
    expect(response.status).toBe(500)
    expect(await response.text()).not.toContain(secret)
    const span = spanNamed(recorder, "orders/get")
    expect(span.status).toBe("error")
    expect(span.attributes).toMatchObject({
      [AttributeKey.outcome]: SemconvValue.outcomeFailure,
      [AttributeKey.errorType]: "Error",
      [AttributeKey.rpcStatusCode]: "internal"
    })
    expect(JSON.stringify(span.attributes)).not.toContain(secret)
    const logged = completion(recorder)
    expect(logged.record.level).toBe("error")
    expect(logged.record.message).toBe(LogEvent.rpcServerCompleted)
    expect(logged.record.message).not.toContain(secret)
    expect(JSON.stringify(ownAttrs(logged))).not.toContain(secret)
    expect(duration(recorder).attributes).toMatchObject({
      [AttributeKey.errorType]: "Error",
      [AttributeKey.rpcStatusCode]: "internal"
    })
  } finally {
    await serving.stop()
  }
})

test("healthz produces no RPC record", async () => {
  const recorder = newTelemetryRecorder()
  const traced = withTelemetry(background(), recorder.telemetry)
  const serving = await dispatching((server) => {
    server.registerHandler("orders", "get", () => new Response(null))
  })
  try {
    const response = await serving.dispatch(traced, new Request("http://127.0.0.1/healthz"))
    expect(response.status).toBe(200)
    await response.arrayBuffer()
    expect(recorder.spans()).toEqual([])
    expect(recorder.logs()).toEqual([])
    expect(recorder.measurements()).toEqual([])
  } finally {
    await serving.stop()
  }
})

test("RPC dispatch records nothing when telemetry is not installed", async () => {
  const recorder = newTelemetryRecorder()
  const lines: string[] = []
  const original = console.error
  console.error = (...args: unknown[]): void => {
    lines.push(args.map((item) => String(item)).join(" "))
  }
  const serving = await dispatching((server) => {
    server.registerHandler("orders", "get", () => {
      throw new Error(secret)
    })
  })
  try {
    const failed = await serving.dispatch(
      background(),
      new Request("http://127.0.0.1/orders/get", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      })
    )
    await failed.arrayBuffer()
    const health = await serving.dispatch(background(), new Request("http://127.0.0.1/healthz"))
    await health.arrayBuffer()
    const missing = await serving.dispatch(
      background(),
      new Request("http://127.0.0.1/missing/path", { method: "POST" })
    )
    await missing.arrayBuffer()
    expect(recorder.spans()).toEqual([])
    expect(recorder.logs()).toEqual([])
    expect(recorder.measurements()).toEqual([])
    expect(lines.join("\n")).not.toContain(secret)
    expect(lines.join("\n")).not.toContain(LogEvent.rpcServerCompleted)
  } finally {
    console.error = original
    await serving.stop()
  }
})
