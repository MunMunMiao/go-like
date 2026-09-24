import { expect, test } from "bun:test"

import { background, canceled, deadlineExceeded, type Context } from "@go-like/context"
import { fromServerContext, newClientContext, newMetadata } from "@go-like/metadata"
import { fromServerContext as fromServerTransportContext } from "@go-like/transport"
import {
  createContextKey,
  createContextValues,
  type CallOptions,
  type ContextValues,
  type HandlerContext
} from "@connectrpc/connect"

import { callOptions, fromHandlerContext } from "../src/index"

/** Creates one complete structural Connect HandlerContext with Web-standard boundary objects. */
function handlerContext(
  controller: AbortController,
  options: {
    readonly protocolName: "connect" | "grpc-web"
    readonly timeoutMs?: () => number | undefined
    readonly requestHeader?: Headers
    readonly responseHeader?: Headers
    readonly url?: string
  }
): HandlerContext {
  return {
    service: { typeName: "pet.v1.CatService" } as HandlerContext["service"],
    method: { name: "Purr" } as HandlerContext["method"],
    signal: controller.signal,
    timeoutMs: options.timeoutMs ?? (() => undefined),
    requestMethod: "POST",
    requestHeader: options.requestHeader ?? new Headers(),
    responseHeader: options.responseHeader ?? new Headers(),
    responseTrailer: new Headers(),
    protocolName: options.protocolName,
    values: createContextValues(),
    url: options.url ?? "https://rpc.example.test/pet.v1.CatService/Purr"
  }
}

function serverMetadata(ctx: Context) {
  const metadata = fromServerContext(ctx)
  if (metadata === null) throw new Error("server metadata must be carried")
  return metadata
}

function serverTransport(ctx: Context) {
  const transport = fromServerTransportContext(ctx)
  if (transport === null) throw new Error("server transport must be carried")
  return transport
}

test("fromHandlerContext keeps the handler signal and snapshots its absolute deadline", () => {
  const originalDateNow = Date.now
  const originalSetTimeout = globalThis.setTimeout
  const originalAbortController = globalThis.AbortController
  let now = 1_000
  Date.now = () => now
  globalThis.setTimeout = (() => {
    throw new Error("fromHandlerContext must not create a timer")
  }) as unknown as typeof setTimeout
  globalThis.AbortController = class {
    constructor() {
      throw new Error("fromHandlerContext must not create an AbortController")
    }
  } as never
  try {
    const controller = new originalAbortController()
    const ctx = fromHandlerContext(
      handlerContext(controller, { protocolName: "connect", timeoutMs: () => 250 })
    )
    const [deadline, hasDeadline] = ctx.deadline()

    now = 10_000
    expect(ctx.done()).toBe(controller.signal)
    expect(hasDeadline).toBe(true)
    expect(deadline.getTime()).toBe(1_250)
    expect(ctx.deadline()[0].getTime()).toBe(1_250)
    expect(ctx.err()).toBeNull()

    now = 1_249
    controller.abort("client disconnected")
    expect(ctx.err()).toBe(canceled)
  } finally {
    Date.now = originalDateNow
    globalThis.setTimeout = originalSetTimeout
    globalThis.AbortController = originalAbortController
  }
})

test("fromHandlerContext maps an aborted deadline to deadlineExceeded", () => {
  const originalDateNow = Date.now
  let now = 1_000
  Date.now = () => now
  try {
    const controller = new AbortController()
    const ctx = fromHandlerContext(
      handlerContext(controller, { protocolName: "connect", timeoutMs: () => 250 })
    )

    now = 1_250
    controller.abort("deadline reached")
    expect(ctx.err()).toBe(deadlineExceeded)
  } finally {
    Date.now = originalDateNow
  }
})

test("fromHandlerContext snapshots one terminal abort classification", () => {
  const originalDateNow = Date.now
  let now = 1_000
  Date.now = () => now
  try {
    const earlyController = new AbortController()
    const early = fromHandlerContext(
      handlerContext(earlyController, { protocolName: "connect", timeoutMs: () => 250 })
    )
    now = 1_249
    earlyController.abort()
    now = 1_250
    expect(early.err()).toBe(canceled)
    now = 5_000
    expect(early.err()).toBe(canceled)

    const lateController = new AbortController()
    now = 1_000
    const late = fromHandlerContext(
      handlerContext(lateController, { protocolName: "connect", timeoutMs: () => 250 })
    )
    now = 1_250
    lateController.abort()
    now = 5_000
    expect(late.err()).toBe(deadlineExceeded)
    expect(late.err()).toBe(deadlineExceeded)

    const preAbortedController = new AbortController()
    now = 1_249
    preAbortedController.abort()
    const preAborted = fromHandlerContext(
      handlerContext(preAbortedController, { protocolName: "connect", timeoutMs: () => 250 })
    )
    now = 5_000
    expect(preAborted.err()).toBe(canceled)
  } finally {
    Date.now = originalDateNow
  }
})

test("fromHandlerContext carries normalized request metadata and live Connect transport headers", () => {
  const requestHeader = new Headers([
    ["X-Trace-Id", "trace-1"],
    ["X-Values", "one"],
    ["X-Values", "two"],
    ["Set-Cookie", "first=1"],
    ["Set-Cookie", "second=2"]
  ])
  const responseHeader = new Headers([
    ["X-Reply", "initial"],
    ["Set-Cookie", "first=1"],
    ["Set-Cookie", "second=2"]
  ])
  const ctx = fromHandlerContext(
    handlerContext(new AbortController(), {
      protocolName: "connect",
      requestHeader,
      responseHeader,
      url: "https://rpc.example.test:8443/pet.v1.CatService/Purr?ignored=yes"
    })
  )
  const transport = serverTransport(ctx)

  responseHeader.set("X-Reply", "current")
  expect(serverMetadata(ctx)).toEqual({
    "set-cookie": ["first=1", "second=2"],
    "x-trace-id": ["trace-1"],
    "x-values": ["one, two"]
  })
  expect(transport.kind()).toBe("connect")
  expect(transport.operation()).toBe("/pet.v1.CatService/Purr")
  expect(transport.endpoint()).toBe("https://rpc.example.test:8443")
  expect(transport.requestHeaders()).toEqual(serverMetadata(ctx))
  expect(transport.replyHeaders()).toEqual({
    "set-cookie": ["first=1", "second=2"],
    "x-reply": ["current"]
  })
  expect(ctx.value({})).toBeNull()
})

test("fromHandlerContext preserves the grpc-web protocol name", () => {
  const ctx = fromHandlerContext(
    handlerContext(new AbortController(), { protocolName: "grpc-web" })
  )

  expect(serverTransport(ctx).kind()).toBe("grpc-web")
})

/** Creates a structural Context with only the requested native deadline and cancellation values. */
function clientContext(
  signal: AbortSignal | null,
  deadline: number | null,
  metadata?: Record<string, string | readonly string[]>
): Context {
  const base = Object.freeze({
    deadline: () =>
      deadline === null
        ? ([new Date(-62_135_596_800_000), false] as const)
        : ([new Date(deadline), true] as const),
    done: () => signal,
    err: () => null,
    value: (_key: unknown) => null
  })
  return metadata === undefined ? base : newClientContext(base, newMetadata(metadata))
}

test("callOptions maps client metadata, signal, and the remaining deadline", () => {
  const originalDateNow = Date.now
  Date.now = () => 1_000
  try {
    const controller = new AbortController()
    const options = callOptions(
      clientContext(controller.signal, 1_250, { "X-Trace": "trace-1", "X-Tag": ["one", "two"] })
    )

    expect(options.signal).toBe(controller.signal)
    expect(options.timeoutMs).toBe(250)
    expect([...new Headers(options.headers)]).toEqual([
      ["x-tag", "one, two"],
      ["x-trace", "trace-1"]
    ])
  } finally {
    Date.now = originalDateNow
  }
})

test("callOptions bounds explicit timeout to the Context deadline", () => {
  const originalDateNow = Date.now
  Date.now = () => 1_000
  try {
    const ctx = clientContext(null, 1_250)
    expect(callOptions(ctx, { timeoutMs: 500 }).timeoutMs).toBe(250)
    expect(callOptions(ctx, { timeoutMs: 100 }).timeoutMs).toBe(100)
    Date.now = () => 2_000
    expect(callOptions(ctx).timeoutMs).toBe(0)
  } finally {
    Date.now = originalDateNow
  }
})

test("callOptions merges either cancellation signal with AbortSignal.any", () => {
  const contextController = new AbortController()
  const overrideController = new AbortController()
  const merged = callOptions(clientContext(contextController.signal, null), {
    signal: overrideController.signal
  })

  expect(merged.signal).not.toBe(contextController.signal)
  expect(merged.signal).not.toBe(overrideController.signal)
  overrideController.abort("override canceled")
  expect(merged.signal?.aborted).toBe(true)

  const secondContextController = new AbortController()
  const secondOverrideController = new AbortController()
  const second = callOptions(clientContext(secondContextController.signal, null), {
    signal: secondOverrideController.signal
  })
  secondContextController.abort("context canceled")
  expect(second.signal?.aborted).toBe(true)
})

test("callOptions overlays the Like Context without mutating caller ContextValues", async () => {
  const onHeader: NonNullable<CallOptions["onHeader"]> = () => {}
  const onTrailer: NonNullable<CallOptions["onTrailer"]> = () => {}
  const originalKey = createContextKey("missing")
  const delegatedKey = createContextKey("missing")
  const contextValues = createContextValues().set(originalKey, "original")
  const overrides: CallOptions = {
    headers: new Headers({ "X-Shared": "override", "X-Only": "explicit" }),
    onHeader,
    onTrailer,
    contextValues
  }
  const ctx = clientContext(null, null, { "X-Shared": "context", "X-Kept": "metadata" })
  const options = callOptions(ctx, overrides)
  const returnedValues = options.contextValues
  const recovery = Reflect.get(await import("../src/context"), "fromCallContextValues") as
    | ((values: ContextValues | undefined) => Context | null)
    | undefined

  expect([...new Headers(options.headers)]).toEqual([
    ["x-kept", "metadata"],
    ["x-only", "explicit"],
    ["x-shared", "override"]
  ])
  expect(options.onHeader).toBe(onHeader)
  expect(options.onTrailer).toBe(onTrailer)
  expect(returnedValues).not.toBe(contextValues)
  expect(returnedValues?.get(originalKey)).toBe("original")
  expect(typeof recovery).toBe("function")
  expect(recovery?.(returnedValues)).toBe(ctx)
  expect(recovery?.(contextValues)).toBeNull()

  returnedValues?.set(delegatedKey, "delegated")
  expect(contextValues.get(delegatedKey)).toBe("delegated")
  returnedValues?.delete(originalKey)
  expect(contextValues.get(originalKey)).toBe("missing")
})

test("callOptions carries an otherwise empty Context privately", async () => {
  const ctx = background()
  const options = callOptions(ctx)
  const recovery = Reflect.get(await import("../src/context"), "fromCallContextValues") as
    | ((values: ContextValues | undefined) => Context | null)
    | undefined

  expect(Object.keys(options)).toEqual(["contextValues"])
  expect(typeof recovery).toBe("function")
  expect(recovery?.(options.contextValues)).toBe(ctx)
})

test("callOptions omits empty client metadata and preserves explicit headers", () => {
  const headers = new Headers({ "X-Explicit": "kept" })
  const ctx = newClientContext(background(), newMetadata())
  const options = callOptions(ctx, { headers })

  expect(Object.keys(callOptions(ctx))).toEqual(["contextValues"])
  expect(options.headers).toBe(headers)
})
