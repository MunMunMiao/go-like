/**
 * Portions of this file are adapted from Azure/fetch-event-source.
 * See packages/transport/THIRD_PARTY_NOTICES.md for the license text.
 */

/** One parsed SSE message. Comment-only frames are not emitted. */
export interface EventStreamMessage {
  readonly id: string
  readonly event: string
  readonly data: string
}

/** Raised when a line or data buffer exceeds its configured ceiling. */
export class SSEParserLimitError extends Error {
  constructor() {
    super("SSE parser buffer exceeded maxBufferSize")
    this.name = "SSEParserLimitError"
  }
}

const newline = 10
const carriageReturn = 13
const space = 32
const colon = 58

/** Reads stream chunks until EOF, cancellation, or the first callback failure. */
export async function readStreamBytes(
  stream: ReadableStream<Uint8Array>,
  onChunk: (chunk: Uint8Array) => void | Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  const reader = stream.getReader()
  let cancelPromise: Promise<void> | undefined
  /** Cancels the source once; a second call reuses the same completion. */
  function cancelOnce(reason: unknown): void {
    cancelPromise ??= reader.cancel(reason).catch(function ignoreCancel(): void {})
  }
  let rejectAbort: ((reason?: unknown) => void) | undefined
  const abortPromise = signal
    ? new Promise<never>(function rejectOnAbort(_resolve, reject): void {
        rejectAbort = reject
      })
    : undefined
  void abortPromise?.catch(function ignoreStandaloneAbort(): void {})

  /** Forwards an abort into both the race and the locked source reader. */
  function onAbort(): void {
    const reason = signal?.reason ?? new Error("The operation was aborted")
    rejectAbort?.(reason)
    cancelOnce(reason)
  }

  try {
    if (signal?.aborted) {
      signal.throwIfAborted()
    } else {
      signal?.addEventListener("abort", onAbort, { once: true })
    }

    while (true) {
      const readPromise = reader.read()
      void readPromise.catch(function ignoreLosingRead(): void {})
      const { done, value } = abortPromise
        ? await Promise.race([readPromise, abortPromise])
        : await readPromise
      if (done) return
      await onChunk(value)
    }
  } catch (error) {
    cancelOnce(error)
    throw error
  } finally {
    signal?.removeEventListener("abort", onAbort)
    if (stream.locked) reader.releaseLock()
  }
}

/** Configures the incremental line splitter. */
export interface LineParserOptions {
  readonly maxBufferSize?: number
}

/** Splits chunks into lines and reports the byte index of the first colon. */
export function createLineParser(
  onLine: (line: Uint8Array, fieldLength: number) => void | Promise<void>,
  options?: LineParserOptions
): (chunk: Uint8Array) => Promise<void> {
  const maxBufferSize = validateMaxBufferSize(options?.maxBufferSize)
  let buffer: Uint8Array | undefined
  let position = 0
  let fieldLength = -1
  let discardTrailingNewline = false

  /** Consumes one chunk, emitting every complete line it finishes. */
  return async function parseLine(chunk: Uint8Array): Promise<void> {
    if (buffer) {
      buffer = concatUint8Array(buffer, chunk)
    } else {
      buffer = chunk
      position = 0
      fieldLength = -1
    }

    const bufferLength = buffer.length
    let lineStart = 0

    while (position < bufferLength) {
      if (discardTrailingNewline) {
        if (buffer[position] === newline) lineStart = ++position
        discardTrailingNewline = false
      }

      let lineEnd = -1
      for (; position < bufferLength && lineEnd === -1; ++position) {
        const current = buffer[position]
        if (current === colon) {
          if (fieldLength === -1) fieldLength = position - lineStart
        } else if (current === carriageReturn) {
          discardTrailingNewline = true
          lineEnd = position
        } else if (current === newline) {
          lineEnd = position
        }
      }

      if (lineEnd === -1) break
      if (maxBufferSize !== undefined && lineEnd - lineStart > maxBufferSize) {
        throw new SSEParserLimitError()
      }

      const currentFieldLength =
        fieldLength === -1 && lineEnd > lineStart ? lineEnd - lineStart : fieldLength
      await onLine(buffer.subarray(lineStart, lineEnd), currentFieldLength)
      lineStart = position
      fieldLength = -1
    }

    if (lineStart === bufferLength) {
      buffer = undefined
    } else if (lineStart !== 0) {
      buffer = buffer.subarray(lineStart)
      position -= lineStart
    }

    if (maxBufferSize !== undefined && buffer && buffer.length > maxBufferSize) {
      throw new SSEParserLimitError()
    }
  }
}

/** Configures the data-buffer ceiling for one message parser. */
export interface MessageParserOptions {
  readonly maxBufferSize?: number
}

/** Assembles SSE lines into messages and reports id and retry fields. */
export function createMessageParser(
  onId: (id: string) => void,
  onRetry: (retry: number) => void,
  onMessage?: (message: EventStreamMessage) => void | Promise<void>,
  options?: MessageParserOptions
): (line: Uint8Array, fieldLength: number) => Promise<void> {
  const maxBufferSize = validateMaxBufferSize(options?.maxBufferSize)
  let lastEventId = ""
  let event = ""
  let data = ""
  let dataBytes = 0
  let hasData = false
  const decoder = new TextDecoder()

  /** Consumes one line, emitting a message when a blank line dispatch arrives. */
  return async function parseMessage(line: Uint8Array, fieldLength: number): Promise<void> {
    if (line.length === 0) {
      const message = hasData
        ? Object.freeze({
            id: lastEventId,
            event,
            data: data.slice(0, -1)
          })
        : undefined
      event = ""
      data = ""
      dataBytes = 0
      hasData = false
      if (message) await onMessage?.(message)
      return
    }

    const hasColon = fieldLength < line.length && line[fieldLength] === colon
    const field = decoder.decode(line.subarray(0, fieldLength))
    let valueOffset = hasColon ? fieldLength + 1 : line.length
    if (hasColon && line[valueOffset] === space) valueOffset += 1
    const valueBytes = line.subarray(valueOffset)
    const value = decoder.decode(valueBytes)

    if (field === "data") {
      dataBytes += valueBytes.byteLength + 1
      if (maxBufferSize !== undefined && dataBytes > maxBufferSize) throw new SSEParserLimitError()
      hasData = true
      data += `${value}\n`
      return
    }
    if (field === "event") {
      event = value
      return
    }
    if (field === "id") {
      if (!value.includes("\0")) {
        lastEventId = value
        onId(value)
      }
      return
    }
    if (field === "retry" && /^\d+$/.test(value)) {
      onRetry(Math.min(Number(value), 2_147_483_647))
    }
  }
}

/** Accepts a missing ceiling or one positive safe integer. */
function validateMaxBufferSize(maxBufferSize: number | undefined): number | undefined {
  if (maxBufferSize === undefined) return undefined
  if (!Number.isSafeInteger(maxBufferSize) || maxBufferSize < 1) {
    throw new TypeError("SSE maxBufferSize must be a positive safe integer")
  }
  return maxBufferSize
}

/** Copies two byte chunks into one contiguous buffer. */
function concatUint8Array(left: Uint8Array, right: Uint8Array): Uint8Array {
  const buffer = new Uint8Array(left.length + right.length)
  buffer.set(left)
  buffer.set(right, left.length)
  return buffer
}
