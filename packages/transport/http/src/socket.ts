import { canceled, withCancel, type Context } from "@likego/context"
import { type AcceptHandler, type Message, type TransportLogger } from "@likego/transport"
import {
  newTransportClosedError,
  newTransportProtocolError,
  newTransportStateError,
  snapshotMessage,
  type TransportClosedError
} from "@likego/transport/provider"
import {
  assertHTTPContentLength,
  boundedHTTPBodyLength,
  contextError,
  normalizeHTTPError,
  snapshotHTTPBodyChunk
} from "./errors"
import { requestHeaders, snapshotResponseHeaders } from "./headers"
import { defaultHTTPMaxMessageBytes } from "./options"
import { withHTTPServerTransportInfo } from "./transport-info"
import type { HTTPHostRequest } from "./types"

const InternalServerErrorBody = "Internal Server Error"

/** Intentionally observes a best-effort body cancellation rejection. */
function ignoreRejection(): void {}

/** Cancels one transport-owned request reader without throwing into its caller. */
function cancelRequestReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    const cancel = reader.cancel
    const work = cancel.call(reader)
    void Promise.resolve(work).catch(ignoreRejection)
  } catch {
    // Caller Context settlement remains primary over best-effort reader cleanup.
  }
}

/** Waits for one Promise while the supplied Context remains active. */
function waitForContext<T>(
  ctx: Context,
  work: Promise<T>,
  cancelWork: (() => void) | null = null
): Promise<T> {
  const initial = contextError(ctx)
  if (initial !== null) {
    cancelWork?.()
    return Promise.reject(initial)
  }
  const signal = ctx.done()
  if (signal === null) return work
  const activeSignal = signal
  return new Promise<T>(function wait(resolve, reject): void {
    let settled = false
    /** Removes the Context observer. */
    function cleanup(): void {
      activeSignal.removeEventListener("abort", onAbort)
    }
    /** Rejects with the exact Context error. */
    function onAbort(): void {
      settled = true
      cleanup()
      cancelWork?.()
      reject(contextError(ctx) ?? canceled)
    }
    activeSignal.addEventListener("abort", onAbort, { once: true })
    work.then(
      function resolved(value): void {
        if (settled) return
        settled = true
        cleanup()
        resolve(value)
      },
      function rejected(error: unknown): void {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
    )
    if (contextError(ctx) !== null) onAbort()
  })
}

/** Converts one Request into a detached Message with owned body cancellation. */
function receiveRequest(input: HTTPHostRequest, maxMessageBytes: number) {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  /** Consumes the request body through one transport-owned standard reader. */
  async function consume(): Promise<Message> {
    if (input.request.method.toUpperCase() !== "POST") {
      throw newTransportProtocolError("HTTP transport request method must be POST")
    }
    const chunks: Uint8Array[] = []
    let length = 0
    const body = input.request.body
    if (body === null) {
      assertHTTPContentLength(
        input.request.headers,
        maxMessageBytes,
        "HTTP request Content-Length is invalid or exceeds maxMessageBytes"
      )
    } else {
      const activeReader = body.getReader()
      reader = activeReader
      try {
        assertHTTPContentLength(
          input.request.headers,
          maxMessageBytes,
          "HTTP request Content-Length is invalid or exceeds maxMessageBytes"
        )
        while (true) {
          let result: unknown
          try {
            result = await activeReader.read()
          } catch (error) {
            throw newTransportProtocolError(
              "invalid HTTP request body",
              error instanceof Error ? error : undefined
            )
          }
          const chunk = snapshotHTTPBodyChunk(result, "invalid HTTP request body")
          if (chunk === null) break
          length = boundedHTTPBodyLength(
            length,
            chunk.byteLength,
            maxMessageBytes,
            "HTTP request body exceeds maxMessageBytes"
          )
          chunks.push(chunk)
        }
      } catch (error) {
        if (reader === activeReader) {
          reader = null
          cancelRequestReader(activeReader)
        }
        throw error
      } finally {
        if (reader === activeReader) reader = null
        activeReader.releaseLock()
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
        header: snapshotResponseHeaders(input.request.headers),
        body: bytes
      })
    )
  }
  const promise = consume()
  return Object.freeze({
    promise,
    /** Cancels the currently owned standard body reader at most once. */
    cancel(): void {
      const activeReader = reader
      if (activeReader === null) return
      reader = null
      cancelRequestReader(activeReader)
    }
  })
}

/** Converts one detached transport Message into a successful HTTP Response. */
function responseMessage(message: Message, maxMessageBytes: number): Response {
  const prepared = requestHeaders(message)
  const body = prepared.message.body
  boundedHTTPBodyLength(
    0,
    body.byteLength,
    maxMessageBytes,
    "HTTP response body exceeds maxMessageBytes"
  )
  const detached = new ArrayBuffer(body.byteLength)
  new Uint8Array(detached).set(body)
  return new Response(
    detached,
    Object.freeze({
      status: 200,
      headers: prepared.headers
    })
  )
}

/** Returns one secret-safe generic server failure response. */
function internalServerError(): Response {
  return new Response(
    InternalServerErrorBody,
    Object.freeze({
      status: 500,
      headers: Object.freeze({ "content-type": "text/plain; charset=utf-8" })
    })
  )
}

/** Dispatches one host envelope through a unary logical transport Socket. */
export async function dispatchHTTPHostRequest(
  owner: Context,
  handler: AcceptHandler,
  input: HTTPHostRequest,
  connectionMetadata: boolean,
  logger: TransportLogger | null = null,
  endpoint = "",
  maxMessageBytes = defaultHTTPMaxMessageBytes
): Promise<Response> {
  const [socketContext, cancelSocket] = withCancel(owner)
  const requestSignal = input.request.signal
  /** Cancels only the private socket Context when the external Request ends. */
  function cancelFromRequest(): void {
    cancelSocket()
  }
  requestSignal.addEventListener("abort", cancelFromRequest, { once: true })
  if (requestSignal.aborted) cancelSocket()
  const closedError: TransportClosedError = newTransportClosedError("HTTP server socket is closed")
  let received = false
  let sent = false
  let closed = false
  let response: Response | null = null

  const socket = Object.freeze({
    /** Receives the request Message exactly once. */
    recv(ctx: Context): Promise<Message> {
      const callerFailure = contextError(ctx)
      if (callerFailure !== null) return Promise.reject(callerFailure)
      if (closed) return Promise.reject(closedError)
      const ownerFailure = contextError(socketContext)
      if (ownerFailure !== null) return Promise.reject(ownerFailure)
      if (received)
        return Promise.reject(newTransportStateError("HTTP server socket recv already used"))
      received = true
      const reading = receiveRequest(input, maxMessageBytes)
      return waitForContext(
        ctx,
        waitForContext(socketContext, reading.promise, reading.cancel),
        reading.cancel
      )
    },
    /** Stores the successful response Message exactly once. */
    send(ctx: Context, message: Message): Promise<void> {
      const callerFailure = contextError(ctx)
      if (callerFailure !== null) return Promise.reject(callerFailure)
      if (closed) return Promise.reject(closedError)
      const ownerFailure = contextError(socketContext)
      if (ownerFailure !== null) return Promise.reject(ownerFailure)
      if (sent)
        return Promise.reject(newTransportStateError("HTTP server socket send already used"))
      try {
        response = responseMessage(message, maxMessageBytes)
        sent = true
        return Promise.resolve()
      } catch (error) {
        return Promise.reject(error)
      }
    },
    /** Idempotently closes this logical socket. */
    close(ctx: Context): Promise<void> {
      const failure = contextError(ctx)
      if (failure !== null) return Promise.reject(failure)
      if (!closed) {
        closed = true
        cancelSocket()
      }
      return Promise.resolve()
    },
    /** Returns host-provided local metadata only when admitted. */
    local(): string {
      return connectionMetadata ? input.localAddress : ""
    },
    /** Returns host-provided remote metadata only when admitted. */
    remote(): string {
      return connectionMetadata ? input.remoteAddress : ""
    },
    /** Returns the handler-produced Response or rejects when absent. */
    response(): Promise<Response> {
      return response === null
        ? Promise.reject(newTransportStateError("HTTP server handler did not send a response"))
        : Promise.resolve(response)
    }
  })

  const dispatched = (async function dispatch(): Promise<Response> {
    try {
      const handlerContext = withHTTPServerTransportInfo(
        socketContext,
        endpoint,
        input.request,
        function currentResponse(): Response | null {
          return response
        }
      )
      await handler(handlerContext, socket)
      if (!sent || response === null) return internalServerError()
      return response
    } catch (error) {
      const failure = normalizeHTTPError(error, "HTTP transport handler rejected")
      logger?.log("error", "HTTP transport handler rejected", Object.freeze({ cause: failure }))
      return internalServerError()
    }
  })()
  return dispatched.finally(function finishDispatch(): void {
    closed = true
    cancelSocket()
    requestSignal.removeEventListener("abort", cancelFromRequest)
  })
}
