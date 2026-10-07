import { getEventListeners } from "node:events"
import vm from "node:vm"

import { expect, test } from "bun:test"

import { background, type Context, withCancel, withCancelCause } from "@go-like/context"
import { executor, newHTTPTransport } from "@go-like/transport-http"

/** Resolves on the next timer turn, after queued microtasks. */
function tick(): Promise<void> {
  return new Promise(function wait(resolve): void {
    setTimeout(resolve, 0)
  })
}

test("Q2-06 completed HTTP exchanges remove caller cancellation listeners", async () => {
  const transport = newHTTPTransport(
    executor(async function respond(): Promise<Response> {
      return new Response("ok")
    })
  )
  const client = await transport.dial(background(), "example.test:8080")
  const [ctx, cancel] = withCancel(background())
  const signal = ctx.done()
  if (signal === null) throw new Error("cancelable context has no signal")
  const before = getEventListeners(signal, "abort").length
  try {
    for (let index = 0; index < 3; index += 1) {
      const response = await client.fetch(ctx, new Request("http://example.test:8080/test.v1/read"))
      expect(await response.text()).toBe("ok")
    }
    expect(getEventListeners(signal, "abort")).toHaveLength(before)
    await client.close(background())
    expect(getEventListeners(signal, "abort")).toHaveLength(before)
  } finally {
    cancel()
    await client.close(background())
  }
})

test("Q2-07 Request.signal still cancels the body after response headers", async () => {
  let sourceCanceled = 0
  const transport = newHTTPTransport(
    executor(async function respond(): Promise<Response> {
      return new Response(
        new ReadableStream<Uint8Array>({
          /** Records executor-body cancellation. */
          cancel(): void {
            sourceCanceled += 1
          }
        })
      )
    })
  )
  const client = await transport.dial(background(), "example.test:8080")
  const controller = new AbortController()
  try {
    const response = await client.fetch(
      background(),
      new Request("http://example.test:8080/test.v1/read", { signal: controller.signal })
    )
    controller.abort(new Error("caller stopped"))
    await tick()
    expect(sourceCanceled).toBe(1)
    expect(response.bodyUsed).toBe(false)
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
  } finally {
    await client.close(background())
  }
})

test("Q2-06 a null response body does not leave a caller listener", async () => {
  const transport = newHTTPTransport(
    executor(async function respond(): Promise<Response> {
      return new Response(null, { status: 204 })
    })
  )
  const client = await transport.dial(background(), "example.test:8080")
  const [ctx, cancel] = withCancel(background())
  const signal = ctx.done()
  if (signal === null) throw new Error("cancelable context has no signal")
  const before = getEventListeners(signal, "abort").length
  try {
    const response = await client.fetch(ctx, new Request("http://example.test:8080/test.v1/read"))
    expect(response.body).toBeNull()
    expect(getEventListeners(signal, "abort")).toHaveLength(before)
  } finally {
    cancel()
    await client.close(background())
  }
})

test("Q2-07 an already-aborted Request rejects before a body listener is left behind", async () => {
  const transport = newHTTPTransport(
    executor(async function respond(): Promise<Response> {
      return new Response("late")
    })
  )
  const client = await transport.dial(background(), "example.test:8080")
  const controller = new AbortController()
  controller.abort(new Error("already"))
  try {
    const pending = client.fetch(
      background(),
      new Request("http://example.test:8080/test.v1/read", { signal: controller.signal })
    )
    await expect(pending).rejects.toBe(controller.signal.reason)
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
  } finally {
    await client.close(background())
  }
})

test("Q2-06 an already-aborted caller signal cancels the body without a listener", async () => {
  let sourceCanceled = 0
  const transport = newHTTPTransport(
    executor(async function respond(): Promise<Response> {
      return new Response(
        new ReadableStream<Uint8Array>({
          /** Records executor-body cancellation. */
          cancel(): void {
            sourceCanceled += 1
          }
        })
      )
    })
  )
  const client = await transport.dial(background(), "example.test:8080")
  const live = new AbortController()
  const aborted = new AbortController()
  aborted.abort(new Error("already stopped"))
  let reads = 0
  const root = background()
  const ctx: Context = {
    deadline: () => root.deadline(),
    done(): AbortSignal {
      reads += 1
      return reads === 1 ? live.signal : aborted.signal
    },
    err: () => null,
    value: (key) => root.value(key)
  }
  try {
    const response = await client.fetch(ctx, new Request("http://example.test:8080/test.v1/read"))
    expect(sourceCanceled).toBe(1)
    expect(response.body).not.toBeNull()
    expect(getEventListeners(live.signal, "abort")).toHaveLength(0)
    expect(getEventListeners(aborted.signal, "abort")).toHaveLength(0)
  } finally {
    await client.close(background())
  }
})

/** Builds one cross-realm Error that Error.isError accepts and instanceof rejects. */
function crossRealmError(): Error {
  const reason = vm.runInNewContext('new Error("cross realm stop")') as Error
  const isError = Object.getOwnPropertyDescriptor(Error, "isError")?.value as
    | ((value: unknown) => boolean)
    | undefined
  if (typeof isError !== "function" || isError(reason) !== true || reason instanceof Error) {
    throw new Error("cross-realm Error fixture is not distinct from this realm")
  }
  return reason
}

test("Q4-06 preserves a cross-realm Request signal Error after response headers", async () => {
  const reason = crossRealmError()
  const transport = newHTTPTransport(
    executor(async function respond(): Promise<Response> {
      return new Response(new ReadableStream<Uint8Array>())
    })
  )
  const client = await transport.dial(background(), "example.test:8080")
  const abort = new AbortController()
  try {
    const response = await client.fetch(
      background(),
      new Request("http://example.test:8080/test.v1/read", { signal: abort.signal })
    )
    const body = response.body
    if (body === null) throw new Error("missing response body")
    const pending = body.getReader().read()
    abort.abort(reason)
    await expect(pending).rejects.toBe(reason)
  } finally {
    await client.close(background())
  }
})

test("Q4-06 preserves a cross-realm Context cause after response headers", async () => {
  const reason = crossRealmError()
  const transport = newHTTPTransport(
    executor(async function respond(): Promise<Response> {
      return new Response(new ReadableStream<Uint8Array>())
    })
  )
  const client = await transport.dial(background(), "example.test:8080")
  const [ctx, cancel] = withCancelCause(background())
  try {
    const response = await client.fetch(ctx, new Request("http://example.test:8080/test.v1/read"))
    const body = response.body
    if (body === null) throw new Error("missing response body")
    const pending = body.getReader().read()
    cancel(reason)
    await expect(pending).rejects.toBe(reason)
  } finally {
    cancel(null)
    await client.close(background())
  }
})
