import { withValue, type Context } from "@go-like/context"

/** Describes why a Response body reached a terminal state. */
export type ResponseBodyEndReason = "end" | "error" | "cancel"

/** Classifies the RPC outcome observed on a terminal body. */
export type ResponseBodyStatus =
  | { readonly kind: "success" }
  | { readonly kind: "canceled" }
  | { readonly kind: "truncated" }
  | { readonly kind: "error"; readonly code: string; readonly status: number }

/** Describes the first terminal Response body event. */
export interface ResponseBodyEnd {
  readonly reason: ResponseBodyEndReason
  readonly cause: unknown
  readonly durationMs: number
  readonly handshakeMs: number
  readonly messageCount: number
  readonly httpStatus: number
  readonly stream: boolean
  readonly status: ResponseBodyStatus
}

/** Supplies call-start and header timestamps from performance.now(). */
export interface ObserveResponseBodyOptions {
  readonly startedAt?: number
  readonly headersAt?: number
  /** Aborts the unread source. An upstream abort fails a later read with that reason. */
  readonly signal?: AbortSignal
  /** Cancels the source after a terminal SSE event so a transport body can release its connection. */
  readonly cancelSource?: boolean
}

/** Transforms one Response before its body is consumed. */
export type ResponseObserver = (response: Response) => Response

const responseObservers = Symbol("go-like.response-observers")
const eventStreamContentType = "text/event-stream"

interface EventStats {
  messageCount: number
  terminal: "none" | "end" | "error"
  errorCode: string | null
  errorStatus: number | null
}

/** Returns a Response that reports the first terminal body event once. */
export function observeResponseBody(
  response: Response,
  onEnd: (end: ResponseBodyEnd) => void,
  options: ObserveResponseBodyOptions = {}
): Response {
  if (!(response instanceof Response)) {
    throw new TypeError("observeResponseBody requires a Response")
  }
  if (typeof onEnd !== "function") {
    throw new TypeError("observeResponseBody callback must be a function")
  }
  const startedAt = finiteEpoch(options.startedAt, "startedAt") ?? performance.now()
  const headersAt = finiteEpoch(options.headersAt, "headersAt") ?? startedAt
  const cancelSource = options.cancelSource === true
  const streaming = mediaType(response.headers.get("content-type")) === eventStreamContentType
  const stats = createEventStats()
  let reported = false
  let consumerCanceled = false
  let terminalReason: ResponseBodyEndReason | null = null
  let terminalCause: unknown = null
  let detachSignal = function detachUnused(): void {}
  /** Publishes the first terminal event and ignores observer failures. */
  function report(reason: ResponseBodyEndReason, bodyCause: unknown): void {
    if (reported) return
    reported = true
    terminalReason = reason
    terminalCause = bodyCause
    detachSignal()
    if (streaming) stats.finish()
    try {
      onEnd(
        Object.freeze({
          reason,
          cause: bodyCause,
          durationMs: Math.max(0, performance.now() - startedAt),
          handshakeMs: Math.max(0, headersAt - startedAt),
          messageCount: stats.messageCount,
          httpStatus: response.status,
          stream: streaming,
          status: classify(reason, streaming, response.status, stats)
        })
      )
    } catch {
      // A failing observer must not replace the body outcome.
    }
  }
  if (response.body === null || response.bodyUsed) {
    report("end", null)
    return response
  }
  const reader = response.body.getReader()
  const external = options.signal
  if (external !== undefined) {
    const signal = external
    /** Cancels the source when the caller aborts after observation has started. */
    function abortFromSignal(): void {
      report("cancel", signal.reason ?? null)
      void reader.cancel(signal.reason).catch(ignoreBodyFailure)
    }
    if (signal.aborted) abortFromSignal()
    else {
      signal.addEventListener("abort", abortFromSignal, { once: true })
      detachSignal = function detachAbort(): void {
        signal.removeEventListener("abort", abortFromSignal)
      }
    }
  }
  /** Ends a pull after a terminal event. Upstream cancel fails the read; consumer cancel does not. */
  function finishPull(controller: ReadableStreamDefaultController<Uint8Array>): void {
    if (consumerCanceled) return
    if (terminalReason === "cancel") {
      controller.error(isError(terminalCause) ? terminalCause : new Error("response body canceled"))
      return
    }
    controller.close()
  }
  const stream = new ReadableStream<Uint8Array>(
    {
      /** Forwards one source read and reports EOF, a terminal SSE event, or a read error. */
      async pull(controller): Promise<void> {
        if (reported) {
          finishPull(controller)
          return
        }
        try {
          const result = await reader.read()
          if (reported) {
            finishPull(controller)
            return
          }
          if (result.done) {
            report("end", null)
            controller.close()
            return
          }
          if (streaming) stats.push(result.value)
          controller.enqueue(result.value)
          if (streaming && stats.terminal !== "none") {
            report(stats.terminal === "error" ? "error" : "end", null)
            if (cancelSource) void reader.cancel().catch(ignoreBodyFailure)
          }
        } catch (error) {
          if (reported) {
            finishPull(controller)
            return
          }
          report("error", error)
          controller.error(error)
        }
      },
      /** Reports consumer cancellation. A finished producer stream stays closeable. */
      cancel(reason): Promise<void> {
        consumerCanceled = true
        if (streaming && stats.terminal !== "none") {
          report(stats.terminal === "error" ? "error" : "end", null)
          if (!cancelSource) return Promise.resolve()
        } else {
          report("cancel", reason)
        }
        return reader.cancel(reason)
      }
    },
    // A positive watermark would pull the source before the consumer and end the body early.
    { highWaterMark: 0 }
  )
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers)
  })
}

/** Swallows a source cancellation that loses a race with an already-closed body. */
function ignoreBodyFailure(): void {}

/** Recognizes standard Error objects across realms with a local fallback. */
function isError(value: unknown): value is Error {
  const candidate: unknown = Object.getOwnPropertyDescriptor(Error, "isError")?.value
  return typeof candidate === "function" ? candidate(value) === true : value instanceof Error
}

/** Attaches one Response observer that runs before the body is read. */
export function withResponseObserver(ctx: Context, observer: ResponseObserver): Context {
  if (!isContext(ctx)) throw new TypeError("withResponseObserver requires a Context")
  if (typeof observer !== "function") throw new TypeError("response observer must be a function")
  const next: ResponseObserver[] = []
  const current = ctx.value(responseObservers)
  if (Array.isArray(current)) {
    for (const item of current) {
      if (typeof item === "function") next.push(item as ResponseObserver)
    }
  }
  next.push(observer)
  return withValue(ctx, responseObservers, Object.freeze(next))
}

/** Runs every observer attached to ctx, nearest ancestor first. */
export function applyResponseObservers(ctx: Context, response: Response): Response {
  if (!isContext(ctx)) throw new TypeError("applyResponseObservers requires a Context")
  if (!(response instanceof Response)) {
    throw new TypeError("applyResponseObservers requires a Response")
  }
  const current = ctx.value(responseObservers)
  if (!Array.isArray(current)) return response
  let wrapped = response
  for (const observer of current) {
    if (typeof observer !== "function") continue
    const next = observer(wrapped)
    if (!(next instanceof Response)) {
      throw new TypeError("response observer must return a Response")
    }
    wrapped = next
  }
  return wrapped
}

/** Reports whether a value can read Context values. */
function isContext(value: unknown): value is Context {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { value?: unknown }).value === "function"
  )
}

/** Accepts one performance.now() timestamp. */
function finiteEpoch(value: number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`observeResponseBody ${field} must be a finite number`)
  }
  return value
}

/** Returns the media type without parameters. */
function mediaType(value: string | null): string {
  return (value ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? ""
}

/** Creates the mutable SSE counters for one observed body. */
function createEventStats(): EventStats & {
  push(chunk: Uint8Array): void
  finish(): void
} {
  const decoder = new TextDecoder()
  let pending = ""
  const stats: EventStats = {
    messageCount: 0,
    terminal: "none",
    errorCode: null,
    errorStatus: null
  }
  /** Consumes every complete event currently buffered. */
  function drain(): void {
    while (pending.length > 0) {
      const lf = pending.indexOf("\n\n")
      const crlf = pending.indexOf("\r\n\r\n")
      let boundary = -1
      let width = 0
      if (lf >= 0 && (crlf < 0 || lf <= crlf)) {
        boundary = lf
        width = 2
      } else if (crlf >= 0) {
        boundary = crlf
        width = 4
      }
      if (boundary < 0) return
      consumeEvent(pending.slice(0, boundary), stats)
      pending = pending.slice(boundary + width)
    }
  }
  return Object.assign(stats, {
    /** Appends one chunk and counts every event it completes. */
    push(chunk: Uint8Array): void {
      pending += decoder.decode(chunk, { stream: true })
      drain()
    },
    /** Flushes the decoder and counts a final complete event. */
    finish(): void {
      pending += decoder.decode()
      drain()
    }
  })
}

/** Updates counters from one SSE event block without its trailing blank line. */
function consumeEvent(block: string, stats: EventStats): void {
  if (stats.terminal !== "none") return
  let event = ""
  const data: string[] = []
  for (const line of block.split(/\r?\n/)) {
    if (line.length === 0 || line.startsWith(":")) continue
    const colon = line.indexOf(":")
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? "" : line.slice(colon + 1)
    if (value.startsWith(" ")) value = value.slice(1)
    if (field === "event") event = value
    else if (field === "data") data.push(value)
  }
  if (data.length === 0) return
  if (event.length === 0) {
    stats.messageCount += 1
    return
  }
  if (event === "end") {
    stats.terminal = "end"
    return
  }
  if (event !== "error") return
  stats.terminal = "error"
  try {
    const parsed: unknown = JSON.parse(data.join("\n"))
    if (typeof parsed === "object" && parsed !== null) {
      const code = Reflect.get(parsed, "code")
      const status = Reflect.get(parsed, "status")
      stats.errorCode = typeof code === "string" && code.length > 0 ? code : "internal"
      stats.errorStatus =
        typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599
          ? status
          : 500
      return
    }
  } catch {
    // Invalid error payloads still terminate the stream as an internal failure.
  }
  stats.errorCode = "internal"
  stats.errorStatus = 500
}

/** Maps the first terminal signal onto the shared stream status. */
function classify(
  reason: ResponseBodyEndReason,
  streaming: boolean,
  httpStatus: number,
  stats: EventStats
): ResponseBodyStatus {
  const sawTerminal = streaming && stats.terminal !== "none"
  if (reason === "cancel" && !sawTerminal) return Object.freeze({ kind: "canceled" })
  if (!streaming) {
    if (reason === "error") {
      const status = httpStatus >= 400 && httpStatus <= 599 ? httpStatus : 500
      return Object.freeze({ kind: "error", code: "transport", status })
    }
    return Object.freeze({ kind: "success" })
  }
  // A terminal SSE event wins even when cancellation is the signal that publishes it.
  if (stats.terminal === "end" && reason !== "error") return Object.freeze({ kind: "success" })
  if (stats.terminal === "error") {
    return Object.freeze({
      kind: "error",
      code: stats.errorCode ?? "internal",
      status: stats.errorStatus ?? 500
    })
  }
  return Object.freeze({ kind: "truncated" })
}
