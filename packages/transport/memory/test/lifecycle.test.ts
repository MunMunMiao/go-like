import { expect, test } from "bun:test"

import { background, canceled, deadlineExceeded, withCancel, withTimeout } from "@go-like/context"
import { withConnClose } from "@go-like/transport"

import { newMemoryTransport } from "../src/index"

/** Resolves on the next timer turn, after queued microtasks. */
function tick(): Promise<void> {
  return new Promise(function wait(resolve): void {
    setTimeout(resolve, 0)
  })
}

/** Recognizes one in-flight memory exchange by the fields the transport stores. */
function isExchange(value: unknown): value is { response: Promise<Response>; fail: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    "response" in value &&
    value.response instanceof Promise &&
    "fail" in value &&
    typeof value.fail === "function"
  )
}

test("Q2-03 forgets each exchange after the response body is consumed", async () => {
  const captured: Set<unknown>[] = []
  const originalAdd = Set.prototype.add
  Set.prototype.add = function add<T>(this: Set<T>, value: T): Set<T> {
    if (isExchange(value) && !captured.includes(this)) captured.push(this)
    return originalAdd.call(this, value)
  }
  try {
    const transport = newMemoryTransport()
    const listener = await transport.listen(background(), "memory://probe")
    const serving = listener.serve(background(), function respond(): Response {
      return new Response("ok")
    })
    const client = await transport.dial(background(), "memory://probe")
    try {
      for (let index = 0; index < 3; index += 1) {
        const response = await client.fetch(
          background(),
          new Request("memory://probe/test.v1/read")
        )
        expect(await response.text()).toBe("ok")
      }
      expect(captured.map((set) => set.size)).toEqual([0, 0])
    } finally {
      await client.close(background())
      await listener.close(background())
      await serving
    }
  } finally {
    Set.prototype.add = originalAdd
  }
})

test("Q2-04 keeps caller cancellation attached until the response body ends", async () => {
  const transport = newMemoryTransport()
  const listener = await transport.listen(background(), "memory://probe")
  let handlerContext: { err(): Error | null } | undefined
  let sourceCancels = 0
  const serving = listener.serve(background(), function respond(ctx): Response {
    handlerContext = ctx
    return new Response(
      new ReadableStream<Uint8Array>({
        /** Records cancellation of the handler body. */
        cancel(): void {
          sourceCancels += 1
        }
      })
    )
  })
  const client = await transport.dial(background(), "memory://probe")
  const [ctx, cancel] = withCancel(background())
  try {
    const response = await client.fetch(ctx, new Request("memory://probe/test.v1/read"))
    cancel()
    await tick()
    expect(handlerContext?.err() ?? null).not.toBeNull()
    expect(sourceCancels).toBe(1)
    await response.body?.cancel()
    expect(sourceCancels).toBe(1)
  } finally {
    await client.close(background())
    await listener.close(background())
    await serving
  }
})

test("Q3-03 cancels a Response body returned after the caller already canceled", async () => {
  const transport = newMemoryTransport()
  const listener = await transport.listen(background(), "memory://late")
  let entered!: () => void
  let returnResponse!: (response: Response) => void
  const admitted = new Promise<void>(function capture(resolve): void {
    entered = resolve
  })
  const responseGate = new Promise<Response>(function capture(resolve): void {
    returnResponse = resolve
  })
  let sourceCancels = 0
  const serving = listener.serve(background(), async function respond(): Promise<Response> {
    entered()
    return await responseGate
  })
  const client = await transport.dial(background(), "memory://late")
  const [ctx, cancel] = withCancel(background())
  const pending = client.fetch(ctx, new Request("memory://late/test.v1/read"))
  await admitted
  cancel()
  await expect(pending).rejects.toBe(canceled)
  const late = new Response(
    new ReadableStream<Uint8Array>({
      cancel(): void {
        sourceCancels += 1
      }
    })
  )
  returnResponse(late)
  await tick()
  const afterReturn = sourceCancels
  await client.close(background())
  await listener.close(background())
  await serving
  await late.body?.cancel().catch(function ignoreOrphan(): void {})
  expect(afterReturn).toBe(1)
  expect(sourceCancels).toBe(1)
})

/** Returns one text/plain body that publishes "hello" and then stays open. */
function openPlain(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      /** Publishes the only chunk. The tail stays open until upstream cancellation. */
      start(controller): void {
        controller.enqueue(new TextEncoder().encode("hello"))
      }
    }),
    { headers: { "content-type": "text/plain" } }
  )
}

test("F5 connectionClose returns the first text body and rejects the next fetch", async () => {
  const transport = newMemoryTransport()
  const address = "memory://f5-connection-close"
  const listener = await transport.listen(background(), address)
  const serving = listener.serve(background(), function respond(): Response {
    return new Response("ok", { headers: { "content-type": "text/plain" } })
  })
  const client = await transport.dial(background(), address, withConnClose())
  try {
    const first = await client.fetch(background(), new Request(`${address}/once`))
    expect(first.status).toBe(200)
    expect(await first.text()).toBe("ok")
    await expect(client.fetch(background(), new Request(`${address}/twice`))).rejects.toMatchObject(
      {
        name: "TransportClosedError"
      }
    )
  } finally {
    await client.close(background())
    await listener.close(background())
    await serving
  }
})

test("F5 request abort rejects an unfinished text/plain read", async () => {
  const transport = newMemoryTransport()
  const address = "memory://f5-request-abort"
  const listener = await transport.listen(background(), address)
  const serving = listener.serve(background(), function respond(): Response {
    return openPlain()
  })
  const client = await transport.dial(background(), address)
  const reason = new Error("request stopped")
  const controller = new AbortController()
  try {
    const response = await client.fetch(
      background(),
      new Request(`${address}/test.v1/read`, { signal: controller.signal })
    )
    const reading = response.text()
    controller.abort(reason)
    await expect(reading).rejects.toBe(reason)
  } finally {
    await client.close(background())
    await listener.close(background())
    await serving
  }
})

test("F5 closing the memory client rejects an unfinished text/plain read", async () => {
  const transport = newMemoryTransport()
  const address = "memory://f5-client-close"
  const listener = await transport.listen(background(), address)
  const serving = listener.serve(background(), function respond(): Response {
    return openPlain()
  })
  const client = await transport.dial(background(), address)
  try {
    const response = await client.fetch(background(), new Request(`${address}/test.v1/read`))
    const reading = response.text()
    await client.close(background())
    await expect(reading).rejects.toBe(canceled)
  } finally {
    await listener.close(background())
    await serving
  }
})

test("F5 caller deadline rejects an unfinished text/plain read", async () => {
  const transport = newMemoryTransport()
  const address = "memory://f5-deadline"
  const listener = await transport.listen(background(), address)
  const serving = listener.serve(background(), function respond(): Response {
    return openPlain()
  })
  const client = await transport.dial(background(), address)
  const [ctx, cancel] = withTimeout(background(), 80)
  try {
    const response = await client.fetch(ctx, new Request(`${address}/test.v1/read`))
    await expect(response.text()).rejects.toBe(deadlineExceeded)
  } finally {
    cancel()
    await client.close(background())
    await listener.close(background())
    await serving
  }
})
