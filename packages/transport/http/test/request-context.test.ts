import { getEventListeners } from "node:events"

import { expect, test } from "bun:test"

import { background, canceled, withCancel, type Context } from "@go-like/context"

import { dispatchHTTPHostRequest } from "../src/socket"
import type { HTTPHostRequest } from "../src/types"

/** Counts abort listeners registered on a cancelable Context. */
function abortListeners(ctx: Context): number {
  const signal = ctx.done()
  if (signal === null) throw new Error("parent Context must be cancelable")
  return getEventListeners(signal, "abort").length
}

/** Builds one host request envelope. */
function hostRequest(path: string, signal?: AbortSignal): HTTPHostRequest {
  const init: RequestInit = { method: "POST", body: "{}" }
  if (signal !== undefined) init.signal = signal
  return Object.freeze({
    request: new Request(`http://127.0.0.1${path}`, init),
    localAddress: "127.0.0.1:1",
    remoteAddress: "127.0.0.1:2"
  })
}

test("does not leak request Context listeners across unary host dispatches", async () => {
  const [owner, cancelOwner] = withCancel(background())
  const before = abortListeners(owner)
  try {
    for (let index = 0; index < 6; index += 1) {
      const response = await dispatchHTTPHostRequest(
        owner,
        () => new Response("ok"),
        hostRequest(`/n/${index}`)
      )
      expect(await response.text()).toBe("ok")
    }
    expect(abortListeners(owner)).toBe(before)
  } finally {
    cancelOwner()
  }
})

test("cancels the host request Context when the Response body reaches EOF", async () => {
  const [owner, cancelOwner] = withCancel(background())
  const seen: { ctx: Context | null } = { ctx: null }
  const input = hostRequest("/eof")
  try {
    const response = await dispatchHTTPHostRequest(
      owner,
      function handle(ctx): Response {
        seen.ctx = ctx
        return new Response("ok", { status: 201 })
      },
      input
    )
    expect(response.status).toBe(201)
    expect(seen.ctx?.err() ?? null).toBeNull()
    expect(getEventListeners(input.request.signal, "abort").length).toBe(1)
    expect(await response.text()).toBe("ok")
    expect(seen.ctx?.err() ?? null).toBe(canceled)
    expect(getEventListeners(input.request.signal, "abort").length).toBe(0)
  } finally {
    cancelOwner()
  }
})

test("cancels the host request Context when the Response body is canceled", async () => {
  const [owner, cancelOwner] = withCancel(background())
  const seen: { ctx: Context | null } = { ctx: null }
  let release = function noop(): void {}
  const gate = new Promise<void>(function capture(resolve): void {
    release = resolve
  })
  let response: Response | null = null
  try {
    response = await dispatchHTTPHostRequest(
      owner,
      function handle(ctx): Response {
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
      },
      hostRequest("/cancel")
    )
    expect(seen.ctx?.err() ?? null).toBeNull()
    await response.body?.cancel(new Error("stop"))
    expect(seen.ctx?.err() ?? null).toBe(canceled)
  } finally {
    release()
    await response?.body?.cancel().catch(function ignore(): void {})
    cancelOwner()
  }
})

test("cancels the host request Context when the Response body errors", async () => {
  const [owner, cancelOwner] = withCancel(background())
  const seen: { ctx: Context | null } = { ctx: null }
  try {
    const response = await dispatchHTTPHostRequest(
      owner,
      function handle(ctx): Response {
        seen.ctx = ctx
        return new Response(
          new ReadableStream<Uint8Array>({
            /** Fails the first read. */
            start(controller): void {
              controller.error(new Error("broke"))
            }
          })
        )
      },
      hostRequest("/error")
    )
    expect(seen.ctx?.err() ?? null).toBeNull()
    await expect(response.text()).rejects.toThrow(Error)
    expect(seen.ctx?.err() ?? null).toBe(canceled)
  } finally {
    cancelOwner()
  }
})

test("cancels the host request Context when a null Response body is delivered", async () => {
  const [owner, cancelOwner] = withCancel(background())
  const seen: { ctx: Context | null } = { ctx: null }
  const input = hostRequest("/empty")
  try {
    const response = await dispatchHTTPHostRequest(
      owner,
      function handle(ctx): Response {
        seen.ctx = ctx
        return new Response(null, { status: 204 })
      },
      input
    )
    expect(response.status).toBe(204)
    expect(seen.ctx?.err() ?? null).toBe(canceled)
    expect(getEventListeners(input.request.signal, "abort").length).toBe(0)
  } finally {
    cancelOwner()
  }
})
