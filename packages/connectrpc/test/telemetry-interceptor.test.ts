import { expect, test } from "bun:test"

import {
  Code,
  ConnectError,
  createContextValues,
  type ContextValues,
  type StreamResponse,
  type UnaryResponse
} from "@connectrpc/connect"
import { background, type Context } from "@go-like/core/context"
import {
  AttributeKey,
  LogEvent,
  MetricName,
  SemconvValue,
  newTelemetry,
  withTelemetry
} from "@go-like/core/telemetry"
import { beginUnit, withRemoteSpanContext } from "@go-like/core/telemetry/provider"
import { newTelemetryRecorder, type TelemetryRecorder } from "@go-like/core/testing"

import { callOptions, telemetryInterceptor } from "../src/index"

const serviceName = "orders.v1.OrderService"
const remoteTraceId = "0123456789abcdef0123456789abcdef"
const remoteSpanId = "0123456789abcdef"

interface ScriptedStream {
  readonly iterable: AsyncIterable<string>
  returned(): boolean
}

/** Carries `ctx` the same way an application client passes `callOptions` into Connect. */
function carriedContext(ctx: Context): ContextValues {
  const values = callOptions(ctx).contextValues
  if (values === undefined) throw new Error("callOptions must carry contextValues")
  return values
}

/** Builds the request fields the interceptor reads. The method kind selects unary or stream. */
function callRequest(
  header: Headers,
  contextValues: ContextValues,
  methodName: string,
  stream: boolean
): unknown {
  return {
    stream,
    service: { typeName: serviceName },
    method: { name: methodName, methodKind: stream ? "server_streaming" : "unary" },
    requestMethod: "POST",
    url: `https://rpc.example.test/${serviceName}/${methodName}`,
    signal: new AbortController().signal,
    header,
    contextValues,
    message: stream ? emptyStream() : { id: "order-1" }
  }
}

/** Empty input stream for a server-streaming request. The interceptor does not read it. */
async function* emptyStream(): AsyncGenerator<never> {}

/** Returns one client span recorded for `methodName`. */
function clientSpan(recorder: TelemetryRecorder, methodName: string) {
  return recorder.spans().find((span) => span.name === `${serviceName}/${methodName}`)
}

/** Scripts an output stream. `failure` is thrown on the pull after `values`, and `return` is recorded. */
function scriptedStream(values: readonly string[], failure: ConnectError | null): ScriptedStream {
  let didReturn = false
  const iterable: AsyncIterable<string> = {
    [Symbol.asyncIterator](): AsyncIterator<string> {
      let index = 0
      return {
        /** Yields the next scripted message or the scheduled failure. */
        async next(): Promise<IteratorResult<string>> {
          const value = values[index]
          if (value === undefined) {
            if (failure !== null) throw failure
            return { done: true, value: undefined }
          }
          index += 1
          return { done: false, value }
        },
        /** Records that the interceptor closed the source iterator. */
        async return(): Promise<IteratorResult<string>> {
          didReturn = true
          return { done: true, value: undefined }
        }
      }
    }
  }
  return { iterable, returned: () => didReturn }
}

/** Minimal stream response whose message iterable is the scripted source. */
function streamResponse(source: AsyncIterable<string>): StreamResponse {
  return {
    stream: true,
    service: { typeName: serviceName },
    method: { name: "Watch", methodKind: "server_streaming" },
    header: new Headers(),
    trailer: new Headers(),
    message: source
  } as unknown as StreamResponse
}

/** Reads one scripted stream message without treating it as a protobuf Message. */
function streamText(message: unknown): string {
  if (typeof message !== "string") throw new Error("stream message must be a string")
  return message
}

test("successful unary call records rpc.client span, duration, and completion log", async () => {
  const recorder = newTelemetryRecorder()
  const ctx = withTelemetry(background(), recorder.telemetry)
  const header = new Headers({
    traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01"
  })
  let injected = ""
  const message = { id: "order-1" }
  const response: UnaryResponse = {
    stream: false,
    service: { typeName: serviceName },
    method: { name: "GetOrder", methodKind: "unary" },
    header: new Headers(),
    trailer: new Headers(),
    message
  } as unknown as UnaryResponse
  const invoke = telemetryInterceptor()(async (request) => {
    injected = request.header.get("traceparent") ?? ""
    return response
  })

  const result = await invoke(
    callRequest(header, carriedContext(ctx), "GetOrder", false) as Parameters<typeof invoke>[0]
  )

  expect(result).toBe(response)
  const span = clientSpan(recorder, "GetOrder")
  expect(span).toMatchObject({
    name: `${serviceName}/GetOrder`,
    kind: "client",
    root: false,
    status: "unset",
    parent: null
  })
  expect(span?.attributes[AttributeKey.rpcSystemName]).toBe(SemconvValue.rpcSystemConnectrpc)
  expect(span?.attributes[AttributeKey.rpcMethod]).toBe(`${serviceName}/GetOrder`)
  expect(span?.attributes[AttributeKey.rpcStream]).toBe(false)
  expect(span?.attributes[AttributeKey.rpcStatusCode]).toBe("OK")
  expect(span?.attributes[AttributeKey.outcome]).toBe(SemconvValue.outcomeSuccess)
  expect(injected.includes(span?.context.spanId ?? "missing")).toBe(true)
  expect(injected.includes("bbbbbbbbbbbbbbbb")).toBe(false)
  expect(
    recorder.measurements().some((item) => {
      return (
        item.descriptor.name === MetricName.rpcClientCallDuration &&
        item.attributes[AttributeKey.rpcSystemName] === SemconvValue.rpcSystemConnectrpc &&
        item.attributes[AttributeKey.rpcMethod] === `${serviceName}/GetOrder` &&
        item.attributes[AttributeKey.rpcStatusCode] === "OK"
      )
    })
  ).toBe(true)
  const logged = recorder.logs().find((item) => item.record.event === LogEvent.rpcClientCompleted)
  expect(logged?.record.level).toBe("debug")
  expect(logged?.record.message).toBe(LogEvent.rpcClientCompleted)
})

test("rpc.client span nests under the caller span and stays non-root without one", async () => {
  const recorder = newTelemetryRecorder()
  const ctx = withTelemetry(background(), recorder.telemetry)
  const parent = beginUnit(ctx, {
    kind: "job.enqueue",
    system: "memory",
    name: "hold",
    queue: "hold"
  })
  const response: UnaryResponse = {
    stream: false,
    service: { typeName: serviceName },
    method: { name: "GetOrder", methodKind: "unary" },
    header: new Headers(),
    trailer: new Headers(),
    message: {}
  } as unknown as UnaryResponse
  const invoke = telemetryInterceptor()(async () => response)
  await invoke(
    callRequest(new Headers(), carriedContext(parent.ctx), "GetOrder", false) as Parameters<
      typeof invoke
    >[0]
  )
  await invoke(
    callRequest(new Headers(), carriedContext(ctx), "ListOrders", false) as Parameters<
      typeof invoke
    >[0]
  )
  parent.end()

  const nested = clientSpan(recorder, "GetOrder")
  const rootless = clientSpan(recorder, "ListOrders")
  const enqueued = recorder.spans().find((span) => span.name === "enqueue hold")
  expect(nested?.root).toBe(false)
  expect(nested?.parent?.spanId).toBe(enqueued?.context.spanId)
  expect(nested?.context.traceId).toBe(enqueued?.context.traceId)
  expect(rootless?.root).toBe(false)
  expect(rootless?.parent).toBeNull()
})

test("injects the caller traceparent when no tracer is installed", async () => {
  const ctx = withRemoteSpanContext(withTelemetry(background(), newTelemetry({})), {
    traceId: remoteTraceId,
    spanId: remoteSpanId,
    traceFlags: 1,
    traceState: "",
    isRemote: true
  })
  const header = new Headers({
    traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-00",
    "x-request-id": "kept"
  })
  const invoke = telemetryInterceptor()(async (request) => {
    return {
      stream: false,
      header: new Headers(),
      trailer: new Headers(),
      message: request.header.get("traceparent")
    } as unknown as UnaryResponse
  })
  const result = await invoke(
    callRequest(header, carriedContext(ctx), "GetOrder", false) as Parameters<typeof invoke>[0]
  )

  expect(streamText(result.message)).toBe(`00-${remoteTraceId}-${remoteSpanId}-01`)
  expect(header.get("x-request-id")).toBe("kept")
})

test("a thrown Connect error ends the unit with its gRPC status and is rethrown", async () => {
  const recorder = newTelemetryRecorder()
  const ctx = withTelemetry(background(), recorder.telemetry)
  const failure = new ConnectError("call-secret", Code.DeadlineExceeded)
  const invoke = telemetryInterceptor()(async () => {
    throw failure
  })

  await expect(
    invoke(
      callRequest(new Headers(), carriedContext(ctx), "GetOrder", false) as Parameters<
        typeof invoke
      >[0]
    )
  ).rejects.toBe(failure)

  const span = clientSpan(recorder, "GetOrder")
  expect(span?.status).toBe("error")
  expect(span?.attributes[AttributeKey.rpcStatusCode]).toBe("DEADLINE_EXCEEDED")
  expect(span?.attributes[AttributeKey.outcome]).toBe(SemconvValue.outcomeFailure)
  expect(span?.attributes[AttributeKey.errorType]).toBe("ConnectError")
  const logged = recorder.logs().find((item) => item.record.event === LogEvent.rpcClientCompleted)
  expect(logged?.record.level).toBe("warn")
  expect(logged?.record.message.includes("call-secret")).toBe(false)
})

test("a completed stream records received messages and closes the source", async () => {
  const recorder = newTelemetryRecorder()
  const ctx = withTelemetry(background(), recorder.telemetry)
  const source = scriptedStream(["ready", "gone"], null)
  const invoke = telemetryInterceptor()(async () => streamResponse(source.iterable))
  const result = await invoke(
    callRequest(new Headers(), carriedContext(ctx), "Watch", true) as Parameters<typeof invoke>[0]
  )
  if (!result.stream) throw new Error("Watch must return a stream")
  const seen: string[] = []
  for await (const message of result.message) seen.push(streamText(message))

  expect(seen).toEqual(["ready", "gone"])
  expect(source.returned()).toBe(true)
  const span = clientSpan(recorder, "Watch")
  expect(span?.attributes[AttributeKey.rpcStream]).toBe(true)
  expect(span?.attributes[AttributeKey.rpcStatusCode]).toBe("OK")
  expect(span?.attributes[AttributeKey.rpcStreamMessages]).toBe(2)
  expect(span?.attributes[AttributeKey.rpcStreamHandshakeMs]).toBe(0)
  expect(span?.attributes[AttributeKey.rpcStreamStatus]).toBe("success")
  expect(span?.status).toBe("unset")
  expect(
    recorder.measurements().some((item) => {
      return (
        item.descriptor.name === MetricName.rpcStreamMessages &&
        item.value === 2 &&
        item.attributes[AttributeKey.rpcDirection] === SemconvValue.directionReceived &&
        item.attributes[AttributeKey.rpcSystemName] === SemconvValue.rpcSystemConnectrpc
      )
    })
  ).toBe(true)
})

test("breaking a stream ends the unit as canceled", async () => {
  const recorder = newTelemetryRecorder()
  const ctx = withTelemetry(background(), recorder.telemetry)
  const source = scriptedStream(["ready", "gone"], null)
  const invoke = telemetryInterceptor()(async () => streamResponse(source.iterable))
  const result = await invoke(
    callRequest(new Headers(), carriedContext(ctx), "Watch", true) as Parameters<typeof invoke>[0]
  )
  if (!result.stream) throw new Error("Watch must return a stream")
  const seen: string[] = []
  for await (const message of result.message) {
    seen.push(streamText(message))
    break
  }

  expect(seen).toEqual(["ready"])
  expect(source.returned()).toBe(true)
  const span = clientSpan(recorder, "Watch")
  expect(span?.status).toBe("unset")
  expect(span?.attributes[AttributeKey.outcome]).toBe(SemconvValue.outcomeCanceled)
  expect(span?.attributes[AttributeKey.errorType]).toBe(SemconvValue.errorCanceled)
  expect(span?.attributes[AttributeKey.rpcStreamStatus]).toBe("canceled")
  expect(span?.attributes[AttributeKey.rpcStreamMessages]).toBe(1)
  expect(typeof span?.attributes[AttributeKey.rpcStreamHandshakeMs]).toBe("number")
})

test("a failed stream records the gRPC status and rethrows the same error", async () => {
  const recorder = newTelemetryRecorder()
  const ctx = withTelemetry(background(), recorder.telemetry)
  const failure = new ConnectError("stream-secret", Code.Unavailable)
  const source = scriptedStream(["ready"], failure)
  const invoke = telemetryInterceptor()(async () => streamResponse(source.iterable))
  const result = await invoke(
    callRequest(new Headers(), carriedContext(ctx), "Watch", true) as Parameters<typeof invoke>[0]
  )
  if (!result.stream) throw new Error("Watch must return a stream")
  let thrown: unknown = null
  const seen: string[] = []
  try {
    for await (const message of result.message) seen.push(streamText(message))
  } catch (error) {
    thrown = error
  }

  expect(seen).toEqual(["ready"])
  expect(thrown).toBe(failure)
  expect(source.returned()).toBe(true)
  const span = clientSpan(recorder, "Watch")
  expect(span?.status).toBe("error")
  expect(span?.attributes[AttributeKey.rpcStatusCode]).toBe("UNAVAILABLE")
  expect(span?.attributes[AttributeKey.rpcStreamStatus]).toBe("error")
  expect(span?.attributes[AttributeKey.rpcStreamMessages]).toBe(1)
  expect(span?.attributes[AttributeKey.rpcStreamHandshakeMs]).toBe(0)
  expect(span?.attributes[AttributeKey.outcome]).toBe(SemconvValue.outcomeFailure)
})

test("labels the rpc.client unit with the grpc system", async () => {
  const recorder = newTelemetryRecorder()
  const ctx = withTelemetry(background(), recorder.telemetry)
  const invoke = telemetryInterceptor("grpc")(async () => {
    return {
      stream: false,
      header: new Headers(),
      trailer: new Headers(),
      message: {}
    } as unknown as UnaryResponse
  })
  await invoke(
    callRequest(new Headers(), carriedContext(ctx), "GetOrder", false) as Parameters<
      typeof invoke
    >[0]
  )

  const span = clientSpan(recorder, "GetOrder")
  expect(span?.attributes[AttributeKey.rpcSystemName]).toBe("grpc")
  expect(
    recorder
      .measurements()
      .some(
        (item) =>
          item.descriptor.name === MetricName.rpcClientCallDuration &&
          item.attributes[AttributeKey.rpcSystemName] === "grpc"
      )
  ).toBe(true)
})

test("passes through when the call has no go-like Context", async () => {
  const header = new Headers({
    traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01"
  })
  const response = { stream: false, message: "same" } as unknown as UnaryResponse
  let called = false
  const invoke = telemetryInterceptor()(async () => {
    called = true
    return response
  })
  const result = await invoke(
    callRequest(header, createContextValues(), "GetOrder", false) as Parameters<typeof invoke>[0]
  )

  expect(called).toBe(true)
  expect(result).toBe(response)
  expect(header.get("traceparent")).toBe("00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01")
})

test("passes through when the go-like Context is not observing", async () => {
  const header = new Headers({
    traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
    "x-request-id": "kept"
  })
  const invoke = telemetryInterceptor()(async (request) => {
    return { stream: false, message: request.header.get("traceparent") } as unknown as UnaryResponse
  })
  const result = await invoke(
    callRequest(header, carriedContext(background()), "GetOrder", false) as Parameters<
      typeof invoke
    >[0]
  )

  expect(streamText(result.message)).toBe("00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01")
  expect(header.get("x-request-id")).toBe("kept")
})
