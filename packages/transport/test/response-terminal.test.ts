import { getEventListeners } from "node:events"

import { expect, test } from "bun:test"

import { observeResponseBody, type ResponseBodyEnd } from "../src/index"

const encoder = new TextEncoder()

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

/** Resolves after the given number of milliseconds. */
function pause(ms: number): Promise<void> {
  return new Promise(function wait(resolve): void {
    setTimeout(resolve, ms)
  })
}

test("Q2-05 reports a terminal SSE event before the source reaches EOF", async () => {
  for (const event of ["end", "error"] as const) {
    const observed = collect()
    let release = function noop(): void {}
    const gate = new Promise<void>(function capture(resolve): void {
      release = resolve
    })
    const data =
      event === "end"
        ? "{}"
        : JSON.stringify({ code: "internal", message: "expected", status: 500 })
    let cancels = 0
    let control: ReadableStreamDefaultController<Uint8Array> | undefined
    const body = new ReadableStream<Uint8Array>({
      /** Sends one business frame and the terminal frame, then withholds EOF. */
      start(controller): void {
        control = controller
        controller.enqueue(encoder.encode(`data: {"n":1}\n\nevent: ${event}\ndata: ${data}\n\n`))
      },
      /** Blocks any reader that keeps pulling after the terminal event. */
      async pull(): Promise<void> {
        await gate
      },
      /** Records cancellation of the unread tail. */
      cancel(): void {
        cancels += 1
      }
    })
    const response = observeResponseBody(
      new Response(body, { headers: { "content-type": "text/event-stream" } }),
      observed.onEnd
    )
    const reader = response.body?.getReader()
    if (reader === undefined) throw new Error("observed body was missing")
    try {
      const first = await reader.read()
      const bytes = new TextDecoder().decode(first.value)
      expect(bytes).toContain(`event: ${event}`)
      expect(observed.events).toHaveLength(1)
      const second = await reader.read()
      expect(second.done).toBe(true)
      expect(observed.events[0]?.reason).toBe(event === "error" ? "error" : "end")
      expect(observed.events[0]?.status).toEqual(
        event === "error" ? { kind: "error", code: "internal", status: 500 } : { kind: "success" }
      )
      expect(observed.events[0]?.messageCount).toBe(1)
      expect(cancels).toBe(0)
      await reader.cancel()
      expect(cancels).toBe(0)
      expect(observed.events).toHaveLength(1)
      if (control === undefined) throw new Error("source controller missing")
      control.close()
    } finally {
      release()
      await reader.cancel().catch(function ignore(): void {})
    }
  }
})

test("Q2-05 cancelSource still cancels a transport body after a terminal SSE event", async () => {
  const observed = collect()
  let cancels = 0
  const body = new ReadableStream<Uint8Array>({
    /** Sends a terminal frame and leaves the producer open. */
    start(controller): void {
      controller.enqueue(encoder.encode("event: end\ndata: {}\n\n"))
    },
    /** Records cancellation of the transport body. */
    cancel(): void {
      cancels += 1
    }
  })
  const response = observeResponseBody(
    new Response(body, { headers: { "content-type": "text/event-stream" } }),
    observed.onEnd,
    { cancelSource: true }
  )
  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error("observed body was missing")
  try {
    await reader.read()
    expect(cancels).toBeGreaterThan(0)
    expect(observed.events[0]?.reason).toBe("end")
    const before = cancels
    await reader.cancel()
    expect(cancels).toBe(before)
    expect(observed.events).toHaveLength(1)
  } finally {
    await reader.cancel().catch(function ignore(): void {})
  }
})

test("Q2-05 does not finish observation on a business event alone", async () => {
  const observed = collect()
  let release = function noop(): void {}
  const gate = new Promise<void>(function capture(resolve): void {
    release = resolve
  })
  const body = new ReadableStream<Uint8Array>({
    /** Sends one business frame and then withholds EOF. */
    start(controller): void {
      controller.enqueue(encoder.encode('data: {"n":1}\n\n'))
    },
    /** Keeps the source open so the test can prove the observer is still waiting. */
    async pull(): Promise<void> {
      await gate
    }
  })
  const response = observeResponseBody(
    new Response(body, { headers: { "content-type": "text/event-stream" } }),
    observed.onEnd
  )
  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error("observed body was missing")
  try {
    await reader.read()
    await pause(20)
    expect(observed.events).toHaveLength(0)
  } finally {
    release()
    await reader.cancel().catch(function ignore(): void {})
  }
})

test("Q2-04 an aborted observe signal cancels the source without failing a later body cancel", async () => {
  const observed = collect()
  let cancels = 0
  const body = new ReadableStream<Uint8Array>({
    /** Stays open until the external signal cancels it. */
    pull(): void {},
    /** Records source cancellation. */
    cancel(): void {
      cancels += 1
    }
  })
  const controller = new AbortController()
  const response = observeResponseBody(
    new Response(body, { headers: { "content-type": "text/plain" } }),
    observed.onEnd,
    { signal: controller.signal }
  )
  controller.abort(new Error("caller stopped"))
  await Promise.resolve()
  expect(cancels).toBe(1)
  expect(observed.events[0]?.reason).toBe("cancel")
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
  await response.body?.cancel()
  expect(cancels).toBe(1)
  expect(observed.events).toHaveLength(1)
})

test("Q2-04 abort during a blocked read ends the observed body", async () => {
  const observed = collect()
  let cancels = 0
  let release = function noop(): void {}
  const gate = new Promise<void>(function capture(resolve): void {
    release = resolve
  })
  const body = new ReadableStream<Uint8Array>({
    /** Blocks the in-flight read until the test releases it. */
    async pull(): Promise<void> {
      await gate
    },
    /** Records source cancellation. */
    cancel(): void {
      cancels += 1
    }
  })
  const controller = new AbortController()
  const response = observeResponseBody(new Response(body), observed.onEnd, {
    signal: controller.signal
  })
  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error("observed body was missing")
  const pending = reader.read().then(
    function settled(): string {
      return "settled"
    },
    function failed(): string {
      return "settled"
    }
  )
  try {
    controller.abort(new Error("stop"))
    const winner = await Promise.race([
      pending,
      pause(50).then(function hung(): string {
        return "hung"
      })
    ])
    expect(winner).toBe("settled")
    expect(cancels).toBe(1)
    expect(observed.events[0]?.reason).toBe("cancel")
  } finally {
    release()
    await reader.cancel().catch(function ignore(): void {})
  }
})

test("Q2-04 an already-aborted observe signal cancels the source immediately", () => {
  const observed = collect()
  let cancels = 0
  const controller = new AbortController()
  controller.abort(new Error("already"))
  const body = new ReadableStream<Uint8Array>({
    /** Records source cancellation and rejects so the observer must ignore it. */
    cancel(): Promise<void> {
      cancels += 1
      return Promise.reject(new Error("cancel failed"))
    }
  })
  observeResponseBody(new Response(body), observed.onEnd, { signal: controller.signal })
  expect(cancels).toBe(1)
  expect(observed.events[0]?.reason).toBe("cancel")
  expect(observed.events[0]?.cause).toBe(controller.signal.reason)
})
