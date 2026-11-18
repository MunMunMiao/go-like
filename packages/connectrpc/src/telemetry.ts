import {
  Code,
  ConnectError,
  createContextKey,
  createContextValues,
  type ContextValues,
  type Interceptor,
  type StreamResponse,
  type UnaryResponse
} from "@connectrpc/connect"
import { background, canceled, type Context } from "@go-like/core/context"
import {
  beginUnit,
  injectHeaders,
  observing,
  type UnitResult,
  type UnitScope
} from "@go-like/core/telemetry/provider"

import { likeContextKey } from "./context"

/**
 * Connect context mark for a call whose `rpc.client` unit is already open.
 * It is set only while `telemetryInterceptor` is inside that call, then removed,
 * so a later call on the same values is instrumented again.
 */
const clientUnitKey = createContextKey(false, {
  description: "go-like rpc.client unit"
})

/** Host Context for a portable `newHandler` call. The managed server passes its own reader. */
const hostKey = createContextKey<Context | null>(null, {
  description: "go-like host Context"
})

/** Canonical upper-case gRPC status name for one Connect code. */
function statusName(code: Code): string {
  return Code[code].replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()
}

/**
 * OTel gRPC server-fault codes. Caller faults stay UNSET; these end the span in error.
 * `Canceled` is not in the set: it is the cancellation sentinel instead.
 */
const serverFaults: ReadonlySet<Code> = new Set([
  Code.Unknown,
  Code.DeadlineExceeded,
  Code.Unimplemented,
  Code.Internal,
  Code.Unavailable,
  Code.DataLoss
])

/** Maps a thrown call failure onto the client unit result. The original value stays the unit error. */
function clientFailure(value: unknown): UnitResult {
  return { error: value, rpcStatusCode: statusName(ConnectError.from(value).code) }
}

/**
 * Maps a server failure onto D18 status names.
 * Caller faults are the Connect codes outside the server-fault set. A plain Error is `UNKNOWN`.
 * `Code.Canceled` and the core cancellation sentinel both end as `CANCELED`.
 */
function serverFailure(value: unknown): UnitResult {
  if (value === canceled || ConnectError.from(value).code === Code.Canceled) {
    return { error: canceled, rpcStatusCode: "CANCELED" }
  }
  const error = ConnectError.from(value)
  return {
    error: value,
    rpcStatusCode: statusName(error.code),
    callerFault: !serverFaults.has(error.code)
  }
}

/** How one streamed response finishes. The client omits server cancel metadata. */
interface StreamFinish {
  readonly fail: (value: unknown) => UnitResult
  readonly signal?: AbortSignal
  readonly cancelCode: string | null
}

const clientStream: StreamFinish = Object.freeze({
  fail: clientFailure,
  cancelCode: null
})

/** Ends a server stream as canceled when the request signal already aborted. */
function serverCanceled(finish: StreamFinish): boolean {
  return finish.cancelCode !== null && finish.signal?.aborted === true
}

/**
 * Counts streamed messages and runs every pull inside the unit.
 * The first `end` wins: completion and failure run before the cancellation `end` in `finally`.
 */
/** Records a canceled server stream. Later `end` calls do nothing. */
function endServerStream(unit: UnitScope, messages: number, startedAt: number): void {
  unit.end({
    ...serverFailure(canceled),
    stream: {
      messages,
      handshakeMs: Math.max(0, performance.now() - startedAt),
      status: "canceled",
      code: "CANCELED"
    }
  })
}

async function* inUnit<T>(
  unit: UnitScope,
  source: AsyncIterable<T>,
  startedAt: number,
  finish: StreamFinish
): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]()
  let messages = 0
  const endOnAbort = (): void => {
    endServerStream(unit, messages, startedAt)
  }
  if (finish.cancelCode !== null && finish.signal !== undefined) {
    if (finish.signal.aborted) endOnAbort()
    else finish.signal.addEventListener("abort", endOnAbort, { once: true })
  }
  try {
    for (;;) {
      const next = await unit.run(() => iterator.next())
      if (next.done === true) break
      messages += 1
      yield next.value
    }
    if (serverCanceled(finish)) endOnAbort()
    else {
      unit.end({
        rpcStatusCode: "OK",
        stream: { messages, handshakeMs: 0, status: "success", code: null }
      })
    }
  } catch (value) {
    const result = serverCanceled(finish) ? serverFailure(canceled) : finish.fail(value)
    const canceledStream = finish.cancelCode !== null && result.rpcStatusCode === "CANCELED"
    unit.end({
      ...result,
      stream: {
        messages,
        handshakeMs: 0,
        status: canceledStream ? "canceled" : "error",
        code: result.rpcStatusCode ?? null
      }
    })
    throw value
  } finally {
    finish.signal?.removeEventListener("abort", endOnAbort)
    if (finish.cancelCode === null) {
      unit.end({
        stream: {
          messages,
          handshakeMs: performance.now() - startedAt,
          status: "canceled",
          code: null
        }
      })
    } else endOnAbort()
    await iterator.return?.()
  }
}

/**
 * Context values that carry the host Context into the portable server interceptor.
 * An absent host uses `background()` inside the interceptor.
 */
export function hostContextValues(ctx: Context): ContextValues {
  return createContextValues().set(hostKey, ctx)
}

/**
 * One `rpc.server` unit per call. The span name is `{service}/{method}`.
 * The carrier is always the request headers, so an empty or malformed `traceparent`
 * does not keep a span that was already on the host Context.
 * The handler runs inside the unit, and `fromHandlerContext` can read that Context.
 */
export function serverInterceptor(
  system: "connectrpc" | "grpc",
  host?: () => Context
): Interceptor {
  return (next) => async (req) => {
    const ctx = host !== undefined ? host() : (req.contextValues.get(hostKey) ?? background())
    const unit = beginUnit(
      ctx,
      {
        kind: "rpc.server",
        system,
        method: `${req.service.typeName}/${req.method.name}`,
        stream: req.method.methodKind !== "unary"
      },
      req.header
    )
    req.contextValues.set(likeContextKey, unit.ctx)
    const startedAt = performance.now()
    try {
      const res: UnaryResponse | StreamResponse = await unit.run(() => next(req))
      if (!res.stream) {
        unit.end(req.signal.aborted ? serverFailure(canceled) : { rpcStatusCode: "OK" })
        return res
      }
      return {
        ...res,
        message: inUnit(unit, res.message, startedAt, {
          fail: serverFailure,
          signal: req.signal,
          cancelCode: "CANCELED"
        })
      }
    } catch (value) {
      unit.end(serverFailure(req.signal.aborted ? canceled : value))
      throw value
    }
  }
}

/**
 * Client interceptor for an application-built Connect transport
 * (`createConnectTransport` / `createGrpcWebTransport`): one `rpc.client` unit per call,
 * and `traceparent` injection into the request headers.
 * The `./node` client uses the same interceptor around instance selection.
 * A call that already carries an `rpc.client` unit is passed through, so adding this
 * interceptor to a `newClient` transport does not open a second span.
 */
export function telemetryInterceptor(system: "connectrpc" | "grpc" = "connectrpc"): Interceptor {
  return (next) => async (req) => {
    if (req.contextValues.get(clientUnitKey)) return await next(req)
    const ctx = req.contextValues.get(likeContextKey)
    if (ctx === null || !observing(ctx)) return await next(req)
    const unit = beginUnit(ctx, {
      kind: "rpc.client",
      system,
      method: `${req.service.typeName}/${req.method.name}`,
      stream: req.method.methodKind !== "unary"
    })
    injectHeaders(unit.ctx, req.header)
    req.contextValues.set(clientUnitKey, true)
    req.contextValues.set(likeContextKey, unit.ctx)
    const startedAt = performance.now()
    try {
      const res: UnaryResponse | StreamResponse = await unit.run(() => next(req))
      if (!res.stream) {
        unit.end({ rpcStatusCode: "OK" })
        return res
      }
      return { ...res, message: inUnit(unit, res.message, startedAt, clientStream) }
    } catch (value) {
      unit.end(clientFailure(value))
      throw value
    } finally {
      req.contextValues.set(likeContextKey, ctx)
      req.contextValues.delete(clientUnitKey)
    }
  }
}
