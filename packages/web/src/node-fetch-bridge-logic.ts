export interface BufferedBodySnapshot {
  readonly complete: boolean
  readonly canRead: boolean
  readonly readableEncoding: BufferEncoding | null
  readonly readableDidRead: boolean
  readonly readableLength: number
  readonly bufferedLengthBeforeDisconnect: number | undefined
  readonly cached: Buffer | Error | undefined
  readonly errored: Error | undefined
  readonly contentLength: string | string[] | undefined
}

export const byteExactEncodings = new Set(["latin1", "binary", "hex", "base64", "base64url"])

export function isByteExactEncoding(encoding: BufferEncoding | null): boolean {
  return encoding === null || byteExactEncodings.has(encoding)
}

export function isRecoverableBufferedBody(snapshot: BufferedBodySnapshot): boolean {
  return snapshot.complete && snapshot.canRead && isByteExactEncoding(snapshot.readableEncoding)
}

export function bufferedLengthBeforeDisconnect(
  snapshot: BufferedBodySnapshot,
  existing: number | undefined
): number | undefined {
  if (snapshot.readableDidRead || !isRecoverableBufferedBody(snapshot)) return existing
  return existing ?? snapshot.readableLength
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined
  const code = (error as { readonly code?: unknown }).code
  return typeof code === "string" ? code : undefined
}

function newBodyUnusableError(): TypeError {
  return new TypeError("Body is unusable")
}

function toBufferChunk(chunk: Buffer | string, encoding: BufferEncoding | null): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding ?? "utf8")
}

export function resolveBufferedBody(
  snapshot: BufferedBodySnapshot,
  chunks: Buffer[] | undefined,
  readChunk: () => Buffer | string | null
): Buffer | Error | undefined {
  if ((snapshot.readableDidRead && !chunks) || !isRecoverableBufferedBody(snapshot))
    return undefined
  if (snapshot.cached !== undefined) return snapshot.cached
  let result: Buffer | Error
  const errored = snapshot.errored
  if (errored && errorCode(errored) !== "ECONNRESET") {
    result = errored
  } else if (
    snapshot.bufferedLengthBeforeDisconnect !== undefined &&
    snapshot.readableLength !== snapshot.bufferedLengthBeforeDisconnect
  ) {
    result = newBodyUnusableError()
  } else {
    const bodyChunks = chunks ?? []
    const chunk = readChunk()
    if (chunk !== null) bodyChunks.push(toBufferChunk(chunk, snapshot.readableEncoding))
    const buffer = bodyChunks.length === 1 ? (bodyChunks[0] as Buffer) : Buffer.concat(bodyChunks)
    result = buffer
    const contentLength = snapshot.contentLength
    if (typeof contentLength === "string" && /^\d+$/.test(contentLength)) {
      const expectedLength = Number(contentLength)
      if (Number.isSafeInteger(expectedLength) && buffer.length !== expectedLength)
        result = newBodyUnusableError()
    }
  }
  return result
}

export function enqueueBufferedBody(
  controller: ReadableStreamDefaultController<Uint8Array>,
  buffered: Buffer | Error
): void {
  if (buffered instanceof Error) {
    controller.error(buffered)
    return
  }
  if (buffered.length > 0) controller.enqueue(buffered)
  controller.close()
}

export async function pullIncomingBody(
  controller: ReadableStreamDefaultController<Uint8Array>,
  buffered: Buffer | Error | undefined,
  read: () => ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>
): Promise<void> {
  try {
    if (buffered !== undefined) {
      enqueueBufferedBody(controller, buffered)
      return
    }
    const { done, value } = await read()
    if (done) controller.close()
    else controller.enqueue(value)
  } catch (error) {
    controller.error(error)
  }
}

export function resolveDirectPrebufferedBody(
  buffered: Buffer | Error | undefined
): Promise<Buffer> | undefined {
  if (buffered === undefined) return undefined
  return buffered instanceof Error ? Promise.reject(buffered) : Promise.resolve(buffered)
}

export function createDrainByteCounter(
  maxBytes: number,
  forceClose: () => void
): (chunk: { readonly length: number }) => void {
  let bytesRead = 0
  return (chunk) => {
    bytesRead += chunk.length
    if (bytesRead > maxBytes) forceClose()
  }
}

export function normalizeIncomingMethod(method: string | undefined): string {
  if (typeof method !== "string" || method.length === 0) return "GET"
  switch (method) {
    case "DELETE":
    case "GET":
    case "HEAD":
    case "OPTIONS":
    case "PATCH":
    case "POST":
    case "PUT":
    case "QUERY":
      return method
  }
  const upper = method.toUpperCase()
  switch (upper) {
    case "DELETE":
    case "GET":
    case "HEAD":
    case "OPTIONS":
    case "POST":
    case "PUT":
      return upper
    default:
      return method
  }
}

const methodTokenRegExp = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

export function validateDirectReadMethod(method: string): TypeError | undefined {
  if (!methodTokenRegExp.test(method))
    return new TypeError(`'${method}' is not a valid HTTP method.`)
  const normalized = method.toUpperCase()
  if (
    normalized === "CONNECT" ||
    normalized === "TRACK" ||
    (normalized === "TRACE" && method !== "TRACE")
  ) {
    return new TypeError(`'${method}' HTTP method is unsupported.`)
  }
  return undefined
}

export function normalizeAbortError(incomingError: Error | undefined, reason: unknown): Error {
  if (incomingError) return incomingError
  if (reason !== undefined) return reason instanceof Error ? reason : new Error(String(reason))
  return new Error("Client connection prematurely closed.")
}

export type BodyRecoveryDecision =
  | { readonly kind: "not-recoverable" }
  | { readonly kind: "reject"; readonly error: unknown }
  | { readonly kind: "resolve"; readonly body: Buffer }

export function decideBodyRecoveryAfterDisconnect(
  snapshot: BufferedBodySnapshot,
  error: unknown,
  resolveBody: () => Buffer | Error | undefined,
  abortReason: unknown
): BodyRecoveryDecision {
  const streamError = snapshot.errored ?? error
  if (
    !isRecoverableBufferedBody(snapshot) ||
    (streamError !== undefined && errorCode(streamError) !== "ECONNRESET")
  ) {
    return { kind: "not-recoverable" }
  }
  const recovered = resolveBody()
  if (recovered instanceof Error) return { kind: "reject", error: recovered }
  if (recovered === undefined) {
    return {
      kind: "reject",
      error: error ?? normalizeAbortError(snapshot.errored, abortReason)
    }
  }
  return { kind: "resolve", body: recovered }
}

export function settleBodyRecoveryDecision(
  decision: BodyRecoveryDecision,
  finish: () => boolean,
  resolve: (body: Buffer) => void,
  reject: (error: unknown) => void
): boolean {
  if (decision.kind === "not-recoverable") return false
  if (!finish()) return true
  if (decision.kind === "reject") reject(decision.error)
  else resolve(decision.body)
  return true
}

export function isPrematureCloseError(error: unknown): boolean {
  return errorCode(error) === "ERR_STREAM_PREMATURE_CLOSE"
}
