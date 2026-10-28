import { runInNewContext } from "node:vm"

import { expect, test } from "bun:test"

import {
  afterFunc,
  background,
  canceled,
  cause,
  withCancel,
  withCancelCause,
  withValue,
  type Context
} from "@go-like/context"
import { values } from "@go-like/metadata"
import {
  fromServerContext,
  secure,
  timeout,
  tlsConfig,
  withConnClose,
  withTimeout as withDialTimeout,
  type ListenOption,
  type TransportInfo
} from "@go-like/transport"

import { effectiveTimeout } from "../src/options"
import { newMemoryTransport } from "../src/index"
import { failMemoryListener } from "../src/testing"

/** Builds one POST request against a bound memory address. */
function request(address: string, path = "/payment.v1/pay", signal?: AbortSignal): Request {
  const init: RequestInit = { method: "POST", body: "{}" }
  if (signal !== undefined) init.signal = signal
  return new Request(new URL(path, address), init)
}

/** Resolves once ctx becomes terminal. */
async function untilCanceled(ctx: Context): Promise<void> {
  if (ctx.err() !== null) return
  await new Promise<void>(function wait(resolve): void {
    afterFunc(ctx, function done(): void {
      resolve()
    })
  })
}

test("keeps an exclusive address map and canonicalizes memory URLs", async () => {
  const transport = newMemoryTransport()
  expect(transport.kind()).toBe("memory")
  expect(transport.string()).toBe("memory")
  const first = await transport.listen(background(), "memory://Hello/World")
  const second = await transport.listen(background(), "memory://onlyhost")
  expect(first.addr()).toBe("memory://hello/World")
  expect(second.addr()).toBe("memory://onlyhost/")
  await expect(transport.listen(background(), "memory://hello/World")).rejects.toThrow(
    "memory address is already bound"
  )
  const serving = first.serve(background(), () => new Response("one"))
  const other = second.serve(background(), () => new Response("two"))
  await first.close(background())
  await serving
  await expect(transport.dial(background(), first.addr())).rejects.toThrow(
    "memory address is not bound"
  )
  const client = await transport.dial(background(), second.addr(), withDialTimeout(0))
  const response = await client.fetch(background(), request(second.addr()))
  expect(await response.text()).toBe("two")
  await client.close(background())
  await second.close(background())
  await other
})

test("rejects malformed addresses, options, and unsupported capabilities", async () => {
  const transport = newMemoryTransport()
  await expect(transport.listen(background(), "")).rejects.toThrow("non-empty string")
  await expect(transport.listen(background(), "not a url")).rejects.toThrow("absolute memory URL")
  await expect(transport.dial(background(), "http://127.0.0.1")).rejects.toThrow("uncredentialed")
  await expect(transport.listen(background(), "memory://user:secret@host")).rejects.toThrow(
    "uncredentialed"
  )
  await expect(transport.listen(background(), "memory://host/path#fragment")).rejects.toThrow(
    "uncredentialed"
  )
  expect(() => transport.init(1 as never)).toThrow(TypeError)
  expect(() => transport.init(() => 1 as never)).toThrow(TypeError)
  await expect(transport.dial(background(), "memory://missing", 1 as never)).rejects.toThrow(
    TypeError
  )
  await expect(
    transport.dial(background(), "memory://missing", (() => null) as never)
  ).rejects.toThrow(TypeError)
  await expect(
    transport.dial(background(), "memory://missing", (() => ({
      timeoutMs: -1,
      connectionClose: false
    })) as never)
  ).rejects.toThrow(RangeError)
  await expect(
    transport.dial(background(), "memory://missing", (() => ({
      timeoutMs: 1,
      connectionClose: "yes"
    })) as never)
  ).rejects.toThrow(TypeError)
  await expect(
    transport.listen(background(), "memory://listen-option", 1 as never)
  ).rejects.toThrow(TypeError)
  await expect(
    transport.listen(background(), "memory://listen-option", (() => null) as never)
  ).rejects.toThrow(TypeError)
  await expect(
    transport.listen(background(), "memory://listen-option", (() => []) as never)
  ).rejects.toThrow(TypeError)
  const marked = await transport.listen(background(), "memory://listen-option", ((options) => ({
    ...options,
    seen: true
  })) as ListenOption)
  expect(marked.addr()).toBe("memory://listen-option/")
  await marked.close(background())

  const [ctx, cancel] = withCancel(background())
  await expect(
    transport.listen(ctx, "memory://canceled-reducer", (() => {
      cancel()
      return {}
    }) as ListenOption)
  ).rejects.toBe(canceled)
  await expect(transport.dial(background(), "memory://canceled-reducer/")).rejects.toThrow(
    "not bound"
  )

  transport.init(secure(true))
  await expect(transport.listen(background(), "memory://secure")).rejects.toThrow(
    "does not provide TLS"
  )
  const fresh = newMemoryTransport()
  fresh.init(
    tlsConfig({
      serverName: null,
      caCertificate: null,
      certificateChain: null,
      privateKey: null
    })
  )
  await expect(fresh.dial(background(), "memory://tls")).rejects.toThrow("does not provide TLS")
  expect(effectiveTimeout(0, 5_000)).toBe(5_000)
  expect(effectiveTimeout(10, 0)).toBe(10)
  expect(effectiveTimeout(10, 30)).toBe(10)
})

test("passes the Request by identity and the Response status, headers, and body", async () => {
  const transport = newMemoryTransport()
  const listener = await transport.listen(background(), "memory://payment")
  const observed: { ctx: Context | null; request: Request | null } = {
    ctx: null,
    request: null
  }
  const produced = new Response("paid", {
    status: 201,
    headers: { "x-reply": "yes", "set-cookie": "a" }
  })
  produced.headers.append("set-cookie", "b")
  const headers = new Headers()
  headers.append("set-cookie", "one")
  headers.append("set-cookie", "two")
  headers.append("x-trace", "alpha")
  const serving = listener.serve(background(), (ctx, incoming) => {
    observed.ctx = ctx
    observed.request = incoming
    const info = fromServerContext(ctx)
    expect(info?.replyHeaders()).toEqual({})
    return produced
  })
  const client = await transport.dial(background(), listener.addr(), withDialTimeout(0))
  const original = new Request("memory://payment/payment.v1/pay", {
    method: "POST",
    headers,
    body: "body"
  })
  const response = await client.fetch(background(), original)
  expect(observed.request).toBe(original)
  expect(response.status).toBe(201)
  expect(response.headers.get("x-reply")).toBe("yes")
  expect(await response.text()).toBe("paid")
  const info = observed.ctx === null ? null : fromServerContext(observed.ctx)
  expect(info?.kind()).toBe("memory")
  expect(info?.endpoint()).toBe(listener.addr())
  expect(info?.operation()).toBe("payment.v1/pay")
  expect(info?.peerIdentity()).toBeNull()
  expect(values(info?.requestHeaders() ?? {}, "set-cookie")).toEqual(["one", "two"])
  expect(info?.replyHeaders()).toEqual({
    "x-reply": ["yes"],
    "set-cookie": ["a", "b"]
  })
  expect(observed.ctx?.err() ?? null).toBe(canceled)
  await client.close(background())
  expect(observed.ctx?.err() ?? null).toBe(canceled)
  await listener.close(background())
  await serving
})

test("derives operation from pathname and drops oversized TransportInfo", async () => {
  const transport = newMemoryTransport()
  const listener = await transport.listen(background(), "memory://payment")
  const observed: string[] = []
  const bare: { ctx: Context | null } = { ctx: null }
  const serving = listener.serve(background(), (ctx, incoming) => {
    const info = fromServerContext(ctx)
    if (info === null) bare.ctx = ctx
    else observed.push(info.operation())
    return new Response(incoming.url)
  })
  const client = await transport.dial(background(), listener.addr(), withDialTimeout(0))
  await client.fetch(background(), new Request("memory:foo"))
  await client.fetch(background(), new Request("memory://payment"))
  await client.fetch(background(), new Request(`memory://payment/${"a".repeat(1_100)}`))
  expect(observed).toEqual(["foo", ""])
  expect(bare.ctx?.err() ?? null).toBeNull()
  expect(fromServerContext(bare.ctx ?? background())).toBeNull()
  await client.close(background())
  await listener.close(background())
  await serving
})

test("maps request abortion and caller cancellation onto the handler Context", async () => {
  const transport = newMemoryTransport()
  const listener = await transport.listen(background(), "memory://abort")
  let calls = 0
  const abortedCtx: { current: Context | null } = { current: null }
  const stringCtx: { current: Context | null } = { current: null }
  const serving = listener.serve(background(), async (ctx, incoming) => {
    calls += 1
    if (new URL(incoming.url).pathname === "/error") abortedCtx.current = ctx
    if (new URL(incoming.url).pathname === "/string") stringCtx.current = ctx
    await untilCanceled(ctx)
    return new Response("done")
  })
  const client = await transport.dial(background(), listener.addr(), withDialTimeout(0))
  const early = new AbortController()
  const earlyReason = new Error("already")
  early.abort(earlyReason)
  await expect(
    client.fetch(background(), request(listener.addr(), "/early", early.signal))
  ).rejects.toBe(earlyReason)
  expect(calls).toBe(0)

  const controller = new AbortController()
  const reason = new Error("stop")
  const pending = client.fetch(background(), request(listener.addr(), "/error", controller.signal))
  while (abortedCtx.current === null) await Promise.resolve()
  controller.abort(reason)
  await expect(pending).rejects.toBe(reason)
  expect(cause(abortedCtx.current ?? background())).toBe(reason)

  const stringController = new AbortController()
  const stringPending = client.fetch(
    background(),
    request(listener.addr(), "/string", stringController.signal)
  )
  while (stringCtx.current === null) await Promise.resolve()
  stringController.abort("stop")
  await expect(stringPending).rejects.toBe(canceled)
  expect(stringCtx.current?.err() ?? null).toBe(canceled)

  const [caller, cancelCaller] = withCancelCause(background())
  const callerFetch = client.fetch(caller, request(listener.addr(), "/caller"))
  const previous = calls
  while (calls === previous) await Promise.resolve()
  const callerReason = new Error("caller")
  cancelCaller(callerReason)
  await expect(callerFetch).rejects.toBe(callerReason)
  await client.close(background())
  await listener.close(background())
  await serving
})

test("times out, closes one client, and waits for an in-flight handler", async () => {
  const transport = newMemoryTransport()
  transport.init(timeout(0))
  const listener = await transport.listen(background(), "memory://time")
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let blocked = false
  const serving = listener.serve(background(), async (ctx, incoming) => {
    if (new URL(incoming.url).pathname === "/block") {
      blocked = true
      await gate
      await untilCanceled(ctx)
    }
    if (new URL(incoming.url).pathname === "/slow") await untilCanceled(ctx)
    return new Response("ok")
  })
  const timed = await transport.dial(
    background(),
    listener.addr(),
    withDialTimeout(40),
    withConnClose()
  )
  await expect(timed.fetch(background(), request(listener.addr(), "/slow"))).rejects.toMatchObject({
    name: "DeadlineExceeded"
  })
  await expect(timed.fetch(background(), request(listener.addr(), "/next"))).rejects.toThrow(
    "memory client is closed"
  )

  const client = await transport.dial(background(), listener.addr(), withDialTimeout(0))
  const pending = client.fetch(background(), request(listener.addr(), "/block"))
  while (!blocked) await Promise.resolve()
  const closing = client.close(background())
  release?.()
  await expect(pending).rejects.toThrow("memory client is closed")
  await closing
  const [preCanceled, cancel] = withCancel(background())
  cancel()
  await expect(client.close(preCanceled)).rejects.toBe(canceled)
  await expect(listener.close(preCanceled)).rejects.toBe(canceled)

  const replacement = await transport.dial(background(), listener.addr(), withDialTimeout(0))
  expect(await (await replacement.fetch(background(), request(listener.addr()))).text()).toBe("ok")
  await listener.close(background())
  await expect(replacement.fetch(background(), request(listener.addr()))).rejects.toThrow(
    "memory listener is closed"
  )
  await replacement.close(background())
  await serving
})

test("rejects admission mistakes without consuming a failed serve", async () => {
  const transport = newMemoryTransport()
  const listener = await transport.listen(background(), "memory://admit")
  await expect(listener.serve(background(), 1 as never)).rejects.toThrow(
    "memory serve handler must be a function"
  )
  const [preCanceled, cancel] = withCancel(background())
  cancel()
  await expect(listener.serve(preCanceled, () => new Response("no"))).rejects.toBe(canceled)
  const ac = new AbortController()
  ac.abort()
  const structural = {
    deadline(): readonly [Date, boolean] {
      return [new Date(0), false]
    },
    done(): AbortSignal {
      return ac.signal
    },
    err(): null {
      return null
    },
    value(): null {
      return null
    }
  }
  await expect(listener.serve(structural, () => new Response("no"))).rejects.toBe(canceled)
  const handlerCtx: { current: Context | null } = { current: null }
  const serving = listener.serve(background(), (ctx) => {
    handlerCtx.current = ctx
    return undefined as never
  })
  const client = await transport.dial(background(), listener.addr())
  await expect(client.fetch(background(), "no" as never)).rejects.toThrow(
    "memory client fetch requires a Request"
  )
  await expect(client.fetch(background(), request(listener.addr()))).rejects.toThrow(
    "memory handler must return a Response"
  )
  expect(handlerCtx.current?.err() ?? null).not.toBeNull()
  await expect(client.fetch(background(), request(listener.addr()))).rejects.toThrow(
    "memory handler must return a Response"
  )
  serving.catch(() => {})
  const throwing = newMemoryTransport()
  const throwingListener = await throwing.listen(background(), "memory://throw")
  const throwingServe = throwingListener.serve(background(), () => {
    throw "nope"
  })
  const throwingClient = await throwing.dial(
    background(),
    throwingListener.addr(),
    withDialTimeout(0)
  )
  const rejected = await throwingClient.fetch(background(), request(throwingListener.addr())).then(
    () => null,
    (error: unknown) => error
  )
  expect(rejected).toBeInstanceOf(Error)
  expect((rejected as Error).message).toBe("memory handler rejected")
  expect((rejected as Error).cause).toBe("nope")
  const foreign = runInNewContext('new Error("foreign handler")') as Error
  const foreignServe = throwingListener
  void foreignServe
  await throwingListener.close(background())
  await throwingServe
  const foreignTransport = newMemoryTransport()
  const foreignListener = await foreignTransport.listen(background(), "memory://foreign")
  const foreignRunning = foreignListener.serve(background(), () => {
    throw foreign
  })
  const foreignClient = await foreignTransport.dial(
    background(),
    foreignListener.addr(),
    withDialTimeout(0)
  )
  await expect(foreignClient.fetch(background(), request(foreignListener.addr()))).rejects.toBe(
    foreign
  )
  await foreignClient.close(background())
  await foreignListener.close(background())
  await foreignRunning
  await client.close(background())
  await listener.close(background())
  await serving
})

test("serves before the handler is installed and reports passive failure ownership", async () => {
  const transport = newMemoryTransport()
  const listener = await transport.listen(background(), "memory://idle")
  await listener.close(background())
  const rebound = await transport.listen(background(), "memory://idle")
  const client = await transport.dial(background(), rebound.addr(), withDialTimeout(0))
  await expect(client.fetch(background(), request(rebound.addr()))).rejects.toThrow(
    "memory listener is not serving"
  )
  const serving = rebound.serve(background(), () => new Response("up"))
  await expect(rebound.serve(background(), () => new Response("again"))).rejects.toThrow(
    "already consumed"
  )
  expect(await (await client.fetch(background(), request(rebound.addr()))).text()).toBe("up")
  const reason = new Error("host down")
  failMemoryListener(background(), rebound, reason)
  await expect(serving).rejects.toBe(reason)
  await expect(client.fetch(background(), request(rebound.addr()))).rejects.toThrow(
    "memory listener is closed"
  )
  const [preCanceled, cancel] = withCancel(background())
  cancel()
  expect(() => failMemoryListener(preCanceled, rebound, new Error("late"))).toThrow(canceled)
  expect(() => failMemoryListener(background(), rebound, "bad" as never)).toThrow(TypeError)
  const fake = {
    addr: () => "memory://fake/",
    close: () => Promise.resolve(),
    serve: () => Promise.resolve()
  }
  expect(() => failMemoryListener(background(), fake, new Error("missing"))).toThrow("not owned")
  await rebound.close(background())
  await client.close(background())
})

test("cancels a handler Context when the Response body ends and inherits caller values", async () => {
  const transport = newMemoryTransport()
  const key = Object.freeze({ name: "unit" })
  const listener = await transport.listen(background(), "memory://values")
  const handlerCtx: { current: Context | null } = { current: null }
  const serving = listener.serve(withValue(background(), key, "kept"), (ctx) => {
    handlerCtx.current = ctx
    const info: TransportInfo | null = fromServerContext(ctx)
    expect(info?.operation()).toBe("payment.v1/pay")
    return new Response("ok")
  })
  const client = await transport.dial(background(), listener.addr(), withDialTimeout(0))
  const response = await client.fetch(background(), request(listener.addr()))
  expect(await response.text()).toBe("ok")
  expect(handlerCtx.current?.value(key) ?? null).toBe("kept")
  expect(handlerCtx.current?.err() ?? null).toBe(canceled)
  await client.close(background())
  expect(handlerCtx.current?.err() ?? null).toBe(canceled)
  await listener.close(background())
  await serving
})
