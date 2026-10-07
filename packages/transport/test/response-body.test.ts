import vm from "node:vm"

import { expect, test } from "bun:test"

import { background } from "@go-like/context"

import {
  applyResponseObservers,
  observeResponseBody,
  withResponseObserver,
  type ResponseBodyEnd
} from "../src/index"

/** Asserts the shared terminal facts while allowing a tiny elapsed duration. */
function expectEnd(
  event: ResponseBodyEnd | undefined,
  expected: Omit<ResponseBodyEnd, "durationMs">
): void {
  expect(event).toMatchObject(expected)
  expect(event?.durationMs).toBeGreaterThanOrEqual(0)
  expect(Object.isFrozen(event)).toBe(true)
}

/** Records terminal body events in call order. */
function collect(): {
  readonly events: ResponseBodyEnd[]
  readonly onEnd: (end: ResponseBodyEnd) => void
} {
  const events: ResponseBodyEnd[] = []
  return {
    events,
    /** Stores one terminal event. */
    onEnd(end: ResponseBodyEnd): void {
      events.push(end)
    }
  }
}

test("F5 upstream abort rejects the unread tail of a text/plain body", async () => {
  const reason = new Error("stop")
  const abort = new AbortController()
  let sourceCancels = 0
  const observed = collect()
  const wrapped = observeResponseBody(
    new Response(
      new ReadableStream<Uint8Array>({
        /** Publishes one chunk and leaves the tail open. */
        start(controller): void {
          controller.enqueue(new TextEncoder().encode("hello"))
        },
        /** Counts source cancellation from the upstream signal. */
        cancel(): void {
          sourceCancels += 1
        }
      }),
      { headers: { "content-type": "text/plain" } }
    ),
    observed.onEnd,
    { signal: abort.signal }
  )
  const reader = wrapped.body?.getReader()
  if (reader === undefined) throw new Error("missing body")
  const first = await reader.read()
  expect(new TextDecoder().decode(first.value)).toBe("hello")
  const reading = reader.read()
  abort.abort(reason)
  await expect(reading).rejects.toBe(reason)
  expect(sourceCancels).toBe(1)
  expect(observed.events[0]?.reason).toBe("cancel")
  expect(observed.events[0]?.cause).toBe(reason)
})

test("F5 a preaborted signal rejects the first read", async () => {
  const reason = new Error("already")
  const abort = new AbortController()
  abort.abort(reason)
  const observed = collect()
  const wrapped = observeResponseBody(
    new Response(
      new ReadableStream<Uint8Array>({
        /** Would have delivered bytes if cancellation became EOF. */
        start(controller): void {
          controller.enqueue(new TextEncoder().encode("hello"))
        }
      }),
      { headers: { "content-type": "text/plain" } }
    ),
    observed.onEnd,
    { signal: abort.signal }
  )
  const reader = wrapped.body?.getReader()
  if (reader === undefined) throw new Error("missing body")
  await expect(reader.read()).rejects.toBe(reason)
  expect(observed.events[0]?.reason).toBe("cancel")
  expect(observed.events[0]?.cause).toBe(reason)
})

test("Q4-06 preserves a cross-realm abort Error on a later read", async () => {
  const reason = vm.runInNewContext('new Error("cross realm stop")') as Error
  const isError = Object.getOwnPropertyDescriptor(Error, "isError")?.value as
    | ((value: unknown) => boolean)
    | undefined
  expect(typeof isError).toBe("function")
  expect(isError?.(reason)).toBe(true)
  expect(reason instanceof Error).toBe(false)
  const abort = new AbortController()
  const observed = collect()
  const wrapped = observeResponseBody(
    new Response(new ReadableStream<Uint8Array>()),
    observed.onEnd,
    {
      signal: abort.signal
    }
  )
  const reader = wrapped.body?.getReader()
  if (reader === undefined) throw new Error("missing body")
  const reading = reader.read()
  abort.abort(reason)
  await expect(reading).rejects.toBe(reason)
  expect(observed.events[0]?.reason).toBe("cancel")
  expect(observed.events[0]?.cause).toBe(reason)
})

test("F5 a non-Error abort reason rejects with response body canceled", async () => {
  const abort = new AbortController()
  const wrapped = observeResponseBody(
    new Response(new ReadableStream<Uint8Array>()),
    function ignore(): void {},
    { signal: abort.signal }
  )
  const reader = wrapped.body?.getReader()
  if (reader === undefined) throw new Error("missing body")
  const reading = reader.read()
  abort.abort("stop")
  await expect(reading).rejects.toThrow("response body canceled")
})

test("F5 a source failure during an upstream abort still rejects with the abort reason", async () => {
  const reason = new Error("stop")
  const abort = new AbortController()
  let failSource = function noop(): void {}
  let pullStarted = function noop(): void {}
  const started = new Promise<void>(function capture(resolve): void {
    pullStarted = resolve
  })
  const observed = collect()
  const wrapped = observeResponseBody(
    new Response(
      new ReadableStream<Uint8Array>({
        /** Captures the controller so the observer can fail the source mid-abort. */
        start(controller): void {
          failSource = function errorSource(): void {
            controller.error(new Error("boom"))
          }
        },
        /** Stays pending until the abort races a source error. */
        pull(): Promise<void> {
          pullStarted()
          return new Promise<void>(function hang(): void {})
        }
      }),
      { headers: { "content-type": "text/plain" } }
    ),
    function observe(end: ResponseBodyEnd): void {
      observed.onEnd(end)
      failSource()
    },
    { signal: abort.signal }
  )
  const reader = wrapped.body?.getReader()
  if (reader === undefined) throw new Error("missing body")
  const reading = reader.read()
  await started
  abort.abort(reason)
  await expect(reading).rejects.toBe(reason)
  expect(observed.events[0]?.reason).toBe("cancel")
  expect(observed.events[0]?.cause).toBe(reason)
})

test("F5 consumer cancel resolves a later read as done", async () => {
  const observed = collect()
  let sourceCancels = 0
  const wrapped = observeResponseBody(
    new Response(
      new ReadableStream<Uint8Array>({
        /** Publishes bytes the consumer chooses not to finish. */
        start(controller): void {
          controller.enqueue(new TextEncoder().encode("hello"))
        },
        /** Counts cancellation requested by the downstream reader. */
        cancel(): void {
          sourceCancels += 1
        }
      }),
      { headers: { "content-type": "text/plain" } }
    ),
    observed.onEnd
  )
  const reader = wrapped.body?.getReader()
  if (reader === undefined) throw new Error("missing body")
  await reader.cancel(new Error("consumer"))
  await expect(reader.read()).resolves.toEqual({ done: true, value: undefined })
  expect(sourceCancels).toBe(1)
  expect(observed.events[0]?.reason).toBe("cancel")
})

test("Q3-01 propagateCancel rejects an incomplete body read with the abort reason", async () => {
  const reason = new Error("stop")
  const abort = new AbortController()
  let sourceCancels = 0
  const observed = collect()
  const wrapped = observeResponseBody(
    new Response(
      new ReadableStream<Uint8Array>({
        cancel(): void {
          sourceCancels += 1
        }
      })
    ),
    observed.onEnd,
    { signal: abort.signal }
  )
  const reader = wrapped.body?.getReader()
  if (reader === undefined) throw new Error("missing body")
  const reading = reader.read()
  abort.abort(reason)
  await expect(reading).rejects.toBe(reason)
  expect(sourceCancels).toBe(1)
  expect(observed.events[0]?.reason).toBe("cancel")
})

test("rejects a non-Response and a non-function callback", () => {
  expect(() => observeResponseBody("no" as never, function ignore(): void {})).toThrow(TypeError)
  expect(() => observeResponseBody(new Response(null), "no" as never)).toThrow(TypeError)
})

test("reports a null body at delivery and returns the same Response", () => {
  const observed = collect()
  const response = new Response(null, { status: 204 })
  const wrapped = observeResponseBody(response, observed.onEnd)
  expect(wrapped).toBe(response)
  expectEnd(observed.events[0], {
    reason: "end",
    cause: null,
    handshakeMs: 0,
    messageCount: 0,
    httpStatus: 204,
    stream: false,
    status: { kind: "success" }
  })
})

test("reports an already-consumed body at observation time", async () => {
  const observed = collect()
  const response = new Response("used")
  expect(await response.text()).toBe("used")
  const wrapped = observeResponseBody(response, observed.onEnd)
  expect(wrapped).toBe(response)
  expectEnd(observed.events[0], {
    reason: "end",
    cause: null,
    handshakeMs: 0,
    messageCount: 0,
    httpStatus: 200,
    stream: false,
    status: { kind: "success" }
  })
})

test("reports EOF once and preserves status, headers, and bytes", async () => {
  const observed = collect()
  const stream = new ReadableStream<Uint8Array>({
    /** Emits two chunks and then ends. */
    start(controller): void {
      controller.enqueue(new Uint8Array([1, 2]))
      controller.enqueue(new Uint8Array([3]))
      controller.close()
    }
  })
  const original = new Response(stream, { status: 201, headers: { "x-reply": "yes" } })
  const wrapped = observeResponseBody(original, observed.onEnd)
  expect(wrapped).not.toBe(original)
  expect(wrapped.status).toBe(201)
  expect(wrapped.headers.get("x-reply")).toBe("yes")
  expect(observed.events).toEqual([])
  expect(new Uint8Array(await wrapped.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
  expectEnd(observed.events[0], {
    reason: "end",
    cause: null,
    handshakeMs: 0,
    messageCount: 0,
    httpStatus: 201,
    stream: false,
    status: { kind: "success" }
  })
  await wrapped.body?.cancel(new Error("late")).catch(function ignore(): void {})
  expect(observed.events).toHaveLength(1)
})

test("reports an empty closed stream as EOF", async () => {
  const observed = collect()
  const wrapped = observeResponseBody(
    new Response(
      new ReadableStream<Uint8Array>({
        /** Closes before the consumer reads. */
        start(controller): void {
          controller.close()
        }
      })
    ),
    observed.onEnd
  )
  expect(await wrapped.text()).toBe("")
  expectEnd(observed.events[0], {
    reason: "end",
    cause: null,
    handshakeMs: 0,
    messageCount: 0,
    httpStatus: 200,
    stream: false,
    status: { kind: "success" }
  })
})

test("reports a read error and still rejects the consumer", async () => {
  const observed = collect()
  const failure = new Error("broke")
  const wrapped = observeResponseBody(
    new Response(
      new ReadableStream<Uint8Array>({
        /** Fails the source before any byte is produced. */
        start(controller): void {
          controller.error(failure)
        }
      })
    ),
    observed.onEnd
  )
  await expect(wrapped.text()).rejects.toThrow("broke")
  expectEnd(observed.events[0], {
    reason: "error",
    cause: failure,
    handshakeMs: 0,
    messageCount: 0,
    httpStatus: 200,
    stream: false,
    status: { kind: "error", code: "transport", status: 500 }
  })
})

test("reports body cancel with the caller reason", async () => {
  const observed = collect()
  let release = function noop(): void {}
  const gate = new Promise<void>(function capture(resolve): void {
    release = resolve
  })
  const wrapped = observeResponseBody(
    new Response(
      new ReadableStream<Uint8Array>({
        /** Stays open until the test releases the source. */
        async pull(): Promise<void> {
          await gate
        }
      })
    ),
    observed.onEnd
  )
  const reason = new Error("stop")
  try {
    expect(observed.events).toEqual([])
    await wrapped.body?.cancel(reason)
    expectEnd(observed.events[0], {
      reason: "cancel",
      cause: reason,
      handshakeMs: 0,
      messageCount: 0,
      httpStatus: 200,
      stream: false,
      status: { kind: "canceled" }
    })
  } finally {
    release()
  }
})

test("reports cancel once when a read is already in flight", async () => {
  const observed = collect()
  let release = function noop(): void {}
  const gate = new Promise<void>(function capture(resolve): void {
    release = resolve
  })
  let started: (() => void) | undefined
  const ready = new Promise<void>(function captureReady(resolve): void {
    started = resolve
  })
  const wrapped = observeResponseBody(
    new Response(
      new ReadableStream<Uint8Array>({
        /** Stays pending so cancel overlaps the consumer read. */
        async pull(): Promise<void> {
          started?.()
          await gate
        }
      })
    ),
    observed.onEnd
  )
  const reader = wrapped.body?.getReader()
  if (reader === undefined) throw new Error("wrapped body is missing")
  const pending = reader.read()
  try {
    await ready
    const reason = new Error("stop")
    await reader.cancel(reason)
    expectEnd(observed.events[0], {
      reason: "cancel",
      cause: reason,
      handshakeMs: 0,
      messageCount: 0,
      httpStatus: 200,
      stream: false,
      status: { kind: "canceled" }
    })
  } finally {
    release()
    await pending.catch(function ignore(): void {})
  }
})

test("keeps the body outcome when the callback throws", async () => {
  let calls = 0
  const wrapped = observeResponseBody(new Response("ok", { status: 200 }), function fail(): void {
    calls += 1
    throw new Error("observer")
  })
  expect(await wrapped.text()).toBe("ok")
  expect(calls).toBe(1)
})

test("counts business SSE messages and classifies end, error, and truncation", async () => {
  const encoder = new TextEncoder()
  const observed = collect()
  const started = performance.now()
  const wrapped = observeResponseBody(
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(
            encoder.encode(':\n\ndata: {"n":1}\n\ndata: {"n":2}\n\nevent: end\ndata: {}\n\n')
          )
          controller.close()
        }
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } }
    ),
    observed.onEnd,
    { startedAt: started - 25, headersAt: started - 5 }
  )
  expect(await wrapped.text()).toContain("event: end")
  expectEnd(observed.events[0], {
    reason: "end",
    cause: null,
    handshakeMs: 20,
    messageCount: 2,
    httpStatus: 200,
    stream: true,
    status: { kind: "success" }
  })
  expect(observed.events[0]?.durationMs).toBeGreaterThanOrEqual(25)

  const failed = collect()
  const errorBody = new Response(
    new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(
          encoder.encode(
            ':\n\ndata: {"n":1}\n\nevent: error\ndata: {"code":"internal","message":"nope","status":500,"metadata":{}}\n\n'
          )
        )
        controller.close()
      }
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } }
  )
  expect(await observeResponseBody(errorBody, failed.onEnd).text()).toContain("event: error")
  expect(failed.events[0]?.messageCount).toBe(1)
  expect(failed.events[0]?.status).toEqual({ kind: "error", code: "internal", status: 500 })

  const truncated = collect()
  const cut = new Response(
    new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(encoder.encode(':\n\ndata: {"n":1}\n\n'))
        controller.close()
      }
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } }
  )
  await observeResponseBody(cut, truncated.onEnd).text()
  expect(truncated.events[0]?.messageCount).toBe(1)
  expect(truncated.events[0]?.status).toEqual({ kind: "truncated" })
})

test("keeps a terminal SSE status when the consumer cancels after that event", async () => {
  const encoder = new TextEncoder()
  const observed = collect()
  const wrapped = observeResponseBody(
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(encoder.encode('data: {"n":1}\n\nevent: end\ndata: {}\n\n'))
          controller.close()
        }
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } }
    ),
    observed.onEnd
  )
  const reader = wrapped.body?.getReader()
  if (reader === undefined) throw new Error("missing body")
  await reader.read()
  await reader.cancel(new Error("cleanup"))
  expect(observed.events).toHaveLength(1)
  expect(observed.events[0]?.messageCount).toBe(1)
  expect(observed.events[0]?.status).toEqual({ kind: "success" })
})

test("applies context response observers before the body is read", async () => {
  const seen: number[] = []
  const ctx = withResponseObserver(background(), function watch(response: Response): Response {
    seen.push(response.status)
    return response
  })
  const response = new Response("ok", { status: 202 })
  const wrapped = applyResponseObservers(ctx, response)
  expect(seen).toEqual([202])
  expect(await wrapped.text()).toBe("ok")
  expect(applyResponseObservers(background(), response).status).toBe(202)
})

test("stacks observers and rejects malformed observation input", async () => {
  const order: string[] = []
  const ctx = withResponseObserver(
    withResponseObserver(background(), function outer(response: Response): Response {
      order.push("outer")
      return response
    }),
    function inner(response: Response): Response {
      order.push("inner")
      return response
    }
  )
  const wrapped = applyResponseObservers(ctx, new Response("ok"))
  expect(order).toEqual(["outer", "inner"])
  expect(await wrapped.text()).toBe("ok")
  expect(() => applyResponseObservers(background(), "no" as never)).toThrow(TypeError)
  const bad = withResponseObserver(background(), function broken(): Response {
    return "no" as never
  })
  expect(() => applyResponseObservers(bad, new Response("ok"))).toThrow(
    "response observer must return a Response"
  )
  expect(() =>
    observeResponseBody(new Response("ok"), function ignore(): void {}, { startedAt: Number.NaN })
  ).toThrow(TypeError)
})

test("counts CRLF events and keeps an error status when parsing fails or the consumer cancels", async () => {
  const encoder = new TextEncoder()
  const canceled = collect()
  const wrapped = observeResponseBody(
    new Response(
      encoder.encode(
        'data: {"n":1}\r\n\r\nevent: error\r\ndata: {"code":"internal","status":500}\r\n\r\n'
      ),
      { status: 200, headers: { "content-type": "text/event-stream" } }
    ),
    canceled.onEnd
  )
  const reader = wrapped.body?.getReader()
  if (reader === undefined) throw new Error("missing body")
  await reader.read()
  await reader.cancel()
  expect(canceled.events[0]?.status).toEqual({ kind: "error", code: "internal", status: 500 })

  const invalid = collect()
  await observeResponseBody(
    new Response(encoder.encode("event: error\ndata: {\n\n"), {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    }),
    invalid.onEnd
  ).text()
  expect(invalid.events[0]?.status).toEqual({ kind: "error", code: "internal", status: 500 })

  const scalar = collect()
  await observeResponseBody(
    new Response(encoder.encode("event: error\ndata: null\n\n"), {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    }),
    scalar.onEnd
  ).text()
  expect(scalar.events[0]?.status).toEqual({ kind: "error", code: "internal", status: 500 })
})
