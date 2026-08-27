import {
  canceled,
  deadlineExceeded,
  withTimeout as withContextTimeout,
  type Context
} from "@go-like/context"
import { type Client, type DialOptions, type Message, type Options } from "@go-like/transport"
import {
  newTransportClosedError,
  newTransportProtocolError,
  newTransportStateError,
  snapshotMessage,
  type TransportClosedError
} from "@go-like/transport/provider"
import type { HTTPDialTarget } from "./address"
import {
  assertHTTPContentLength,
  boundedHTTPBodyLength,
  contextError,
  newHTTPStatusError,
  normalizeHTTPError,
  readerCancellation,
  snapshotHTTPBodyChunk,
  type HTTPReaderCancellation
} from "./errors"
import { requestHeaders, snapshotResponseHeaders } from "./headers"
import type { HTTPExecutor } from "./types"

/** Holds one provisional request-response FIFO slot. */
interface HTTPClientSlot {
  readonly response: Promise<Response>
  readonly controller: AbortController
  /** Resolves this slot with transferred Response ownership. */
  readonly resolve: (response: Response) => void
  /** Rejects this slot with its canonical Error identity. */
  readonly reject: (error: Error) => void
  claimed: boolean
  settled: boolean
  removed: boolean
  forcedError: Error | null
  ownedResponse: Response | null
  cancelBody: HTTPReaderCancellation | null
  cancelInvoking: ((active: boolean) => void) | null
  cancelHeaders: ((error: Error) => void) | null
  cleanup: Promise<void> | null
}

/** Controls one identity-stable cleanup Promise before borrowed code can reenter. */
interface CleanupSettlement {
  readonly promise: Promise<void>
  /** Resolves the cleanup sentinel. */
  readonly resolve: () => void
  /** Rejects the cleanup sentinel. */
  readonly reject: (error: Error) => void
}

/** Intentionally observes a best-effort cleanup rejection. */
function ignoreRejection(): void {}

/** Creates one externally settled cleanup Promise for reentrant owner admission. */
function cleanupSettlement(): CleanupSettlement {
  let resolvePromise: (() => void) | null = null
  let rejectPromise: ((error: Error) => void) | null = null
  const promise = new Promise<void>(function capture(resolve, reject): void {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return Object.freeze({
    promise,
    /** Resolves the cleanup Promise exactly once. */
    resolve(): void {
      resolvePromise?.()
    },
    /** Rejects the cleanup Promise exactly once. */
    reject(error: Error): void {
      rejectPromise?.(error)
    }
  })
}

/** Cancels one standard response body and converts every synchronous boundary into a Promise. */
function cancelOwnedResponseBody(
  response: Response | null,
  invoke:
    | ((
        body: ReadableStream<Uint8Array>,
        cancel: ReadableStream<Uint8Array>["cancel"]
      ) => Promise<void>)
    | null = null
): Promise<void> {
  try {
    const body = response?.body
    if (body === null || body === undefined) return Promise.resolve()
    const cancel = body.cancel
    return invoke === null
      ? Promise.resolve(cancel.call(body))
      : Promise.resolve(invoke(body, cancel))
  } catch (error) {
    return Promise.reject(normalizeHTTPError(error, "HTTP response cleanup threw"))
  }
}

/** Starts late Response cleanup without throwing or publishing an unhandled rejection. */
function cancelResponseBodyBestEffort(response: Response): void {
  void cancelOwnedResponseBody(response).catch(ignoreRejection)
}

/** Creates a Promise-backed provisional slot without exposing its settlement functions. */
function newSlot(): HTTPClientSlot {
  let resolveResponse: ((response: Response) => void) | null = null
  let rejectResponse: ((error: Error) => void) | null = null
  const response = new Promise<Response>(function capture(resolve, reject): void {
    resolveResponse = resolve
    rejectResponse = reject
  })
  void response.catch(ignoreRejection)
  const slot: HTTPClientSlot = {
    response,
    controller: new AbortController(),
    /** Resolves the slot once and records transferred Response ownership. */
    resolve(value: Response): void {
      slot.settled = true
      slot.ownedResponse = value
      resolveResponse?.(value)
    },
    /** Rejects the slot once with one normalized Error identity. */
    reject(error: Error): void {
      if (slot.settled) return
      slot.settled = true
      rejectResponse?.(error)
    },
    claimed: false,
    settled: false,
    removed: false,
    forcedError: null,
    ownedResponse: null,
    cancelBody: null,
    cancelInvoking: null,
    cancelHeaders: null,
    cleanup: null
  }
  return slot
}

/** Transfers one reader cancellation observer without retaining a released slot owner. */
function setSlotBodyCancellation(
  slot: HTTPClientSlot,
  cancellation: HTTPReaderCancellation | null
): void {
  slot.cancelBody?.observeInvoking(null)
  slot.cancelBody = cancellation
  cancellation?.observeInvoking(slot.cancelInvoking)
}

/** Waits for work while one caller Context remains active. */
function waitForContext<T>(
  ctx: Context,
  work: Promise<T>,
  cancelWork: ((error: Error) => void) | null
): Promise<T> {
  const initial = contextError(ctx)
  if (initial !== null) {
    cancelWork?.(initial)
    return Promise.reject(initial)
  }
  const signal = ctx.done()
  if (signal === null) return work
  const activeSignal = signal
  return new Promise<T>(function wait(resolve, reject): void {
    let settled = false
    /** Removes the caller cancellation observer. */
    function cleanup(): void {
      activeSignal.removeEventListener("abort", onAbort)
    }
    /** Rejects with the exact Context error and optionally cancels owned work. */
    function onAbort(): void {
      if (settled) return
      settled = true
      cleanup()
      const failure = contextError(ctx) ?? canceled
      cancelWork?.(failure)
      reject(failure)
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

/** Returns the earliest positive configured response-header timeout. */
function headerTimeout(common: Options, dial: DialOptions): number {
  let earliest = 0
  if (common.timeoutMs > 0) earliest = common.timeoutMs
  if (dial.timeoutMs > 0 && (earliest === 0 || dial.timeoutMs < earliest)) {
    earliest = dial.timeoutMs
  }
  return earliest
}

/** Converts a defensive Message snapshot into one standard POST Request. */
function requestForSlot(
  target: HTTPDialTarget,
  slot: HTTPClientSlot,
  message: Message,
  maxMessageBytes: number
): Request {
  const prepared = requestHeaders(message)
  const body = prepared.message.body
  boundedHTTPBodyLength(
    0,
    body.byteLength,
    maxMessageBytes,
    "HTTP request body exceeds maxMessageBytes"
  )
  const detached = new ArrayBuffer(body.byteLength)
  new Uint8Array(detached).set(body)
  try {
    return new Request(
      target.href,
      Object.freeze({
        method: "POST",
        headers: prepared.headers,
        body: detached,
        redirect: "manual",
        signal: slot.controller.signal
      })
    )
  } catch (error) {
    throw error instanceof Error
      ? newTransportProtocolError("invalid HTTP Fetch request", error)
      : newTransportProtocolError("invalid HTTP Fetch request")
  }
}

/** Invokes one executor until headers, cancellation, close, or timeout wins. */
async function executeHeaders(
  ctx: Context,
  executor: HTTPExecutor,
  request: Request,
  slot: HTTPClientSlot,
  timeoutMs: number,
  cancelSlot: (error: Error) => Promise<void>
): Promise<Response> {
  const initial = contextError(ctx)
  if (initial !== null) throw initial
  if (slot.forcedError !== null) throw slot.forcedError
  let timer: ReturnType<typeof setTimeout> | null = null
  const signal = ctx.done()
  let rejectBoundary: ((error: Error) => void) | null = null
  const boundary = new Promise<Response>(function capture(_resolve, reject): void {
    rejectBoundary = reject
  })
  /** Rejects the boundary once with the slot's canonical forced Error. */
  function cancelWith(error: Error): void {
    if (slot.forcedError === null) slot.forcedError = error
    void cancelSlot(slot.forcedError).catch(ignoreRejection)
    rejectBoundary?.(slot.forcedError)
  }
  /** Propagates the exact send Context error. */
  function onContextAbort(): void {
    cancelWith(contextError(ctx) ?? canceled)
  }
  /** Rejects header admission when client-wide or recv cleanup owns the slot. */
  function rejectHeaders(error: Error): void {
    rejectBoundary?.(error)
  }
  slot.cancelHeaders = rejectHeaders
  signal?.addEventListener("abort", onContextAbort, { once: true })
  if (timeoutMs > 0)
    timer = setTimeout(function expire(): void {
      cancelWith(deadlineExceeded)
    }, timeoutMs)
  let execution: Promise<Response>
  try {
    execution = Promise.resolve(executor(request))
  } catch (error) {
    execution = Promise.reject(error)
  }
  void execution.then(
    function cancelLateResponse(response): void {
      if (slot.forcedError !== null && response instanceof Response) {
        cancelResponseBodyBestEffort(response)
      }
    },
    function observeExecutorFailure(): void {}
  )
  try {
    const response = await Promise.race([execution, boundary])
    if (!(response instanceof Response))
      throw newTransportProtocolError("HTTP executor must return Response")
    return response
  } finally {
    if (timer !== null) clearTimeout(timer)
    signal?.removeEventListener("abort", onContextAbort)
    if (slot.cancelHeaders === rejectHeaders) slot.cancelHeaders = null
  }
}

/** Copies one successful Response into an immutable transport Message. */
async function receiveMessage(
  response: Response,
  slot: HTTPClientSlot,
  maxMessageBytes: number
): Promise<Message> {
  if (response.status !== 200) {
    throw await newHTTPStatusError(response, function register(cancel): void {
      setSlotBodyCancellation(slot, cancel)
    })
  }
  const chunks: Uint8Array[] = []
  let length = 0
  if (response.body === null) {
    assertHTTPContentLength(
      response.headers,
      maxMessageBytes,
      "HTTP response Content-Length is invalid or exceeds maxMessageBytes"
    )
  } else {
    const reader = response.body.getReader()
    const cancellation = readerCancellation(reader)
    setSlotBodyCancellation(slot, cancellation)
    try {
      try {
        assertHTTPContentLength(
          response.headers,
          maxMessageBytes,
          "HTTP response Content-Length is invalid or exceeds maxMessageBytes"
        )
        while (true) {
          let result: unknown
          try {
            result = await reader.read()
          } catch (error) {
            throw newTransportProtocolError(
              "invalid HTTP response body",
              error instanceof Error ? error : undefined
            )
          }
          const chunk = snapshotHTTPBodyChunk(result, "invalid HTTP response body")
          if (chunk === null) break
          length = boundedHTTPBodyLength(
            length,
            chunk.byteLength,
            maxMessageBytes,
            "HTTP response body exceeds maxMessageBytes"
          )
          chunks.push(chunk)
        }
      } catch (error) {
        try {
          await cancellation.cancel()
        } catch {
          // The protocol failure remains primary over best-effort oversized-body cleanup.
        }
        throw error
      }
    } finally {
      setSlotBodyCancellation(slot, null)
      reader.releaseLock()
    }
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return snapshotMessage(
    Object.freeze({
      header: snapshotResponseHeaders(response.headers),
      body: bytes
    })
  )
}

/** Creates one standard Fetch-backed unary HTTP client. */
export function newHTTPClient(
  target: HTTPDialTarget,
  executor: HTTPExecutor,
  closeExecutor: () => Promise<void>,
  common: Options,
  dial: DialOptions,
  maxMessageBytes: number
): Client {
  const pending: HTTPClientSlot[] = []
  const owned = new Set<HTTPClientSlot>()
  const activeCleanups = new Set<Promise<void>>()
  const closedError: TransportClosedError = newTransportClosedError("HTTP client is closed")
  let closed = false
  let activeRecv = false
  let sendTail: Promise<void> = Promise.resolve()
  let cleanup: Promise<void> | null = null
  let cleanupAdmission: Promise<void> | null = null
  let invokingUnreadBodyCancel = 0
  let invokingReaderBodyCancel = 0

  /** Reports whether this synchronous close call came from owned body cancellation. */
  function bodyCancellationReentered(): boolean {
    if (invokingUnreadBodyCancel > 0 || invokingReaderBodyCancel > 0) return true
    return false
  }

  /** Invokes one unread body cancel while exposing only its direct borrowed-call window. */
  function cancelUnreadResponseBody(response: Response | null): Promise<void> {
    return cancelOwnedResponseBody(response, function invoke(body, cancel): Promise<void> {
      let returned: Promise<void>
      invokingUnreadBodyCancel += 1
      try {
        returned = cancel.call(body)
      } finally {
        invokingUnreadBodyCancel -= 1
      }
      return Promise.resolve(returned)
    })
  }

  /** Removes one slot from every client-owned collection once. */
  function remove(slot: HTTPClientSlot): void {
    if (slot.removed) return
    slot.removed = true
    owned.delete(slot)
    const index = pending.indexOf(slot)
    if (index >= 0) pending.splice(index, 1)
  }

  /** Canonically cancels one slot and releases any owned response body. */
  function cancelSlot(slot: HTTPClientSlot, error: Error): Promise<void> {
    if (slot.cleanup !== null) return slot.cleanup
    const settlement = cleanupSettlement()
    const sentinel = settlement.promise
    slot.cleanup = sentinel
    activeCleanups.add(sentinel)
    sentinel.then(
      function cleanupResolved(): void {
        activeCleanups.delete(sentinel)
      },
      function cleanupRejected(): void {
        activeCleanups.delete(sentinel)
      }
    )
    void sentinel.catch(ignoreRejection)
    if (slot.forcedError === null) slot.forcedError = error
    slot.reject(slot.forcedError)
    remove(slot)
    slot.cancelHeaders?.(slot.forcedError)
    let abortFailure: Error | null = null
    try {
      if (!slot.controller.signal.aborted) slot.controller.abort(slot.forcedError)
    } catch (abortError) {
      abortFailure = normalizeHTTPError(abortError, "HTTP request abort threw")
    }
    let bodyCleanup: Promise<void>
    if (slot.cancelBody === null) {
      bodyCleanup = cancelUnreadResponseBody(slot.ownedResponse)
    } else {
      const cancelBody = slot.cancelBody
      bodyCleanup = cancelBody.cancel()
    }
    bodyCleanup.then(
      function bodyCleanupResolved(): void {
        if (abortFailure === null) settlement.resolve()
        else settlement.reject(abortFailure)
      },
      function bodyCleanupRejected(bodyError: unknown): void {
        settlement.reject(normalizeHTTPError(bodyError, "HTTP response cleanup rejected"))
      }
    )
    return sentinel
  }

  /** Waits for one cleanup without letting diagnostic failure end owner joining early. */
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

  /** Executes one queued send and transfers Response ownership into its slot. */
  async function executeSend(ctx: Context, request: Request, slot: HTTPClientSlot): Promise<void> {
    if (closed) {
      cancelSlot(slot, closedError)
      throw closedError
    }
    const failure = contextError(ctx)
    if (failure !== null) {
      cancelSlot(slot, failure)
      throw failure
    }
    try {
      const response = await executeHeaders(
        ctx,
        executor,
        request,
        slot,
        headerTimeout(common, dial),
        function cancelHeaders(error: Error): Promise<void> {
          return cancelSlot(slot, error)
        }
      )
      if (closed) {
        slot.ownedResponse = response
        cancelSlot(slot, closedError)
        throw closedError
      }
      slot.resolve(response)
    } catch (error) {
      const normalized = slot.forcedError ?? normalizeHTTPError(error, "HTTP executor rejected")
      cancelSlot(slot, normalized)
      throw normalized
    }
  }

  const client: Client = Object.freeze({
    /** Creates one provisional FIFO slot and sends after prior invocations settle. */
    send(ctx: Context, message: Message): Promise<void> {
      const failure = contextError(ctx)
      if (failure !== null) return Promise.reject(failure)
      if (closed) return Promise.reject(closedError)
      const slot = newSlot()
      slot.cancelInvoking = function observeReaderCancellation(active: boolean): void {
        invokingReaderBodyCancel += active ? 1 : -1
      }
      let request: Request
      try {
        request = requestForSlot(target, slot, message, maxMessageBytes)
      } catch (error) {
        return Promise.reject(error)
      }
      pending.push(slot)
      owned.add(slot)
      const run = sendTail.then(function sendAfterPrior(): Promise<void> {
        return executeSend(ctx, request, slot)
      })
      sendTail = run.then(
        function sent(): void {},
        function recovered(): void {}
      )
      return run
    },
    /** Claims and consumes the earliest prior send slot. */
    async recv(ctx: Context): Promise<Message> {
      const failure = contextError(ctx)
      if (failure !== null) throw failure
      if (closed) throw closedError
      if (activeRecv) throw newTransportStateError("HTTP client already has an active recv")
      const slot = pending.find(function unclaimed(value): boolean {
        return !value.claimed
      })
      if (slot === undefined) throw newTransportStateError("HTTP recv requires a prior send")
      slot.claimed = true
      activeRecv = true
      const timed = common.timeoutMs > 0 ? withContextTimeout(ctx, common.timeoutMs) : null
      const receiveContext = timed === null ? ctx : timed[0]
      const receiving = (async function receiveSlot(): Promise<Message> {
        const response = await waitForContext(
          receiveContext,
          slot.response,
          function cancel(error): void {
            cancelSlot(slot, error)
          }
        )
        const received = await waitForContext(
          receiveContext,
          receiveMessage(response, slot, maxMessageBytes),
          function cancel(error): void {
            cancelSlot(slot, error)
          }
        )
        if (slot.forcedError !== null) throw slot.forcedError
        return received
      })()
      return receiving
        .catch(function preserveForcedError(error: unknown): never {
          if (slot.forcedError !== null) throw slot.forcedError
          throw error
        })
        .finally(function finishReceive(): void {
          timed?.[1]()
          activeRecv = false
          remove(slot)
        })
    },
    /** Starts one idempotent owner cleanup and lets ctx bound only this caller's wait. */
    close(ctx: Context): Promise<void> {
      const failure = contextError(ctx)
      if (failure !== null) return Promise.reject(failure)
      const reenteredBodyCancellation = bodyCancellationReentered()
      if (cleanup !== null) {
        const work =
          reenteredBodyCancellation && cleanupAdmission !== null ? cleanupAdmission : cleanup
        return waitForContext(ctx, work, null)
      }
      const settlement = cleanupSettlement()
      const admission = cleanupSettlement()
      const owner = settlement.promise
      cleanup = owner
      cleanupAdmission = admission.promise
      closed = true
      for (const slot of Array.from(owned)) cancelSlot(slot, closedError)
      const joining: Promise<void>[] = []
      for (const work of Array.from(activeCleanups)) joining.push(settleCleanup(work))
      let closeOwner: Promise<void>
      try {
        closeOwner = Promise.resolve(closeExecutor())
      } catch (error) {
        closeOwner = Promise.reject(normalizeHTTPError(error, "HTTP executor close threw"))
      }
      admission.resolve()
      void Promise.all([Promise.all(joining), closeOwner]).then(
        function cleanupJoined(): void {
          settlement.resolve()
        },
        function cleanupFailed(error: unknown): void {
          settlement.reject(normalizeHTTPError(error, "HTTP executor close rejected"))
        }
      )
      return waitForContext(ctx, reenteredBodyCancellation ? admission.promise : owner, null)
    },
    /** Reports that standard Fetch cannot expose a local socket address. */
    local(): string {
      return ""
    },
    /** Returns the normalized target origin without inventing socket metadata. */
    remote(): string {
      return target.origin
    }
  })
  return client
}
