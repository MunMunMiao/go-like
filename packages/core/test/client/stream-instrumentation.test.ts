import { AsyncLocalStorage } from "node:async_hooks"
import { expect, test } from "bun:test"

import {
  background,
  canceled,
  deadlineExceeded,
  withCancel,
  withTimeout,
  type Context
} from "../../src/context"
import type { LogLevel } from "../../src/log"
import { newClient, withEndpoint, withTransport, type Client } from "../../src/client"
import { struct } from "../../src/struct"
import { endpoint, isServiceError, serviceError, type ServerStream } from "../../src/transport"
import { eventStreamContentType } from "../../src/transport/internal/sse"
import { newMemoryTransport, type MemoryTransport } from "../../src/transport/memory"
import {
  address,
  middleware,
  newServer,
  streamKeepAlive,
  transport,
  type Server,
  type ServerOption
} from "../../src/server"
import {
  AttributeKey,
  LogEvent,
  MetricName,
  SemconvValue,
  newTelemetry,
  withTelemetry
} from "../../src/telemetry"
import { newTelemetryRecorder, type RecordedSpan, type TelemetryRecorder } from "../../src/testing"
import { beginCoreUnit } from "../../src/telemetry/internal/instrument"
import { endResponseUnit } from "../../src/transport/body-end"
import { spanFromContext } from "../../src/trace"

const Item = struct.object({ n: struct.number() })
const watch = endpoint("orders", "watch", Item, Item, true)
const fault = endpoint("orders", "fault", Item, Item, true)
const broken = endpoint("orders", "broken", Item, Item, true)
const gated = endpoint("orders", "gated", Item, Item, true)
const limited = endpoint("orders", "limited", Item, Item, true)
const cut = endpoint("orders", "cut", Item, Item, true)
const parts = endpoint("orders", "parts", Item, Item, true)
const blob = endpoint("orders", "blob", Item, Item, true)
const beat = endpoint("orders", "beat", Item, Item, true)
const failedRead = endpoint("orders", "failed", Item, Item, true)
const secret = "secret-handler-detail"
const encoder = new TextEncoder()
const endFrame = "event: end\ndata: {}\n\n"

/** Read error whose name is a legal error.type. */
class StreamReadError extends Error {
  constructor() {
    super("read broke")
    this.name = "StreamReadError"
  }
}

interface ExpectedUnit {
  readonly outcome: string
  readonly status: "unset" | "error"
  readonly rpcStatus: string
  readonly streamStatus: string
  readonly messages: number
  readonly errorType: string | undefined
  readonly stream: boolean
}

interface Running {
  readonly recorder: TelemetryRecorder
  readonly traced: Context
  readonly memory: MemoryTransport
  readonly location: string
  readonly client: Client
  stop(): Promise<void>
}

let sequence = 0

/** Waits without keeping the process alive. */
function delay(ms: number): Promise<void> {
  return new Promise(function settle(resolve): void {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/** Encodes one SSE payload. */
function bytes(text: string): Uint8Array {
  return encoder.encode(text)
}

/** Cuts one frame into separate chunks so a counter cannot use chunk boundaries. */
function slices(wire: Uint8Array, size: number): Uint8Array[] {
  const parts: Uint8Array[] = []
  for (let offset = 0; offset < wire.byteLength; offset += size) {
    parts.push(wire.slice(offset, offset + size))
  }
  return parts
}

/** Serves the given chunks, then closes or fails the next pull. */
function sseResponse(chunks: readonly Uint8Array[], failure?: Error): Response {
  let index = 0
  const body = new ReadableStream<Uint8Array>(
    {
      /** Delivers one chunk per pull, then the terminal condition. */
      pull(controller): void {
        const chunk = chunks[index]
        index += 1
        if (chunk !== undefined) {
          controller.enqueue(chunk)
          return
        }
        if (failure !== undefined) controller.error(failure)
        else controller.close()
      }
    },
    { highWaterMark: 0 }
  )
  return new Response(body, {
    status: 200,
    headers: { "content-type": eventStreamContentType }
  })
}

/** Starts one memory server whose request context carries the recorder. */
async function open(
  register: (server: Server) => void,
  ...options: readonly ServerOption[]
): Promise<Running> {
  sequence += 1
  const recorder = newTelemetryRecorder()
  const traced = withTelemetry(background(), recorder.telemetry)
  const location = `memory://stream-obs-${sequence}`
  const memory = newMemoryTransport()
  const server = newServer(transport(memory), address(location), streamKeepAlive(0), ...options)
  register(server)
  const running = server.start(traced)
  try {
    await server.endpoint(background())
  } catch (error) {
    await server.stop(background())
    await running
    throw error
  }
  const client = newClient(withTransport(memory), withEndpoint(location))
  return {
    recorder,
    traced,
    memory,
    location,
    client,
    async stop(): Promise<void> {
      await client.close(background())
      await server.stop(background())
      await running
    }
  }
}

/** Reads one server stream to its protocol terminal and then closes it again. */
async function collect(events: ServerStream<{ readonly n: number }>): Promise<{
  readonly values: number[]
  readonly failure: unknown
}> {
  const values: number[] = []
  let failure: unknown = null
  try {
    for await (const event of events) values.push(event.n)
  } catch (error) {
    failure = error
  } finally {
    await events.close()
  }
  return { values, failure }
}

/** Posts one raw SSE request and reads the body to EOF, without a typed client cancel. */
async function readServer(running: Running, name: string): Promise<string> {
  const wire = await running.memory.dial(background(), running.location)
  const response = await wire.fetch(
    background(),
    new Request(new URL(`/orders/${name}`, running.location), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: eventStreamContentType
      },
      body: '{"n":1}'
    })
  )
  return await response.text()
}

/** Returns the one ended span for a method, or times out. */
async function endedSpan(
  recorder: TelemetryRecorder,
  kind: "server" | "client",
  name: string
): Promise<RecordedSpan> {
  const started = Date.now()
  for (;;) {
    const found = recorder
      .spans()
      .filter((span) => span.kind === kind && span.name === name && span.ended)
    if (found.length > 1) throw new Error(`duplicate ${kind} span ${name}`)
    const span = found[0]
    if (span !== undefined) return span
    if (Date.now() - started > 2000) {
      const summary = recorder
        .spans()
        .map((span) => `${span.kind} ${span.name} ended=${span.ended}`)
        .join("; ")
      throw new Error(`span ${kind} ${name} did not end; saw [${summary}]`)
    }
    await delay(10)
  }
}

/** Asserts the protocol outcome recorded on one RPC span. */
function expectUnit(span: RecordedSpan, expected: ExpectedUnit): void {
  expect(span.ended).toBe(true)
  expect(span.status).toBe(expected.status)
  expect(span.attributes).toMatchObject({
    [AttributeKey.rpcSystemName]: SemconvValue.rpcSystemGoLike,
    [AttributeKey.outcome]: expected.outcome,
    [AttributeKey.rpcStatusCode]: expected.rpcStatus,
    [AttributeKey.rpcStream]: expected.stream,
    [AttributeKey.rpcStreamMessages]: expected.messages,
    [AttributeKey.rpcStreamStatus]: expected.streamStatus
  })
  expect(span.attributes[AttributeKey.errorType]).toBe(expected.errorType)
  expect(JSON.stringify(span.attributes)).not.toContain(secret)
  const handshake = span.attributes[AttributeKey.rpcStreamHandshakeMs]
  const duration = span.attributes[AttributeKey.durationMs]
  expect(typeof handshake).toBe("number")
  expect(typeof duration).toBe("number")
  if (typeof handshake !== "number" || typeof duration !== "number") {
    throw new Error("missing stream timing")
  }
  expect(duration).toBeGreaterThanOrEqual(handshake)
}

/** Asserts exactly one completion record, with no error text in the message. */
function expectCompletion(
  recorder: TelemetryRecorder,
  event: string,
  level: LogLevel,
  outcome: string
): void {
  const logged = recorder.logs().filter((item) => item.record.event === event)
  expect(logged).toHaveLength(1)
  const record = logged[0]?.record
  if (record === undefined) throw new Error(`missing ${event}`)
  expect(record.level).toBe(level)
  expect(record.message).toBe(event)
  expect(record.message).not.toContain(secret)
  expect(record.attrs[AttributeKey.outcome]).toBe(outcome)
  expect(JSON.stringify(record.attrs)).not.toContain(secret)
}

/** Asserts the stream message counter for one direction. */
function expectMessages(
  recorder: TelemetryRecorder,
  method: string,
  direction: string,
  messages: number
): void {
  const measured = recorder.measurements().filter((item) => {
    return (
      item.descriptor.name === MetricName.rpcStreamMessages &&
      item.attributes[AttributeKey.rpcMethod] === method &&
      item.attributes[AttributeKey.rpcDirection] === direction
    )
  })
  expect(measured).toHaveLength(1)
  expect(measured[0]?.value).toBe(messages)
}

test("a server stream that yields and then ends records one message at the terminal event", async () => {
  const running = await open((server) => {
    server.registerHandler(watch, async function* (): AsyncGenerator<{ n: number }> {
      await delay(40)
      yield { n: 1 }
    })
  })
  try {
    const body = await readServer(running, "watch")
    expect(body).toContain("event: end")
    expect(body).not.toContain("event: error")
    const span = await endedSpan(running.recorder, "server", "orders/watch")
    expectUnit(span, {
      outcome: SemconvValue.outcomeSuccess,
      status: "unset",
      rpcStatus: SemconvValue.rpcStatusOk,
      streamStatus: "success",
      messages: 1,
      errorType: undefined,
      stream: true
    })
    const handshake = span.attributes[AttributeKey.rpcStreamHandshakeMs]
    const duration = span.attributes[AttributeKey.durationMs]
    if (typeof handshake !== "number" || typeof duration !== "number") {
      throw new Error("missing stream timing")
    }
    // The body wait is part of the unit duration and not the header handshake.
    expect(duration - handshake).toBeGreaterThanOrEqual(25)
    expectCompletion(
      running.recorder,
      LogEvent.rpcServerCompleted,
      "info",
      SemconvValue.outcomeSuccess
    )
    expectMessages(running.recorder, "orders/watch", SemconvValue.directionSent, 1)
    expect(running.recorder.logs()).toHaveLength(1)
  } finally {
    await running.stop()
  }
})

test("a server stream that yields and then throws records the SSE error, not byte EOF", async () => {
  const running = await open((server) => {
    server.registerHandler(watch, async function* (): AsyncGenerator<{ n: number }> {
      yield { n: 1 }
      throw new Error(secret)
    })
  })
  try {
    const body = await readServer(running, "watch")
    expect(body).toContain("event: error")
    expect(body).not.toContain(secret)
    const span = await endedSpan(running.recorder, "server", "orders/watch")
    expectUnit(span, {
      outcome: SemconvValue.outcomeFailure,
      status: "error",
      rpcStatus: "internal",
      streamStatus: "error",
      messages: 1,
      errorType: "internal",
      stream: true
    })
    expectCompletion(
      running.recorder,
      LogEvent.rpcServerCompleted,
      "error",
      SemconvValue.outcomeFailure
    )
    expect(running.recorder.logs()).toHaveLength(1)
  } finally {
    await running.stop()
  }
})

test("a server stream ServiceError below 500 is a caller fault and keeps its code", async () => {
  const running = await open((server) => {
    server.registerHandler(fault, async function* (): AsyncGenerator<{ n: number }> {
      yield { n: 1 }
      throw serviceError("invalid_request", secret, 400)
    })
  })
  try {
    const body = await readServer(running, "fault")
    expect(body).toContain("event: error")
    const span = await endedSpan(running.recorder, "server", "orders/fault")
    expectUnit(span, {
      outcome: SemconvValue.outcomeCallerFault,
      status: "unset",
      rpcStatus: "invalid_request",
      streamStatus: "error",
      messages: 1,
      errorType: "invalid_request",
      stream: true
    })
    expectCompletion(
      running.recorder,
      LogEvent.rpcServerCompleted,
      "info",
      SemconvValue.outcomeCallerFault
    )
  } finally {
    await running.stop()
  }
})

test("a typed client keeps success when parser cleanup cancels after event end", async () => {
  const running = await open((server) => {
    server.registerHandler(watch, async function* (): AsyncGenerator<{ n: number }> {
      yield { n: 1 }
    })
  })
  try {
    const events = await running.client.stream(running.traced, watch, { n: 1 })
    const collected = await collect(events)
    expect(collected).toEqual({ values: [1], failure: null })
    const serverSpan = await endedSpan(running.recorder, "server", "orders/watch")
    const clientSpan = await endedSpan(running.recorder, "client", "orders/watch")
    expectUnit(serverSpan, {
      outcome: SemconvValue.outcomeSuccess,
      status: "unset",
      rpcStatus: SemconvValue.rpcStatusOk,
      streamStatus: "success",
      messages: 1,
      errorType: undefined,
      stream: true
    })
    expectUnit(clientSpan, {
      outcome: SemconvValue.outcomeSuccess,
      status: "unset",
      rpcStatus: SemconvValue.rpcStatusOk,
      streamStatus: "success",
      messages: 1,
      errorType: undefined,
      stream: true
    })
    expectCompletion(
      running.recorder,
      LogEvent.rpcServerCompleted,
      "info",
      SemconvValue.outcomeSuccess
    )
    expectCompletion(
      running.recorder,
      LogEvent.rpcClientCompleted,
      "debug",
      SemconvValue.outcomeSuccess
    )
    expectMessages(running.recorder, "orders/watch", SemconvValue.directionSent, 1)
    expectMessages(running.recorder, "orders/watch", SemconvValue.directionReceived, 1)
    expect(running.recorder.spans()).toHaveLength(2)
    expect(running.recorder.logs()).toHaveLength(2)
  } finally {
    await running.stop()
  }
})

test("a typed client records an SSE ServiceError instead of the cleanup cancel", async () => {
  const running = await open((server) => {
    server.registerHandler(fault, async function* (): AsyncGenerator<{ n: number }> {
      yield { n: 1 }
      throw serviceError("invalid_request", secret, 400)
    })
    server.registerHandler(broken, async function* (): AsyncGenerator<{ n: number }> {
      yield { n: 1 }
      throw new Error(secret)
    })
  })
  try {
    const callerFault = await collect(await running.client.stream(running.traced, fault, { n: 1 }))
    expect(callerFault.values).toEqual([1])
    expect(isServiceError(callerFault.failure)).toBe(true)
    if (!isServiceError(callerFault.failure)) throw new Error("missing service error")
    expect(callerFault.failure.code).toBe("invalid_request")
    expect(callerFault.failure.status).toBe(400)
    const faultSpan = await endedSpan(running.recorder, "client", "orders/fault")
    expectUnit(faultSpan, {
      outcome: SemconvValue.outcomeFailure,
      status: "error",
      rpcStatus: "invalid_request",
      streamStatus: "error",
      messages: 1,
      errorType: "invalid_request",
      stream: true
    })
    expectCompletion(
      running.recorder,
      LogEvent.rpcClientCompleted,
      "warn",
      SemconvValue.outcomeFailure
    )

    running.recorder.reset()
    const internal = await collect(await running.client.stream(running.traced, broken, { n: 1 }))
    expect(internal.values).toEqual([1])
    expect(isServiceError(internal.failure)).toBe(true)
    if (!isServiceError(internal.failure)) throw new Error("missing internal error")
    expect(internal.failure.code).toBe("internal")
    expect(internal.failure.message).not.toContain(secret)
    const errorSpan = await endedSpan(running.recorder, "client", "orders/broken")
    expectUnit(errorSpan, {
      outcome: SemconvValue.outcomeFailure,
      status: "error",
      rpcStatus: "internal",
      streamStatus: "error",
      messages: 1,
      errorType: "internal",
      stream: true
    })
    expect(
      running.recorder.logs().filter((item) => item.record.event === LogEvent.rpcClientCompleted)
    ).toHaveLength(1)
  } finally {
    await running.stop()
  }
})

test("a typed client records truncation when the body ends without a terminal event", async () => {
  const running = await open((server) => {
    server.registerHandler("orders", "cut", function truncated(): Response {
      return sseResponse([bytes('data: {"n":1}\n\n')])
    })
  })
  try {
    const collected = await collect(await running.client.stream(running.traced, cut, { n: 1 }))
    expect(collected.values).toEqual([1])
    expect(collected.failure).toMatchObject({
      message: "server stream ended before a terminal event"
    })
    const clientSpan = await endedSpan(running.recorder, "client", "orders/cut")
    expectUnit(clientSpan, {
      outcome: SemconvValue.outcomeFailure,
      status: "error",
      rpcStatus: SemconvValue.errorStreamTruncated,
      streamStatus: "truncated",
      messages: 1,
      errorType: SemconvValue.errorStreamTruncated,
      stream: true
    })
    const serverSpan = await endedSpan(running.recorder, "server", "orders/cut")
    expectUnit(serverSpan, {
      outcome: SemconvValue.outcomeFailure,
      status: "error",
      rpcStatus: SemconvValue.errorStreamTruncated,
      streamStatus: "truncated",
      messages: 1,
      errorType: SemconvValue.errorStreamTruncated,
      stream: false
    })
    expectCompletion(
      running.recorder,
      LogEvent.rpcClientCompleted,
      "warn",
      SemconvValue.outcomeFailure
    )
    expect(
      running.recorder.logs().filter((item) => item.record.message?.includes(secret) === true)
    ).toHaveLength(0)
  } finally {
    await running.stop()
  }
})

test("consumer return cancels the open stream once and counts the messages already delivered", async () => {
  let release = function unblock(): void {}
  const gate = new Promise<void>(function capture(resolve): void {
    release = resolve
  })
  const running = await open((server) => {
    server.registerHandler(gated, async function* (): AsyncGenerator<{ n: number }> {
      yield { n: 1 }
      await gate
    })
  })
  try {
    const events = await running.client.stream(running.traced, gated, { n: 1 })
    const iterator = events[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { n: 1 } })
    await iterator.return?.()
    await events.close()
    const clientSpan = await endedSpan(running.recorder, "client", "orders/gated")
    const serverSpan = await endedSpan(running.recorder, "server", "orders/gated")
    expectUnit(clientSpan, {
      outcome: SemconvValue.outcomeCanceled,
      status: "unset",
      rpcStatus: SemconvValue.errorCanceled,
      streamStatus: "canceled",
      messages: 1,
      errorType: SemconvValue.errorCanceled,
      stream: true
    })
    expectUnit(serverSpan, {
      outcome: SemconvValue.outcomeCanceled,
      status: "unset",
      rpcStatus: SemconvValue.errorCanceled,
      streamStatus: "canceled",
      messages: 1,
      errorType: SemconvValue.errorCanceled,
      stream: true
    })
    expectCompletion(
      running.recorder,
      LogEvent.rpcClientCompleted,
      "debug",
      SemconvValue.outcomeCanceled
    )
    expect(
      running.recorder.logs().filter((item) => item.record.event === LogEvent.rpcClientCompleted)
    ).toHaveLength(1)
    expect(running.recorder.spans().filter((span) => span.name === "orders/gated")).toHaveLength(2)
  } finally {
    release()
    await running.stop()
  }
})

test("a canceled caller context records canceled and a deadline records deadline_exceeded", async () => {
  let release = function unblock(): void {}
  const gate = new Promise<void>(function capture(resolve): void {
    release = resolve
  })
  let stopDeadline = function clearDeadline(): void {}
  const running = await open(
    (server) => {
      server.registerHandler(gated, async function* (): AsyncGenerator<{ n: number }> {
        yield { n: 1 }
        await gate
      })
      server.registerHandler(limited, async function* (): AsyncGenerator<{ n: number }> {
        yield { n: 1 }
        await new Promise<void>(function waitForever(): void {})
      })
    },
    middleware((next) => (ctx, request) => {
      if (new URL(request.url).pathname !== "/orders/limited") return next(ctx, request)
      const [child, cancel] = withTimeout(ctx, 200)
      stopDeadline = cancel
      return next(child, request)
    })
  )
  try {
    const [canceledCtx, cancel] = withCancel(running.traced)
    const canceledStream = await running.client.stream(canceledCtx, gated, { n: 1 })
    const canceledIterator = canceledStream[Symbol.asyncIterator]()
    await expect(canceledIterator.next()).resolves.toEqual({ done: false, value: { n: 1 } })
    cancel()
    await expect(canceledIterator.next()).rejects.toBe(canceled)
    await canceledStream.close()
    expectUnit(await endedSpan(running.recorder, "client", "orders/gated"), {
      outcome: SemconvValue.outcomeCanceled,
      status: "unset",
      rpcStatus: SemconvValue.errorCanceled,
      streamStatus: "canceled",
      messages: 1,
      errorType: SemconvValue.errorCanceled,
      stream: true
    })
    expectUnit(await endedSpan(running.recorder, "server", "orders/gated"), {
      outcome: SemconvValue.outcomeCanceled,
      status: "unset",
      rpcStatus: SemconvValue.errorCanceled,
      streamStatus: "canceled",
      messages: 1,
      errorType: SemconvValue.errorCanceled,
      stream: true
    })

    running.recorder.reset()
    const limitedStream = await collect(
      await running.client.stream(running.traced, limited, { n: 1 })
    )
    expect(limitedStream.values).toEqual([1])
    expect(isServiceError(limitedStream.failure)).toBe(true)
    if (!isServiceError(limitedStream.failure)) throw new Error("missing deadline error")
    expect(limitedStream.failure.code).toBe("deadline_exceeded")
    expectUnit(await endedSpan(running.recorder, "server", "orders/limited"), {
      outcome: SemconvValue.outcomeFailure,
      status: "error",
      rpcStatus: SemconvValue.errorDeadlineExceeded,
      streamStatus: "error",
      messages: 1,
      errorType: SemconvValue.errorDeadlineExceeded,
      stream: true
    })
    expectUnit(await endedSpan(running.recorder, "client", "orders/limited"), {
      outcome: SemconvValue.outcomeFailure,
      status: "error",
      rpcStatus: SemconvValue.errorDeadlineExceeded,
      streamStatus: "error",
      messages: 1,
      errorType: SemconvValue.errorDeadlineExceeded,
      stream: true
    })
    expectCompletion(
      running.recorder,
      LogEvent.rpcClientCompleted,
      "warn",
      SemconvValue.outcomeFailure
    )

    running.recorder.reset()
    const [deadlineCtx] = withTimeout(running.traced, 300)
    const deadlineStream = await running.client.stream(deadlineCtx, gated, { n: 1 })
    const deadlineIterator = deadlineStream[Symbol.asyncIterator]()
    await expect(deadlineIterator.next()).resolves.toEqual({ done: false, value: { n: 1 } })
    const deadlineFailure = await deadlineIterator.next().then(
      function unexpected(): unknown {
        return null
      },
      function rejected(error: unknown): unknown {
        return error
      }
    )
    const deadlineCode = isServiceError(deadlineFailure) ? deadlineFailure.code : null
    expect(deadlineFailure === deadlineExceeded || deadlineCode === "deadline_exceeded").toBe(true)
    await deadlineStream.close()
    expectUnit(await endedSpan(running.recorder, "client", "orders/gated"), {
      outcome: SemconvValue.outcomeFailure,
      status: "error",
      rpcStatus: SemconvValue.errorDeadlineExceeded,
      streamStatus: "error",
      messages: 1,
      errorType: SemconvValue.errorDeadlineExceeded,
      stream: true
    })
  } finally {
    release()
    stopDeadline()
    await running.stop()
  }
})

test("fragmented, coalesced, and comment frames count messages rather than chunks", async () => {
  const running = await open((server) => {
    server.registerHandler("orders", "parts", function fragmented(): Response {
      return sseResponse(slices(bytes(`data: {"n":1}\n\n${endFrame}`), 3))
    })
    server.registerHandler("orders", "blob", function coalesced(): Response {
      return sseResponse([bytes(`: ping\n\ndata: {"n":1}\n\ndata: {"n":2}\n\n${endFrame}`)])
    })
    server.registerHandler("orders", "beat", function comments(): Response {
      return sseResponse([bytes(`:\n\n: ping\n\n${endFrame}`)])
    })
  })
  try {
    const fragmented = await collect(await running.client.stream(running.traced, parts, { n: 1 }))
    expect(fragmented).toEqual({ values: [1], failure: null })
    expectUnit(await endedSpan(running.recorder, "client", "orders/parts"), {
      outcome: SemconvValue.outcomeSuccess,
      status: "unset",
      rpcStatus: SemconvValue.rpcStatusOk,
      streamStatus: "success",
      messages: 1,
      errorType: undefined,
      stream: true
    })

    running.recorder.reset()
    const coalesced = await collect(await running.client.stream(running.traced, blob, { n: 1 }))
    expect(coalesced).toEqual({ values: [1, 2], failure: null })
    expectUnit(await endedSpan(running.recorder, "client", "orders/blob"), {
      outcome: SemconvValue.outcomeSuccess,
      status: "unset",
      rpcStatus: SemconvValue.rpcStatusOk,
      streamStatus: "success",
      messages: 2,
      errorType: undefined,
      stream: true
    })
    expectMessages(running.recorder, "orders/blob", SemconvValue.directionReceived, 2)

    running.recorder.reset()
    const comments = await collect(await running.client.stream(running.traced, beat, { n: 1 }))
    expect(comments).toEqual({ values: [], failure: null })
    expectUnit(await endedSpan(running.recorder, "client", "orders/beat"), {
      outcome: SemconvValue.outcomeSuccess,
      status: "unset",
      rpcStatus: SemconvValue.rpcStatusOk,
      streamStatus: "success",
      messages: 0,
      errorType: undefined,
      stream: true
    })
  } finally {
    await running.stop()
  }
})

test("a stream read error keeps the delivered message count and the error type", async () => {
  const running = await open((server) => {
    server.registerHandler("orders", "failed", function rejectRead(): Response {
      return sseResponse([bytes('data: {"n":1}\n\n')], new StreamReadError())
    })
  })
  try {
    const collected = await collect(
      await running.client.stream(running.traced, failedRead, { n: 1 })
    )
    expect(collected.values).toEqual([1])
    expect(collected.failure).toBeInstanceOf(StreamReadError)
    expectUnit(await endedSpan(running.recorder, "client", "orders/failed"), {
      outcome: SemconvValue.outcomeFailure,
      status: "error",
      rpcStatus: "StreamReadError",
      streamStatus: "error",
      messages: 1,
      errorType: "StreamReadError",
      stream: true
    })
    expectUnit(await endedSpan(running.recorder, "server", "orders/failed"), {
      outcome: SemconvValue.outcomeFailure,
      status: "error",
      rpcStatus: "StreamReadError",
      streamStatus: "error",
      messages: 1,
      errorType: "StreamReadError",
      stream: false
    })
    expect(
      running.recorder.logs().filter((item) => item.record.event === LogEvent.rpcClientCompleted)
    ).toHaveLength(1)
  } finally {
    await running.stop()
  }
})

test("iterator steps keep the server span across an await and restore the caller afterward", async () => {
  const storage = new AsyncLocalStorage<string | null>()
  const recorder = newTelemetryRecorder()
  const tel = newTelemetry({
    tracerProvider: {
      ...recorder.tracerProvider,
      enter(ctx, fn) {
        return storage.run(explicitSpan(ctx), fn)
      }
    },
    meterProviders: [recorder.meterProvider],
    logHandlers: [recorder.logHandler],
    completionLogs: "all"
  })
  const traced = withTelemetry(background(), tel)
  const seen: {
    current: { readonly explicit: string | null; readonly implicit: string | null } | null
  } = { current: null }
  const location = `memory://stream-obs-scope`
  const memory = newMemoryTransport()
  const server = newServer(transport(memory), address(location), streamKeepAlive(0))
  server.registerHandler(watch, async function* (ctx: Context): AsyncGenerator<{ n: number }> {
    await Promise.resolve()
    seen.current = { explicit: explicitSpan(ctx), implicit: storage.getStore() ?? null }
    yield { n: 1 }
  })
  const running = server.start(traced)
  const client = newClient(withTransport(memory), withEndpoint(location))
  const caller = "caller-span"
  try {
    await server.endpoint(background())
    const outer = beginCoreUnit(traced, {
      kind: "rpc.client",
      system: "go_like",
      method: "orders/get",
      stream: false
    })
    await storage.run(caller, async function underCaller(): Promise<void> {
      await outer.run(async function call(): Promise<void> {
        const collected = await collect(await client.stream(traced, watch, { n: 1 }))
        expect(collected).toEqual({ values: [1], failure: null })
      })
      expect(storage.getStore()).toBe(caller)
    })
    expect(storage.getStore()).toBeUndefined()
    const observed = seen.current
    if (observed === null) throw new Error("missing scope observation")
    expect(observed.explicit).not.toBeNull()
    expect(observed.implicit).toBe(observed.explicit)
    expect(observed.implicit).not.toBe(caller)
    expect(observed.implicit).not.toBe(explicitSpan(outer.ctx))
    outer.end()
  } finally {
    await client.close(background())
    await server.stop(background())
    await running
  }
})

test("an event stream with an invalid clock ends the unit as a failure", () => {
  const recorder = newTelemetryRecorder()
  const traced = withTelemetry(background(), recorder.telemetry)
  const scope = beginCoreUnit(traced, {
    kind: "rpc.server",
    system: "go_like",
    method: "orders/locked",
    stream: true
  })
  const response = new Response(new ReadableStream<Uint8Array>(), {
    headers: { "content-type": eventStreamContentType }
  })
  const delivered = endResponseUnit(scope, response, { startedAt: Number.NaN })
  expect(delivered).toBe(response)
  const span = recorder.spans().find((item) => item.name === "orders/locked")
  if (span === undefined) throw new Error("missing locked span")
  expectUnit(span, {
    outcome: SemconvValue.outcomeFailure,
    status: "error",
    rpcStatus: "TypeError",
    streamStatus: "error",
    messages: 0,
    errorType: "TypeError",
    stream: true
  })
})

test("a stream read that rejects without an error still ends as a failure", async () => {
  const recorder = newTelemetryRecorder()
  const traced = withTelemetry(background(), recorder.telemetry)
  const scope = beginCoreUnit(traced, {
    kind: "rpc.server",
    system: "go_like",
    method: "orders/blank",
    stream: true
  })
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull() {
        throw undefined
      }
    }),
    { headers: { "content-type": eventStreamContentType } }
  )
  const delivered = endResponseUnit(scope, response)
  let rejected: unknown = false
  try {
    await delivered.text()
  } catch (error) {
    rejected = error
  }
  expect(rejected).toBeUndefined()
  const span = recorder.spans().find((item) => item.name === "orders/blank")
  if (span === undefined) throw new Error("missing blank span")
  expectUnit(span, {
    outcome: SemconvValue.outcomeFailure,
    status: "error",
    rpcStatus: SemconvValue.other,
    streamStatus: "error",
    messages: 0,
    errorType: SemconvValue.other,
    stream: true
  })
})

test("a broken Context.err does not replace stream cancellation", async () => {
  const recorder = newTelemetryRecorder()
  const real = withTelemetry(background(), recorder.telemetry)
  const broken = {
    deadline: () => real.deadline(),
    done: () => real.done(),
    err(): null {
      throw new Error("broken context")
    },
    value: (key: unknown) => real.value(key)
  } satisfies Context
  const scope = beginCoreUnit(broken, {
    kind: "rpc.client",
    system: "go_like",
    method: "orders/broken",
    stream: true
  })
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes(`data: {"n":1}\n\n`))
      }
    }),
    { headers: { "content-type": eventStreamContentType } }
  )
  const delivered = endResponseUnit(scope, response)
  const reader = delivered.body?.getReader()
  if (reader === undefined) throw new Error("missing body")
  const first = await reader.read()
  expect(first.done).toBe(false)
  await reader.cancel()
  const span = recorder.spans().find((item) => item.name === "orders/broken")
  if (span === undefined) throw new Error("missing broken span")
  expectUnit(span, {
    outcome: SemconvValue.outcomeCanceled,
    status: "unset",
    rpcStatus: SemconvValue.errorCanceled,
    streamStatus: "canceled",
    messages: 1,
    errorType: SemconvValue.errorCanceled,
    stream: true
  })
})

test("a throwing body callback still ends the event-stream unit", async () => {
  const recorder = newTelemetryRecorder()
  const traced = withTelemetry(background(), recorder.telemetry)
  const scope = beginCoreUnit(traced, {
    kind: "rpc.server",
    system: "go_like",
    method: "orders/callback",
    stream: true
  })
  const response = new Response(`data: {"n":1}\n\nevent: end\ndata: {}\n\n`, {
    headers: { "content-type": eventStreamContentType }
  })
  const delivered = endResponseUnit(scope, response, {
    onEnd() {
      throw new Error("callback failed")
    }
  })
  expect(await delivered.text()).toContain("event: end")
  const span = recorder.spans().find((item) => item.name === "orders/callback")
  if (span === undefined) throw new Error("missing callback span")
  expectUnit(span, {
    outcome: SemconvValue.outcomeSuccess,
    status: "unset",
    rpcStatus: SemconvValue.rpcStatusOk,
    streamStatus: "success",
    messages: 1,
    errorType: undefined,
    stream: true
  })
})

test("an uninstrumented stream still delivers its terminal event and records nothing", async () => {
  const recorder = newTelemetryRecorder()
  const location = "memory://stream-obs-quiet"
  const memory = newMemoryTransport()
  const server = newServer(transport(memory), address(location), streamKeepAlive(0))
  server.registerHandler(watch, async function* (): AsyncGenerator<{ n: number }> {
    yield { n: 1 }
  })
  const running = server.start(background())
  const client = newClient(withTransport(memory), withEndpoint(location))
  try {
    await server.endpoint(background())
    const collected = await collect(await client.stream(background(), watch, { n: 1 }))
    expect(collected).toEqual({ values: [1], failure: null })
    expect(recorder.spans()).toEqual([])
    expect(recorder.logs()).toEqual([])
    expect(recorder.measurements()).toEqual([])
  } finally {
    await client.close(background())
    await server.stop(background())
    await running
  }
})

/** Reads a real span id, treating the all-zero placeholder as no span. */
function explicitSpan(ctx: Context): string | null {
  const id = spanFromContext(ctx).spanContext().spanId
  return /^0+$/.test(id) ? null : id
}
