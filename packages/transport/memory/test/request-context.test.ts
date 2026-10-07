import { getEventListeners } from "node:events"

import { expect, test } from "bun:test"

import { background, canceled, withCancel, type Context } from "@go-like/context"
import { withTimeout } from "@go-like/transport"

import { newMemoryTransport } from "../src/index"

/** Counts abort listeners registered on a cancelable Context. */
function abortListeners(ctx: Context): number {
  const signal = ctx.done()
  if (signal === null) throw new Error("parent Context must be cancelable")
  return getEventListeners(signal, "abort").length
}

/** Builds one POST request against a bound memory address. */
function request(address: string, path: string): Request {
  return new Request(new URL(path, address), { method: "POST", body: "{}" })
}

test("does not leak request Context listeners across unary calls", async () => {
  const transport = newMemoryTransport()
  const [parent, cancelParent] = withCancel(background())
  const listener = await transport.listen(background(), "memory://request-leak")
  const serving = listener.serve(parent, () => new Response("ok"))
  const client = await transport.dial(background(), listener.addr(), withTimeout(0))
  const before = abortListeners(parent)
  try {
    for (let index = 0; index < 6; index += 1) {
      const response = await client.fetch(background(), request(listener.addr(), `/n/${index}`))
      expect(await response.text()).toBe("ok")
    }
    expect(abortListeners(parent)).toBe(before)
  } finally {
    cancelParent()
    await client.close(background())
    await listener.close(background())
    await serving.catch(function ignore(): void {})
  }
})

test("cancels the request Context when the Response body reaches EOF", async () => {
  const transport = newMemoryTransport()
  const listener = await transport.listen(background(), "memory://request-eof")
  const seen: { ctx: Context | null } = { ctx: null }
  const serving = listener.serve(background(), (ctx) => {
    seen.ctx = ctx
    return new Response("ok", { status: 201 })
  })
  const client = await transport.dial(background(), listener.addr(), withTimeout(0))
  try {
    const response = await client.fetch(background(), request(listener.addr(), "/eof"))
    expect(response.status).toBe(201)
    expect(seen.ctx?.err() ?? null).toBeNull()
    expect(await response.text()).toBe("ok")
    expect(seen.ctx?.err() ?? null).toBe(canceled)
  } finally {
    await client.close(background())
    await listener.close(background())
    await serving
  }
})

test("cancels the request Context when the Response body is canceled", async () => {
  const transport = newMemoryTransport()
  const listener = await transport.listen(background(), "memory://request-cancel")
  const seen: { ctx: Context | null } = { ctx: null }
  let release = function noop(): void {}
  const gate = new Promise<void>(function capture(resolve): void {
    release = resolve
  })
  const serving = listener.serve(background(), (ctx) => {
    seen.ctx = ctx
    return new Response(
      new ReadableStream<Uint8Array>({
        /** Stays open until the test releases or the consumer cancels. */
        async pull(controller): Promise<void> {
          await gate
          try {
            controller.close()
          } catch {
            // Consumer cancellation already terminated the body.
          }
        }
      })
    )
  })
  const client = await transport.dial(background(), listener.addr(), withTimeout(0))
  let response: Response | null = null
  try {
    response = await client.fetch(background(), request(listener.addr(), "/cancel"))
    expect(seen.ctx?.err() ?? null).toBeNull()
    await response.body?.cancel(new Error("stop"))
    expect(seen.ctx?.err() ?? null).toBe(canceled)
  } finally {
    release()
    await response?.body?.cancel().catch(function ignore(): void {})
    await client.close(background())
    await listener.close(background())
    await serving
  }
})

test("cancels the request Context when the Response body errors", async () => {
  const transport = newMemoryTransport()
  const listener = await transport.listen(background(), "memory://request-error")
  const seen: { ctx: Context | null } = { ctx: null }
  const serving = listener.serve(background(), (ctx) => {
    seen.ctx = ctx
    return new Response(
      new ReadableStream<Uint8Array>({
        /** Fails the first read. */
        start(controller): void {
          controller.error(new Error("broke"))
        }
      })
    )
  })
  const client = await transport.dial(background(), listener.addr(), withTimeout(0))
  try {
    const response = await client.fetch(background(), request(listener.addr(), "/error"))
    expect(seen.ctx?.err() ?? null).toBeNull()
    await expect(response.text()).rejects.toThrow("broke")
    expect(seen.ctx?.err() ?? null).toBe(canceled)
  } finally {
    await client.close(background())
    await listener.close(background())
    await serving
  }
})

test("cancels the request Context when a null Response body is delivered", async () => {
  const transport = newMemoryTransport()
  const listener = await transport.listen(background(), "memory://request-empty")
  const seen: { ctx: Context | null } = { ctx: null }
  const requestSignalListeners: number[] = []
  let signal: AbortSignal | null = null
  const serving = listener.serve(background(), (ctx, incoming) => {
    seen.ctx = ctx
    signal = incoming.signal
    requestSignalListeners.push(getEventListeners(incoming.signal, "abort").length)
    return new Response(null, { status: 204 })
  })
  const client = await transport.dial(background(), listener.addr(), withTimeout(0))
  try {
    const response = await client.fetch(background(), request(listener.addr(), "/empty"))
    expect(response.status).toBe(204)
    expect(seen.ctx?.err() ?? null).toBe(canceled)
    expect(requestSignalListeners).toEqual([1])
    expect(signal === null ? -1 : getEventListeners(signal, "abort").length).toBe(0)
  } finally {
    await client.close(background())
    await listener.close(background())
    await serving
  }
})
