import { canceled, deadlineExceeded, type Context } from "@go-like/context"
import { type Client, type DialOptions, type Options } from "@go-like/transport"
import {
  newTransportClosedError,
  newTransportProtocolError,
  type TransportClosedError
} from "@go-like/transport/provider"

import type { HTTPDialTarget } from "./address"
import { limitResponse, readBoundedBody } from "./bounded-body"
import { contextError, isError, normalizeHTTPError } from "./errors"
import type { HTTPExecutor } from "./types"

const ManagedHeaders = [
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]

/** Tracks one in-flight Fetch exchange until its body settles or close cancels it. */
interface Inflight {
  readonly controller: AbortController
  response: Response | null
}

/** Intentionally observes a best-effort cleanup rejection. */
function ignoreRejection(): void {}

/** Drops a body timer that was never armed. */
function clearUnusedTimer(): void {}

/** Returns the earliest positive configured response-header timeout. */
function headerTimeout(common: Options, dial: DialOptions): number {
  let earliest = 0
  if (common.timeoutMs > 0) earliest = common.timeoutMs
  if (dial.timeoutMs > 0 && (earliest === 0 || dial.timeoutMs < earliest)) {
    earliest = dial.timeoutMs
  }
  return earliest
}

/** Waits for work while one caller Context remains active. */
function waitForContext<T>(ctx: Context, work: Promise<T>): Promise<T> {
  const initial = contextError(ctx)
  if (initial !== null) return Promise.reject(initial)
  const signal = ctx.done()
  if (signal === null) return work
  const activeSignal = signal
  return new Promise<T>(function wait(resolve, reject): void {
    let settled = false
    /** Removes the caller cancellation observer. */
    function cleanup(): void {
      activeSignal.removeEventListener("abort", onAbort)
    }
    /** Rejects with the exact Context error. */
    function onAbort(): void {
      if (settled) return
      settled = true
      cleanup()
      reject(contextError(ctx) ?? canceled)
    }
    activeSignal.addEventListener("abort", onAbort, { once: true })
    work.then(
      function resolveWork(value): void {
        if (settled) return
        settled = true
        cleanup()
        resolve(value)
      },
      function rejectWork(error: unknown): void {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
    )
    if (contextError(ctx) !== null) onAbort()
  })
}

/** Settles with the executor result, or with the exchange abort if that happens first. */
function waitForExecutor(work: Promise<Response>, signal: AbortSignal): Promise<Response> {
  if (signal.aborted) {
    const reason: unknown = signal.reason
    return Promise.reject(isError(reason) ? reason : canceled)
  }
  return new Promise<Response>(function race(resolve, reject): void {
    let settled = false
    /** Keeps one of the two completions. */
    function finish(settle: () => void): void {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", onAbort)
      settle()
    }
    /** Rejects header admission with the stored abort reason. */
    function onAbort(): void {
      const reason: unknown = signal.reason
      finish(function rejectAbort(): void {
        reject(isError(reason) ? reason : canceled)
      })
    }
    signal.addEventListener("abort", onAbort, { once: true })
    work.then(
      function resolveWork(response): void {
        finish(function resolveResponse(): void {
          resolve(response)
        })
      },
      function rejectWork(error: unknown): void {
        finish(function rejectResponse(): void {
          reject(error)
        })
      }
    )
  })
}

/** Aborts one exchange with an Error reason. */
function abortInflight(entry: Inflight, error: Error): Error | null {
  try {
    if (!entry.controller.signal.aborted) entry.controller.abort(error)
    return null
  } catch (abortError) {
    return normalizeHTTPError(abortError, "HTTP request abort threw")
  }
}

/** Returns the abort reason already stored on an exchange, when one exists. */
function abortedError(entry: Inflight): Error | null {
  if (!entry.controller.signal.aborted) return null
  const reason: unknown = entry.controller.signal.reason
  return isError(reason) ? reason : canceled
}

/** Cancels one response body and converts synchronous boundary failures into a Promise. */
function cancelResponseBody(
  response: Response | null,
  invoking: { current: number }
): Promise<void> {
  try {
    const body = response?.body
    if (body === null || body === undefined) return Promise.resolve()
    const cancel = body.cancel
    invoking.current += 1
    let returned: Promise<void>
    try {
      returned = cancel.call(body)
    } finally {
      invoking.current -= 1
    }
    return Promise.resolve(returned)
  } catch (error) {
    return Promise.reject(normalizeHTTPError(error, "HTTP response cleanup threw"))
  }
}

/** Builds one same-origin manual-redirect Request with a replayable body. */
function outboundRequest(request: Request, body: Uint8Array | null, signal: AbortSignal): Request {
  const headers = new Headers(request.headers)
  for (const name of ManagedHeaders) headers.delete(name)
  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: "manual",
    signal
  }
  if (body !== null) init.body = body as Uint8Array<ArrayBuffer>
  try {
    return new Request(request.url, init)
  } catch (error) {
    throw error instanceof Error
      ? newTransportProtocolError("invalid HTTP Fetch request", error)
      : newTransportProtocolError("invalid HTTP Fetch request")
  }
}

/** Creates one standard Fetch-backed HTTP client. */
export function newHTTPClient(
  target: HTTPDialTarget,
  executor: HTTPExecutor,
  closeExecutor: () => Promise<void>,
  common: Options,
  dial: DialOptions,
  maxMessageBytes: number,
  executeBuffered?: (request: Request, body: Uint8Array | null) => Promise<Response>
): Client {
  const inflight = new Set<Inflight>()
  const closedError: TransportClosedError = newTransportClosedError("HTTP client is closed")
  const invokingBodyCancel = { current: 0 }
  let closed = false
  let cleanup: Promise<void> | null = null
  let admission: Promise<void> | null = null

  /** Logs one body-cleanup failure without failing owner close. */
  async function settleCleanup(work: Promise<void>): Promise<void> {
    try {
      await work
    } catch (error) {
      common.logger?.log(
        "error",
        "HTTP client response cleanup failed",
        Object.freeze({
          cause: normalizeHTTPError(error, "HTTP response cleanup rejected")
        })
      )
    }
  }

  /** Cancels one owned response after headers when the caller Context ends. */
  function bindCaller(ctx: Context, response: Response, entry: Inflight): () => void {
    const signal = ctx.done()
    /** Detaches a caller listener that was never installed. */
    function unbindDetached(): void {}
    /** Cancels the unread body with the caller Context error. */
    function onAbort(): void {
      if (entry.response !== response) return
      abortInflight(entry, contextError(ctx) ?? canceled)
    }
    if (signal === null) return unbindDetached
    if (signal.aborted) {
      onAbort()
      return unbindDetached
    }
    signal.addEventListener("abort", onAbort, { once: true })
    return function unbindCaller(): void {
      signal.removeEventListener("abort", onAbort)
    }
  }

  /** Arms the common timeout against a body that outlives response headers. */
  function armBodyTimeout(
    elapsedMs: number,
    onDone: () => void,
    abortBody: (error: Error) => void
  ): () => void {
    if (common.timeoutMs <= 0) return clearUnusedTimer
    const remaining = common.timeoutMs - elapsedMs
    if (remaining <= 0) {
      abortBody(deadlineExceeded)
      return clearUnusedTimer
    }
    const timer = setTimeout(function expireBody(): void {
      abortBody(deadlineExceeded)
    }, remaining)
    return function clearBodyTimeout(): void {
      clearTimeout(timer)
      onDone()
    }
  }

  const client: Client = Object.freeze({
    /** Sends one Request and returns its Response without consuming the body. */
    async fetch(ctx: Context, request: Request): Promise<Response> {
      const failure = contextError(ctx)
      if (failure !== null) throw failure
      if (closed) throw closedError
      if (!(request instanceof Request)) {
        throw new TypeError("HTTP client fetch requires a Request")
      }
      let origin: string
      try {
        origin = new URL(request.url).origin
      } catch (error) {
        throw newTransportProtocolError(
          "invalid HTTP Fetch request",
          error instanceof Error ? error : undefined
        )
      }
      if (origin !== target.origin) {
        throw new TypeError("HTTP request must remain on its dial origin")
      }
      const started = Date.now()
      const entry: Inflight = { controller: new AbortController(), response: null }
      inflight.add(entry)
      const signal = ctx.done()
      /** Aborts this exchange. The body reader observes the same signal. */
      function abortRead(error: Error): void {
        abortInflight(entry, error)
      }
      /** Aborts header admission with the caller Context error. */
      function onContextAbort(): void {
        abortRead(contextError(ctx) ?? canceled)
      }
      /** Aborts header admission when the caller's Request aborts. */
      function onRequestAbort(): void {
        const reason: unknown = request.signal.reason
        abortRead(isError(reason) ? reason : canceled)
      }
      signal?.addEventListener("abort", onContextAbort, { once: true })
      if (request.signal.aborted) onRequestAbort()
      else request.signal.addEventListener("abort", onRequestAbort, { once: true })
      const timeoutMs = headerTimeout(common, dial)
      let timer: ReturnType<typeof setTimeout> | null = null
      if (timeoutMs > 0) {
        timer = setTimeout(function expireHeaders(): void {
          abortRead(deadlineExceeded)
        }, timeoutMs)
      }
      let execution: Promise<Response> | null = null
      let handedOff = false
      /** Cancels a response that arrives after header admission has already failed. */
      function abandonExecution(): void {
        if (execution === null) return
        void execution.then(function late(response): void {
          if (response instanceof Response) {
            void cancelResponseBody(response, invokingBodyCancel).catch(ignoreRejection)
          }
        }, ignoreRejection)
      }
      try {
        const body = await readBoundedBody(
          request.body,
          request.headers,
          maxMessageBytes,
          "HTTP request Content-Length is invalid or exceeds maxMessageBytes",
          "HTTP request body exceeds maxMessageBytes",
          entry.controller.signal
        )
        if (closed) throw closedError
        const later = contextError(ctx)
        if (later !== null) throw later
        const abortedDuringRead = abortedError(entry)
        if (abortedDuringRead !== null) {
          await waitForExecutor(Promise.resolve(new Response(null)), entry.controller.signal)
        }
        const method = request.method.toUpperCase()
        if (
          executeBuffered !== undefined &&
          !((method === "GET" || method === "HEAD") && body !== null)
        ) {
          const metadata = outboundRequest(request, null, entry.controller.signal)
          try {
            execution = Promise.resolve(executeBuffered(metadata, body))
          } catch (error) {
            execution = Promise.reject(error)
          }
        } else {
          const outbound = outboundRequest(request, body, entry.controller.signal)
          try {
            execution = Promise.resolve(executor(outbound))
          } catch (error) {
            execution = Promise.reject(error)
          }
        }
        const response = await waitForExecutor(execution, entry.controller.signal)
        const aborted = abortedError(entry)
        if (aborted !== null) {
          if (response instanceof Response) {
            void cancelResponseBody(response, invokingBodyCancel).catch(ignoreRejection)
          }
          throw aborted
        }
        if (closed) {
          if (response instanceof Response) {
            void cancelResponseBody(response, invokingBodyCancel).catch(ignoreRejection)
          }
          throw closedError
        }
        if (!(response instanceof Response)) {
          throw newTransportProtocolError("HTTP executor must return Response")
        }
        let clearBodyTimer = clearUnusedTimer
        let unbindBodyCaller = function unbindUnused(): void {}
        let settledEarly = false
        /** Drops the Request abort bridge once the body no longer needs it. */
        function releaseRequestAbort(): void {
          request.signal.removeEventListener("abort", onRequestAbort)
        }
        const guarded = limitResponse(
          response,
          maxMessageBytes,
          function finished(): void {
            settledEarly = true
            unbindBodyCaller()
            releaseRequestAbort()
            inflight.delete(entry)
            entry.response = null
            clearBodyTimer()
          },
          entry.controller.signal
        )
        entry.response = guarded
        if (guarded.body !== null) {
          clearBodyTimer = armBodyTimeout(
            Date.now() - started,
            function release(): void {
              inflight.delete(entry)
            },
            function abortBody(error: Error): void {
              abortInflight(entry, error)
            }
          )
        }
        if (common.timeoutMs > 0 && Date.now() - started >= common.timeoutMs) {
          throw deadlineExceeded
        }
        if (!settledEarly && guarded.body !== null) {
          handedOff = true
          unbindBodyCaller = bindCaller(ctx, guarded, entry)
        }
        return guarded
      } catch (error) {
        inflight.delete(entry)
        abandonExecution()
        const aborted = abortedError(entry)
        if (aborted !== null) throw aborted
        if (closed && error === closedError) throw error
        throw error instanceof Error ? error : normalizeHTTPError(error, "HTTP executor rejected")
      } finally {
        if (timer !== null) clearTimeout(timer)
        signal?.removeEventListener("abort", onContextAbort)
        if (!handedOff) request.signal.removeEventListener("abort", onRequestAbort)
      }
    },
    /** Starts one idempotent owner cleanup and lets ctx bound only this caller's wait. */
    close(ctx: Context): Promise<void> {
      const failure = contextError(ctx)
      if (failure !== null) return Promise.reject(failure)
      const reentered = invokingBodyCancel.current > 0
      if (cleanup !== null) {
        const pending = reentered && admission !== null ? admission : cleanup
        return waitForContext(ctx, pending)
      }
      let resolveCleanup: (() => void) | null = null
      let rejectCleanup: ((error: Error) => void) | null = null
      const owner = new Promise<void>(function capture(resolve, reject): void {
        resolveCleanup = resolve
        rejectCleanup = reject
      })
      cleanup = owner
      admission = Promise.resolve()
      closed = true
      let abortFailure: Error | null = null
      const joining: Promise<void>[] = []
      for (const entry of Array.from(inflight)) {
        inflight.delete(entry)
        // Cancel before abort. Abort's body listener finishes the exchange and drops
        // entry.response, which would skip this cleanup and swallow cancel rejection.
        const response = entry.response
        if (response !== null) {
          joining.push(settleCleanup(cancelResponseBody(response, invokingBodyCancel)))
        }
        const failureFromAbort = abortInflight(entry, closedError)
        if (abortFailure === null && failureFromAbort !== null) abortFailure = failureFromAbort
      }
      let closeOwner: Promise<void>
      try {
        closeOwner = Promise.resolve(closeExecutor())
      } catch (error) {
        closeOwner = Promise.reject(normalizeHTTPError(error, "HTTP executor close threw"))
      }
      void Promise.all([Promise.all(joining), closeOwner]).then(
        function cleanupJoined(): void {
          if (abortFailure === null) resolveCleanup?.()
          else rejectCleanup?.(abortFailure)
        },
        function cleanupFailed(error: unknown): void {
          rejectCleanup?.(normalizeHTTPError(error, "HTTP executor close rejected"))
        }
      )
      return waitForContext(ctx, reentered ? admission : owner)
    }
  })
  return client
}
