import { newTransportProtocolError } from "@go-like/transport/provider"

import {
  assertHTTPContentLength,
  boundedHTTPBodyLength,
  isError,
  snapshotHTTPBodyChunk
} from "./errors"

/** Copies owned bytes into an ArrayBuffer Fetch accepts as a request body. */
function bodyBytes(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  return copy
}

/** Reads one request body, rejecting an invalid or oversized payload before send. */
export async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  headers: Headers,
  maximumBytes: number,
  lengthMessage: string,
  bodyMessage: string,
  signal: AbortSignal | null = null
): Promise<Uint8Array | null> {
  assertHTTPContentLength(headers, maximumBytes, lengthMessage)
  if (body === null) return null
  const reader = body.getReader()
  /** Cancels a locked body from the reader; canceling the stream itself throws. */
  function stopReader(): void {
    void reader.cancel().catch(function ignore(): void {})
  }
  if (signal?.aborted === true) stopReader()
  else if (signal !== null) signal.addEventListener("abort", stopReader, { once: true })
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      let result: unknown
      try {
        result = await reader.read()
      } catch (error) {
        throw newTransportProtocolError(bodyMessage, isError(error) ? error : undefined)
      }
      const chunk = snapshotHTTPBodyChunk(result, bodyMessage)
      if (chunk === null) break
      length = boundedHTTPBodyLength(length, chunk.byteLength, maximumBytes, bodyMessage)
      chunks.push(chunk)
    }
  } catch (error) {
    // Cancellation is cleanup. A stalled source must not hold the original failure.
    void reader.cancel(error).then(
      function released(): void {},
      function ignored(): void {}
    )
    throw error
  } finally {
    signal?.removeEventListener("abort", stopReader)
    try {
      reader.releaseLock()
    } catch {
      // cancel() may already have released the reader.
    }
  }
  const [first] = chunks
  // snapshotHTTPBodyChunk already detached every chunk, so a lone one is the body.
  if (first !== undefined && chunks.length === 1) return first
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/** Reports an event-stream response, which is limited per event rather than in aggregate. */
function eventStreamResponse(response: Response): boolean {
  const raw = response.headers.get("content-type")
  return ((raw ?? "").split(";", 1)[0]?.trim().toLowerCase() ?? "") === "text/event-stream"
}

/** Returns a Response whose body errors once it passes the configured byte limit. */
export function limitResponse(
  response: Response,
  maximumBytes: number,
  onDone: () => void = function done(): void {},
  signal: AbortSignal | null = null
): Response {
  const unbounded = eventStreamResponse(response)
  let settled = false
  /** Publishes body completion once. */
  function finish(): void {
    if (settled) return
    settled = true
    signal?.removeEventListener("abort", failFromSignal)
    onDone()
  }
  if (!unbounded) {
    try {
      assertHTTPContentLength(
        response.headers,
        maximumBytes,
        "HTTP response Content-Length is invalid or exceeds maxMessageBytes"
      )
    } catch (error) {
      finish()
      void response.body?.cancel().catch(function ignore(): void {})
      throw error
    }
  }
  if (response.body === null) {
    finish()
    return response
  }
  const reader = response.body.getReader()
  let total = 0
  let failed = false
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null
  /** Fails an in-progress consumer read; canceling a locked body from outside throws. */
  function fail(reason: unknown): void {
    if (failed) return
    failed = true
    finish()
    const error = isError(reason) ? reason : new Error("HTTP response body aborted")
    try {
      streamController?.error(error)
    } catch {
      // The consumer already observed a terminal state.
    }
    void reader.cancel(error).catch(function ignore(): void {})
  }
  /** Forwards the abort reason into the body the caller is already reading. */
  function failFromSignal(): void {
    fail(signal?.reason)
  }
  const stream = new ReadableStream<Uint8Array>({
    /** Captures the controller before any caller can lock the body. */
    start(controller): void {
      streamController = controller
    },
    /** Forwards one bounded chunk or fails the stream past the limit. */
    async pull(controller): Promise<void> {
      if (failed) return
      try {
        let result: unknown
        try {
          result = await reader.read()
        } catch (error) {
          throw newTransportProtocolError(
            "invalid HTTP response body",
            isError(error) ? error : undefined
          )
        }
        const chunk = snapshotHTTPBodyChunk(result, "invalid HTTP response body")
        if (chunk === null) {
          finish()
          controller.close()
          return
        }
        if (!unbounded) {
          total = boundedHTTPBodyLength(
            total,
            chunk.byteLength,
            maximumBytes,
            "HTTP response body exceeds maxMessageBytes"
          )
        }
        controller.enqueue(chunk)
      } catch (error) {
        finish()
        controller.error(error)
        try {
          await reader.cancel(error)
        } catch {
          // The stream error remains primary over source cancellation.
        }
      }
    },
    /** Cancels the source body so a pooled connection can return. */
    cancel(reason): Promise<void> {
      finish()
      return reader.cancel(reason)
    }
  })
  if (signal?.aborted === true) failFromSignal()
  else if (signal !== null) signal.addEventListener("abort", failFromSignal, { once: true })
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers)
  })
}

/** Copies one buffered request body into a Fetch body the executor can replay. */
export function replayableBody(bytes: Uint8Array): ArrayBuffer {
  return bodyBytes(bytes)
}
