import {
  afterFunc,
  canceled,
  deadlineExceeded,
  type Context,
  type StopFunc
} from "@go-like/context"
import type { Infer, Struct } from "@go-like/struct"
import {
  isServiceError,
  serviceError,
  type ServerStream,
  type ServiceError
} from "@go-like/transport"
import { decodeJsonBody } from "@go-like/transport/json"
import { newTransportProtocolError } from "@go-like/transport/provider"
import {
  createLineParser,
  createMessageParser,
  type EventStreamMessage
} from "@go-like/transport/sse"

const encoder = new TextEncoder()

/** Reads one SSE response as a one-shot server stream. */
export function openServerStream<S extends Struct>(
  response: Response,
  schema: S,
  maxEventBytes: number,
  ctx: Context
): ServerStream<Infer<S>> {
  if (!(response instanceof Response)) throw new TypeError("server stream requires a Response")
  if (!Number.isSafeInteger(maxEventBytes) || maxEventBytes < 1) {
    throw new RangeError("server stream maxEventBytes must be a positive safe integer")
  }
  let used = false
  let generator: AsyncIterator<Infer<S>> | null = null
  let closing: Promise<void> | null = null
  const consumer = { closedWhileHealthy: false }
  const active: { reader: ReadableStreamDefaultReader<Uint8Array> | null } = { reader: null }
  const stopCaller = afterFunc(ctx, function cancelFromCaller(): void {
    void abortBody()
  })

  /** Creates the single iterator that owns the response body. */
  function source(): AsyncIterator<Infer<S>> {
    if (generator !== null) return generator
    if (consumer.closedWhileHealthy) {
      generator = emptyStream<Infer<S>>()
      return generator
    }
    generator = guardServerStream(
      iterate(response, schema, maxEventBytes, ctx, active, stopCaller, consumer),
      ctx,
      consumer,
      beginClose
    )
    return generator
  }

  /** Cancels the response body without completing the consumer generator. */
  function abortBody(): void {
    const reader = active.reader
    if (reader !== null) {
      abandonCancellation(reader.cancel())
      return
    }
    const body = response.body
    if (body !== null && body.locked !== true) abandonCancellation(body.cancel())
  }

  // Abort is shared by close() and iterator.return(). The flag is set before the first await.
  let release: Promise<void> | null = null
  function beginClose(): Promise<void> {
    if (contextFailure(ctx) === null) consumer.closedWhileHealthy = true
    release ??= (async function releaseBody(): Promise<void> {
      stopCaller()
      abortBody()
    })()
    return release
  }

  /** Cancels the underlying response. A second call is a no-op. */
  async function close(): Promise<void> {
    closing ??= (async function finishClose(): Promise<void> {
      await beginClose()
      if (generator?.return !== undefined) await generator.return().catch(ignoreFailure)
    })()
    await closing
  }

  return {
    /** Starts the only iteration of this stream. */
    [Symbol.asyncIterator](): AsyncIterator<Infer<S>> {
      if (used) throw new TypeError("server stream can only be iterated once")
      used = true
      return source()
    },
    close,
    /** Releases the stream when an await using block exits. */
    async [Symbol.asyncDispose](): Promise<void> {
      await close()
    }
  }
}

/** Yields nothing when close runs before iteration starts. */
async function* emptyStream<T>(): AsyncGenerator<T> {}

/** Swallows a body cancellation that loses a race with an already-closed stream. */
function ignoreFailure(): void {}

/** Starts cancellation and absorbs its rejection. Delivery must not wait for the promise. */
function abandonCancellation(pending: Promise<void>): void {
  void pending.catch(ignoreFailure)
}

/** Returns the caller failure, including a deadline that elapsed before its timer ran. */
function contextFailure(ctx: Context): Error | null {
  const failure = ctx.err()
  if (failure !== null) return failure
  const [at, hasDeadline] = ctx.deadline()
  if (hasDeadline && at.getTime() <= Date.now()) return deadlineExceeded
  return null
}

const doneResult: IteratorResult<never> = { done: true, value: undefined }

/** Applies terminal priority before each resumed frame and after consumer close. */
function guardServerStream<T>(
  inner: AsyncGenerator<T>,
  ctx: Context,
  consumer: { closedWhileHealthy: boolean },
  beginClose: () => Promise<void>
): AsyncIterator<T> {
  let tail: Promise<void> = Promise.resolve()
  let returning: Promise<IteratorResult<T>> | null = null

  /** Reads one result, dropping anything that arrives after caller context failure. */
  async function step(): Promise<IteratorResult<T>> {
    if (consumer.closedWhileHealthy) return doneResult
    const failure = contextFailure(ctx)
    if (failure !== null) {
      await inner.return(undefined).catch(ignoreFailure)
      throw failure
    }
    try {
      const result = await inner.next()
      if (consumer.closedWhileHealthy) return doneResult
      const after = contextFailure(ctx)
      if (after !== null) {
        await inner.return(undefined).catch(ignoreFailure)
        throw after
      }
      return result
    } catch (error) {
      if (consumer.closedWhileHealthy) return doneResult
      const after = contextFailure(ctx)
      if (after !== null) throw after
      throw error
    }
  }

  return {
    /** Resumes the body after the previous read settles. */
    next(): Promise<IteratorResult<T>> {
      const run = tail.then(step)
      tail = run.then(function ignoreResolved(): void {}, ignoreFailure)
      return run
    },
    /** Marks a healthy consumer close, aborts the body, then finishes the generator. */
    return(): Promise<IteratorResult<T>> {
      if (returning !== null) return returning
      returning = beginClose().then(function afterAbort(): Promise<IteratorResult<T>> {
        return inner
          .return(undefined)
          .catch(ignoreFailure)
          .then(function returned(): IteratorResult<T> {
            return doneResult
          })
      })
      return returning
    }
  }
}

/** Pulls SSE frames until end, error, cancellation, or a protocol failure. */
async function* iterate<S extends Struct>(
  response: Response,
  schema: S,
  maxEventBytes: number,
  ctx: Context,
  active: { reader: ReadableStreamDefaultReader<Uint8Array> | null },
  stopCaller: StopFunc,
  consumer: { closedWhileHealthy: boolean }
): AsyncGenerator<Infer<S>> {
  const body = response.body
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  const pending: PendingBytes = { bytes: new Uint8Array(0), scanned: 0 }
  let terminal = false
  try {
    const failure = contextFailure(ctx)
    if (failure !== null) throw failure
    if (body === null) {
      throw newTransportProtocolError("server stream ended before a terminal event")
    }
    reader = body.getReader()
    active.reader = reader
    while (!terminal) {
      const chunk = await readChunk(reader, ctx)
      if (chunk.value !== undefined) appendBytes(pending, chunk.value)
      let frame = takeFrame(pending)
      while (frame !== null) {
        if (frame.byteLength > maxEventBytes) throw receiveLimit(frame.byteLength, maxEventBytes)
        const message = await parseFrame(frame)
        frame = takeFrame(pending)
        if (consumer.closedWhileHealthy) {
          terminal = true
          return
        }
        const failure = contextFailure(ctx)
        if (failure !== null) throw failure
        if (message === null) continue
        if (message.event === "end") {
          terminal = true
          return
        }
        if (message.event === "error") {
          terminal = true
          throw decodeStreamError(message.data)
        }
        if (message.event !== "") continue
        yield decodeMessage(schema, message.data)
      }
      const unfinished = pending.bytes.byteLength
      if (unfinished > maxEventBytes) throw receiveLimit(unfinished, maxEventBytes)
      if (chunk.done) {
        throw newTransportProtocolError("server stream ended before a terminal event")
      }
    }
  } finally {
    stopCaller()
    active.reader = null
    if (reader !== null) finishReader(reader)
  }
}

/** Cancels the remaining body. A tee cancel can stay pending, so the caller does not wait. */
function finishReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  abandonCancellation(reader.cancel())
}

type StreamRead = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>

/** Reads one chunk, surfacing caller cancellation ahead of a stalled socket. */
async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ctx: Context
): Promise<StreamRead> {
  const failure = contextFailure(ctx)
  if (failure !== null) throw failure
  const signal = ctx.done()
  const pending = reader.read()
  void pending.catch(function ignoreLosingRead(): void {})
  if (signal === null) return await pending
  if (signal.aborted) throw contextFailure(ctx) ?? canceled
  return await new Promise<StreamRead>(function race(resolve, reject): void {
    /** Rejects the read when the caller Context ends. */
    function onAbort(): void {
      reject(contextFailure(ctx) ?? canceled)
    }
    signal.addEventListener("abort", onAbort, { once: true })
    pending.then(
      function chunk(value): void {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      function failed(error: unknown): void {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      }
    )
  })
}

/** Returns the index after the next SSE event boundary that starts at or after from, or -1. */
function eventBoundary(bytes: Uint8Array, from: number): number {
  for (let index = from; index < bytes.length; index += 1) {
    const current = bytes[index]
    if (current === 10 && bytes[index + 1] === 10) return index + 2
    if (
      current === 13 &&
      bytes[index + 1] === 10 &&
      bytes[index + 2] === 13 &&
      bytes[index + 3] === 10
    ) {
      return index + 4
    }
  }
  return -1
}

/** Parses one complete SSE frame, ignoring comment-only heartbeats. */
async function parseFrame(frame: Uint8Array): Promise<EventStreamMessage | null> {
  let message: EventStreamMessage | null = null
  const parseMessage = createMessageParser(
    function ignoreId(): void {},
    function ignoreRetry(): void {},
    function capture(value: EventStreamMessage): void {
      message = value
    }
  )
  const parseLine = createLineParser(parseMessage)
  await parseLine(frame)
  return message
}

/** Decodes one business event with the response Struct. */
function decodeMessage<S extends Struct>(schema: S, data: string): Infer<S> {
  try {
    return decodeJsonBody(schema, encoder.encode(data))
  } catch (error) {
    const cause = error instanceof Error ? error : undefined
    const detail = "server stream message does not match the response struct"
    throw newTransportProtocolError(detail, cause)
  }
}

/** Restores a ServiceError from an error event, or reports a protocol failure. */
function decodeStreamError(data: string): ServiceError {
  try {
    const parsed: unknown = JSON.parse(data)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new TypeError("error event payload must be an object")
    }
    const code = Reflect.get(parsed, "code")
    const message = Reflect.get(parsed, "message")
    const status = Reflect.get(parsed, "status")
    const metadata = Reflect.get(parsed, "metadata")
    if (typeof code !== "string" || typeof message !== "string" || typeof status !== "number") {
      throw new TypeError("error event payload is incomplete")
    }
    const restored = serviceError(code, message, status, metadata)
    if (!isServiceError(restored)) throw new TypeError("error event payload is not a ServiceError")
    return restored
  } catch (error) {
    if (isServiceError(error)) return error
    const cause = error instanceof Error ? error : undefined
    throw newTransportProtocolError("server stream error event is invalid", cause)
  }
}

/** Builds the client-side size error, including the observed byte count. */
function receiveLimit(actual: number, limit: number): ServiceError {
  return serviceError(
    "resource_exhausted",
    `SSE event is ${actual} bytes and exceeds the client receive limit of ${limit} bytes`,
    429
  )
}

/** Received bytes that have not yet been consumed as complete SSE frames. */
interface PendingBytes {
  /** The unconsumed bytes, a view whose buffer may keep spare room for later chunks. */
  bytes: Uint8Array<ArrayBuffer>
  /** No event boundary starts before this offset into bytes, so a scan resumes here. */
  scanned: number
}

/** Copies one chunk behind the pending bytes; doubling spare room keeps total copying linear. */
function appendBytes(pending: PendingBytes, chunk: Uint8Array): void {
  const { buffer, byteOffset, byteLength } = pending.bytes
  const size = byteLength + chunk.byteLength
  // Reuse the spare room, unless it is used up or the consumed prefix outweighs what is left.
  if (byteOffset + size <= buffer.byteLength && byteOffset <= size) {
    new Uint8Array(buffer, byteOffset + byteLength).set(chunk)
    pending.bytes = new Uint8Array(buffer, byteOffset, size)
    return
  }
  const grown = new Uint8Array(size * 2)
  grown.set(pending.bytes)
  grown.set(chunk, byteLength)
  pending.bytes = grown.subarray(0, size)
}

/** Removes the next complete SSE frame from the pending bytes, or returns null while unfinished. */
function takeFrame(pending: PendingBytes): Uint8Array | null {
  const boundary = eventBoundary(pending.bytes, pending.scanned)
  if (boundary < 0) {
    // A boundary is at most four bytes long, so only the last three bytes can still begin one.
    pending.scanned = Math.max(0, pending.bytes.byteLength - 3)
    return null
  }
  const frame = pending.bytes.subarray(0, boundary)
  pending.bytes = pending.bytes.subarray(boundary)
  pending.scanned = 0
  return frame
}
