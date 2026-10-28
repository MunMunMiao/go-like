import {
  afterFunc,
  canceled,
  deadlineExceeded,
  withCancelCause,
  type Context
} from "@go-like/context"
import type { Infer, Struct } from "@go-like/struct"
import { isServiceError, serviceError, type Endpoint, type ServiceError } from "@go-like/transport"
import { decodeJsonBody, encodeJsonBody, jsonContentType } from "@go-like/transport/json"
import {
  encodeSSEComment,
  encodeSSEEvent,
  encodeSSEJsonEvent,
  eventStreamContentType
} from "@go-like/transport/sse"
import { internalServiceError } from "@go-like/transport/provider"

import type { Handler } from "./index"

/** Default idle comment interval. Zero disables comments after the initial one. */
export const defaultStreamKeepAliveMs = 15_000

/** Default UTF-8 ceiling for one encoded server event. */
export const defaultMaxSendMessageBytes = 4 * 1024 * 1024

const decoder = new TextDecoder("utf-8", { fatal: true })

/** Validates the server heartbeat interval. */
export function streamKeepAliveValue(value: unknown): number {
  if (value === undefined) return defaultStreamKeepAliveMs
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 2_147_483_647
  ) {
    throw new RangeError("server streamKeepAlive must be an integer between 0 and 2147483647")
  }
  return value
}

/** Validates the server per-event send ceiling. */
export function maxSendMessageBytesValue(value: unknown): number {
  if (value === undefined) return defaultMaxSendMessageBytes
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("server maxSendMessageBytes must be a positive safe integer")
  }
  return value
}

/** Adapts one typed stream handler to an SSE Fetch response. */
export function typedStreamHandler<RequestStruct extends Struct, ResponseStruct extends Struct>(
  contract: Endpoint<RequestStruct, ResponseStruct, true>,
  value: (ctx: Context, request: Infer<RequestStruct>) => unknown,
  keepAliveMs: number,
  maxSendBytes: number
): Handler {
  /** Decodes one JSON request and opens an SSE response after the handler returns. */
  async function handle(ctx: Context, request: Request): Promise<Response> {
    let input: Infer<RequestStruct>
    try {
      const raw = request.headers.get("content-type")
      const type = (raw ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? ""
      if (type !== jsonContentType) throw new TypeError("unexpected request Content-Type")
      input = decodeJsonBody(contract.request, new Uint8Array(await request.arrayBuffer()))
    } catch (error) {
      if (isServiceError(error)) throw error
      throw serviceError("invalid_request", "invalid request body", 400)
    }

    const [streamCtx, cancelStream] = withCancelCause(ctx)
    let produced: unknown
    try {
      produced = value(streamCtx, input)
    } catch (error) {
      cancelStream(canceled)
      throw error
    }
    const iterable = isAsyncIterable(produced) ? produced : rejectedIterable(produced)
    return streamResponse(
      streamCtx,
      cancelStream,
      iterable,
      contract.response,
      keepAliveMs,
      maxSendBytes
    )
  }
  return handle
}

/** Serves one async iterable as a pull-based SSE response. */
function streamResponse(
  streamCtx: Context,
  cancelStream: (cause: Error | null) => void,
  iterable: AsyncIterable<unknown>,
  schema: Struct,
  keepAliveMs: number,
  maxSendBytes: number
): Response {
  const iterator = iterable[Symbol.asyncIterator]()
  let pending: Promise<IteratorResult<unknown>> | null = null
  let finished = false

  /** Cancels the request ctx, then starts generator finally without waiting out its current await. */
  async function finish(cause: Error): Promise<void> {
    if (finished) return
    finished = true
    cancelStream(cause)
    const current = pending
    pending = null
    /** Swallows iterator settlement after the body has already closed. */
    function ignore(): void {}
    if (current !== null) void current.then(ignore, ignore)
    if (typeof iterator.return !== "function") return
    let returned: Promise<unknown>
    try {
      returned = Promise.resolve(iterator.return())
    } catch {
      // Generator cleanup must not replace the stream outcome.
      return
    }
    void returned.then(ignore, ignore)
    // return() cannot interrupt an await already running inside the generator.
    // A generator suspended at yield settles on a microtask; a blocked await must not hold the body.
    await new Promise<void>(function abandonSlowCleanup(resolve): void {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = null
      /** Resolves stream shutdown once finally ran, or once it is blocked on user code. */
      function done(): void {
        if (settled) return
        settled = true
        if (timer !== null) clearTimeout(timer)
        resolve()
      }
      timer = setTimeout(done, 0)
      timer.unref?.()
      void returned.then(done, done)
    })
  }

  /** Enqueues one frame, or finishes when the consumer has already left. */
  async function enqueue(
    controller: ReadableStreamDefaultController<Uint8Array>,
    bytes: Uint8Array
  ): Promise<boolean> {
    try {
      controller.enqueue(bytes)
      return true
    } catch {
      await finish(canceled)
      try {
        controller.close()
      } catch {
        // The consumer already canceled.
      }
      return false
    }
  }

  /** Closes the body after the consumer may already have canceled. */
  async function closeBody(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    try {
      controller.close()
    } catch {
      // The consumer already canceled.
    }
  }

  /** Queues one terminal error event and closes the body. */
  async function emitError(
    controller: ReadableStreamDefaultController<Uint8Array>,
    error: ServiceError
  ): Promise<void> {
    const bytes = encodeSSEEvent(
      JSON.stringify({
        code: error.code,
        message: error.message,
        status: error.status,
        metadata: error.metadata
      }),
      "error"
    )
    if (!(await enqueue(controller, bytes))) return
    await finish(streamCtx.err() === deadlineExceeded ? deadlineExceeded : canceled)
    await closeBody(controller)
  }

  const stream = new ReadableStream<Uint8Array>(
    {
      /** Queues the handshake comment before the first handler pull. */
      start(controller): void {
        controller.enqueue(encodeSSEComment())
      },
      /** Pulls at most one iterator result and may emit an idle comment first. */
      async pull(controller): Promise<void> {
        if (finished) return
        const early = streamCtx.err()
        if (early !== null) {
          if (early === deadlineExceeded) {
            await emitError(
              controller,
              serviceError("deadline_exceeded", "context deadline exceeded", 504)
            )
            return
          }
          await finish(early)
          await closeBody(controller)
          return
        }
        if (pending === null) {
          try {
            pending = Promise.resolve(iterator.next())
          } catch (error) {
            await emitError(controller, asServiceError(error))
            return
          }
        }
        const current = pending
        let winner: "message" | "heartbeat" | "context"
        try {
          winner = await waitForStream(current, streamCtx, keepAliveMs)
        } catch (error) {
          await emitError(controller, asServiceError(error))
          return
        }
        if (winner === "heartbeat") {
          await enqueue(controller, encodeSSEComment())
          return
        }
        if (winner === "context" || streamCtx.err() !== null) {
          const failure = streamCtx.err() ?? canceled
          if (failure === deadlineExceeded) {
            await emitError(
              controller,
              serviceError("deadline_exceeded", "context deadline exceeded", 504)
            )
            return
          }
          await finish(failure)
          await closeBody(controller)
          return
        }
        const result = await current
        pending = null
        if (result.done === true) {
          if (await enqueue(controller, encodeSSEJsonEvent({}, "end"))) await closeBody(controller)
          await finish(canceled)
          return
        }
        let bytes: Uint8Array
        try {
          bytes = encodeSSEEvent(decoder.decode(encodeJsonBody(schema, result.value as never)))
        } catch {
          await emitError(controller, internalServiceError())
          return
        }
        if (bytes.byteLength > maxSendBytes) {
          await emitError(
            controller,
            serviceError(
              "resource_exhausted",
              `SSE event is ${bytes.byteLength} bytes and exceeds the server send limit of ${maxSendBytes} bytes`,
              429
            )
          )
          return
        }
        await enqueue(controller, bytes)
      },
      /** Cancels the request ctx before the generator finally runs. */
      async cancel(reason): Promise<void> {
        const failure = reason instanceof Error ? reason : canceled
        await finish(failure)
      }
    },
    { highWaterMark: 0 }
  )
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": eventStreamContentType,
      "cache-control": "no-cache"
    }
  })
}

/** Resolves when the pending iterator, the heartbeat, or the request ctx settles. */
function waitForStream(
  pending: Promise<IteratorResult<unknown>>,
  streamCtx: Context,
  keepAliveMs: number
): Promise<"message" | "heartbeat" | "context"> {
  return new Promise(function race(resolve, reject): void {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const stop = afterFunc(streamCtx, function onContext(): void {
      settle("context")
    })
    /** Publishes the first wake-up and releases the heartbeat timer. */
    function settle(winner: "message" | "heartbeat" | "context"): void {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      stop()
      resolve(winner)
    }
    void pending.then(
      function messageReady(): void {
        settle("message")
      },
      function messageFailed(error: unknown): void {
        if (settled) return
        settled = true
        if (timer !== null) clearTimeout(timer)
        stop()
        reject(error)
      }
    )
    if (keepAliveMs > 0) {
      timer = setTimeout(function heartbeat(): void {
        settle("heartbeat")
      }, keepAliveMs)
      timer.unref?.()
    }
  })
}

/** Reports whether the handler returned an async iterable rather than a promise of one. */
function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function"
  )
}

/** Turns a non-iterable handler result into one internal error on the first pull. */
function rejectedIterable(produced: unknown): AsyncIterable<unknown> {
  if (
    typeof produced === "object" &&
    produced !== null &&
    "then" in produced &&
    typeof (produced as Promise<unknown>).then === "function"
  ) {
    void (produced as Promise<unknown>).then(
      function ignore(): void {},
      function ignore(): void {}
    )
  }
  return {
    [Symbol.asyncIterator](): AsyncIterator<unknown> {
      return {
        /** The handler return value cannot be streamed. */
        next(): Promise<IteratorResult<unknown>> {
          return Promise.reject(internalServiceError())
        }
      }
    }
  }
}

/** Preserves a branded ServiceError and hides every other handler failure. */
function asServiceError(value: unknown): ServiceError {
  return isServiceError(value) ? value : internalServiceError()
}
