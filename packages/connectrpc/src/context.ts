import { canceled, deadlineExceeded, type Context, type ContextError } from "@go-like/core/context"
import {
  fromClientContext,
  newMetadata,
  newServerContext as newServerMetadataContext
} from "@go-like/core/metadata"
import type { TransportInfo } from "@go-like/core/transport"
import { newServerContext as newServerTransportContext } from "@go-like/core/transport/provider"
import {
  createContextKey,
  createContextValues,
  type CallOptions,
  type ContextKey,
  type ContextValues,
  type HandlerContext
} from "@connectrpc/connect"

/** The go-like Context carried through one Connect call boundary (client: set by callOptions). */
export const likeContextKey = createContextKey<Context | null>(null, {
  description: "go-like Context"
})

function overlayContextValues(values: ContextValues, ctx: Context): ContextValues {
  let carried: Context | null = ctx
  return {
    get<T>(key: ContextKey<T>): T {
      return key === likeContextKey ? (carried as T) : values.get(key)
    },
    set<T>(key: ContextKey<T>, value: T) {
      if (key === likeContextKey) carried = value as Context | null
      else values.set(key, value)
      return this
    },
    delete(key: ContextKey<unknown>) {
      if (key === likeContextKey) carried = null
      else values.delete(key)
      return this
    }
  }
}

/** Recovers the Like Context carried through an internal Connect call boundary. */
export function fromCallContextValues(values: ContextValues | undefined): Context | null {
  return values?.get(likeContextKey) ?? null
}

/**
 * Adapts one Connect handler boundary into a structural server Context.
 * Deadline, cancellation, metadata, and transport come from the handler.
 * Values come from the `rpc.server` unit when the handler runs inside one.
 */
export function fromHandlerContext(rpc: HandlerContext): Context {
  const timeoutMs = rpc.timeoutMs()
  const deadline = timeoutMs === undefined ? null : Date.now() + timeoutMs
  const requestValues: Record<string, string | readonly string[]> = Object.fromEntries(
    rpc.requestHeader
  )
  const requestCookies = (
    rpc.requestHeader as Headers & { getSetCookie?: () => string[] }
  ).getSetCookie?.()
  if (requestCookies !== undefined && requestCookies.length > 0) {
    requestValues["set-cookie"] = requestCookies
  }
  const requestHeaders = newMetadata(requestValues)
  let err: ContextError | null = null
  if (rpc.signal.aborted) {
    err = deadline !== null && Date.now() >= deadline ? deadlineExceeded : canceled
  } else {
    rpc.signal.addEventListener(
      "abort",
      () => {
        err = deadline !== null && Date.now() >= deadline ? deadlineExceeded : canceled
      },
      { once: true }
    )
  }
  const info: TransportInfo = {
    kind: () => rpc.protocolName,
    endpoint: () => new URL(rpc.url).origin,
    operation: () => `/${rpc.service.typeName}/${rpc.method.name}`,
    requestHeaders: () => requestHeaders,
    replyHeaders: () => {
      const responseValues: Record<string, string | readonly string[]> = Object.fromEntries(
        rpc.responseHeader
      )
      const responseCookies = (
        rpc.responseHeader as Headers & { getSetCookie?: () => string[] }
      ).getSetCookie?.()
      if (responseCookies !== undefined && responseCookies.length > 0) {
        responseValues["set-cookie"] = responseCookies
      }
      return newMetadata(responseValues)
    },
    peerIdentity: () => null
  }
  const carried = rpc.values.get(likeContextKey)
  const base = Object.freeze({
    deadline: () =>
      deadline === null
        ? ([new Date(-62_135_596_800_000), false] as const)
        : ([new Date(deadline), true] as const),
    done: () => rpc.signal,
    err: () => err,
    value: (key: unknown) => (carried === null ? null : carried.value(key))
  })
  return newServerTransportContext(newServerMetadataContext(base, requestHeaders), info)
}

/** Maps portable client Context values into Connect call options. */
export function callOptions(ctx: Context, overrides: CallOptions = {}): CallOptions {
  const options: CallOptions = {
    ...overrides,
    contextValues: overlayContextValues(overrides.contextValues ?? createContextValues(), ctx)
  }
  const clientMetadata = fromClientContext(ctx)
  if (clientMetadata !== null && Object.keys(clientMetadata).length > 0) {
    const headers = new Headers()
    for (const [key, values] of Object.entries(clientMetadata)) {
      for (const value of values) headers.append(key, value)
    }
    for (const [key, value] of new Headers(overrides.headers)) headers.set(key, value)
    options.headers = headers
  }

  const signal = ctx.done()
  if (signal !== null) {
    options.signal =
      overrides.signal === undefined ? signal : AbortSignal.any([signal, overrides.signal])
  }

  const [deadline, hasDeadline] = ctx.deadline()
  if (hasDeadline) {
    const timeoutMs = Math.max(0, deadline.getTime() - Date.now())
    options.timeoutMs =
      overrides.timeoutMs === undefined ? timeoutMs : Math.min(overrides.timeoutMs, timeoutMs)
  }
  return options
}
