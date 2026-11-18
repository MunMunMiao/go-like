import { cause, type Context } from "../context"
import { waitForContext } from "../context"
import { isError, toError } from "../internal/errors"

import type { Fetch } from "./types"

const secretTransportError = Object.freeze(new Error("fetch transport failed"))

/** HTTP methods a backend client may send. */
export type FetchMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE"

/** One backend request. `Operation` is copied into every error. */
export interface FetchRequest<Operation extends string> {
  /** Bounded operation name, copied into every error. */
  readonly operation: Operation
  readonly method: FetchMethod
  /** Absolute path with already percent-encoded segments, resolved against the client origin. */
  readonly path: string
  readonly query?: Readonly<Record<string, string>>
  /** Accept header. Default "application/json". */
  readonly accept?: string
  /** Serialized with JSON.stringify and sent as application/json. Mutually exclusive with body. */
  readonly json?: unknown
  /** Sent as-is with contentType. */
  readonly body?: string
  readonly contentType?: string
  /** Non-2xx statuses returned to the caller instead of becoming errors.http. */
  readonly allow?: readonly number[]
}

/** Backend-owned error constructors. Each plug keeps its own names and codes. */
export interface FetchErrors<Operation extends string> {
  /** Non-2xx status that is not allowed. `body` is the first errorBodyBytes, or null when unread. */
  http(operation: Operation, status: number, body: string | null): Error
  /** Fetch or body-read rejection while ctx is active. */
  transport(operation: Operation, cause: Error): Error
  /** Malformed response: not a Response, invalid JSON, invalid UTF-8, or a frame above the bound. */
  protocol(operation: Operation): Error
}

/** Options for one Fetch client. */
export interface FetchClientOptions<Operation extends string> {
  readonly fetch: Fetch
  /** From parseOrigin. */
  readonly origin: URL
  /** Sets credential headers on each Request immediately before fetch. */
  readonly authorize?: (headers: Headers) => void
  /** True when authorize adds a secret: transport causes are replaced by a fixed Error. */
  readonly secret: boolean
  readonly errors: FetchErrors<Operation>
  /** Bytes of a failed body retained for errors.http. Integer 0..65536. Default 0. */
  readonly errorBodyBytes?: number
}

/** Result of FetchClient.text. */
export interface FetchText {
  readonly status: number
  readonly headers: Headers
  /** Empty for an allowed non-2xx status, whose body is cancelled unread. */
  readonly text: string
}

/** Result of FetchClient.json. */
export interface FetchJson {
  readonly status: number
  readonly headers: Headers
  /** Null for an allowed non-2xx status. */
  readonly value: unknown
}

/** Options for FetchClient.frames. */
export interface FrameOptions {
  /** Bound of one newline-delimited frame in bytes. Default 1048576. */
  readonly maxFrameBytes?: number
}

/** Newline-delimited frame stream. The request Context limits the whole stream. */
export interface FrameReader {
  readonly status: number
  readonly headers: Headers
  /** Next frame without its newline. Null at a clean end. `ctx` bounds only this read. */
  next(ctx: Context): Promise<string | null>
  /** Cancels the body. Idempotent. */
  close(): void
}

/** Backend protocol client over an injected Fetch. */
export interface FetchClient<Operation extends string> {
  /** Resolves for 2xx and allowed statuses with the body unread. */
  send(ctx: Context, request: FetchRequest<Operation>): Promise<Response>
  text(ctx: Context, request: FetchRequest<Operation>): Promise<FetchText>
  json(ctx: Context, request: FetchRequest<Operation>): Promise<FetchJson>
  frames(
    ctx: Context,
    request: FetchRequest<Operation>,
    options?: FrameOptions
  ): Promise<FrameReader>
}

const methods = new Set<FetchMethod>(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"])

/**
 * Parses an http or https origin. Credentials, path, query, and fragment are rejected.
 * The TypeError names `label` and never echoes the input.
 */
export function parseOrigin(address: string, label: string): URL {
  if (typeof label !== "string" || label.length === 0) {
    throw new TypeError("origin label must be a non-empty string")
  }
  let url: URL
  try {
    url = new URL(address)
  } catch {
    throw new TypeError(`${label} origin must be an http or https URL`)
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username.length !== 0 ||
    url.password.length !== 0 ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search.length !== 0 ||
    url.hash.length !== 0
  ) {
    throw new TypeError(`${label} origin must be an http or https URL without extra parts`)
  }
  return new URL(url.origin)
}

/**
 * Validates a header value: non-empty, no CR or LF, and acceptable to Headers.set.
 * The TypeError names `label` and `header` and never echoes the value.
 */
export function headerValue(value: string, header: string, label: string): string {
  if (typeof label !== "string" || label.length === 0 || typeof header !== "string") {
    throw new TypeError("header label must be a non-empty string")
  }
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\r") ||
    value.includes("\n")
  ) {
    throw new TypeError(`${label} ${header} must be a header value`)
  }
  try {
    new Headers().set(header, value)
  } catch {
    throw new TypeError(`${label} ${header} must be a header value`)
  }
  return value
}

/** True for 408, 425, 429, and 500..599. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599)
}

/** Creates a Fetch client. Invalid options throw before any I/O. */
export function newFetchClient<Operation extends string>(
  options: FetchClientOptions<Operation>
): FetchClient<Operation> {
  if (typeof options.fetch !== "function") throw new TypeError("fetch must be a function")
  if (!(options.origin instanceof URL)) throw new TypeError("origin must be a URL")
  if (options.origin.protocol !== "http:" && options.origin.protocol !== "https:") {
    throw new TypeError("origin must be an http or https URL")
  }
  if (typeof options.secret !== "boolean") throw new TypeError("secret must be a boolean")
  if (options.authorize !== undefined && typeof options.authorize !== "function") {
    throw new TypeError("authorize must be a function")
  }
  const errors = options.errors
  if (
    errors === null ||
    typeof errors !== "object" ||
    typeof errors.http !== "function" ||
    typeof errors.transport !== "function" ||
    typeof errors.protocol !== "function"
  ) {
    throw new TypeError("errors must provide http, transport, and protocol")
  }
  const errorBodyBytes = options.errorBodyBytes ?? 0
  if (!Number.isSafeInteger(errorBodyBytes) || errorBodyBytes < 0 || errorBodyBytes > 65_536) {
    throw new RangeError("errorBodyBytes must be an integer from 0 through 65536")
  }
  const origin = options.origin
  const secret = options.secret
  const authorize = options.authorize
  const fetchImpl = options.fetch

  /** Maps an active-context transport failure, replacing the cause when the client is secret. */
  function transportFailure(operation: Operation, error: unknown): Error {
    const causeError = secret
      ? secretTransportError
      : isError(error)
        ? error
        : toError(error, "fetch transport failed")
    return errors.transport(operation, causeError)
  }

  /** Prefers the Context failure when the caller ended before the operation. */
  function callerFailure(ctx: Context, error: unknown, operation: Operation): Error {
    if (ctx.err() !== null) return cause(ctx) ?? ctx.err() ?? canceledFallback()
    return transportFailure(operation, error)
  }

  /** Sends one request. 2xx and allowed statuses leave the body unread. */
  async function send(ctx: Context, request: FetchRequest<Operation>): Promise<Response> {
    const ended = cause(ctx)
    if (ended !== null) throw ended
    const httpRequest = buildRequest(origin, request, authorize, ctx.done())
    let response: Response
    try {
      response = await waitForContext(ctx, Promise.resolve(fetchImpl(httpRequest)))
    } catch (error) {
      throw callerFailure(ctx, error, request.operation)
    }
    if (!(response instanceof Response)) throw errors.protocol(request.operation)
    if (response.ok || allowed(request, response.status)) return response
    const body = await errorBody(ctx, response, errorBodyBytes, request.operation)
    throw errors.http(request.operation, response.status, body)
  }

  return {
    send,
    /** Reads a 2xx body as text. An allowed non-2xx body is cancelled. */
    async text(ctx: Context, request: FetchRequest<Operation>): Promise<FetchText> {
      const response = await send(ctx, request)
      if (!response.ok) {
        await cancelBody(response)
        return { status: response.status, headers: response.headers, text: "" }
      }
      try {
        const text = await readUtf8(ctx, response)
        return { status: response.status, headers: response.headers, text }
      } catch (error) {
        if (ctx.err() !== null) throw cause(ctx) ?? ctx.err() ?? canceledFallback()
        if (error === utf8Error) throw errors.protocol(request.operation)
        throw callerFailure(ctx, error, request.operation)
      }
    },
    /** Reads a 2xx body as JSON. An allowed non-2xx body is cancelled and value is null. */
    async json(ctx: Context, request: FetchRequest<Operation>): Promise<FetchJson> {
      const response = await send(ctx, request)
      if (!response.ok) {
        await cancelBody(response)
        return { status: response.status, headers: response.headers, value: null }
      }
      let text: string
      try {
        text = await readUtf8(ctx, response)
      } catch (error) {
        if (ctx.err() !== null) throw cause(ctx) ?? ctx.err() ?? canceledFallback()
        if (error === utf8Error) throw errors.protocol(request.operation)
        throw callerFailure(ctx, error, request.operation)
      }
      try {
        return { status: response.status, headers: response.headers, value: JSON.parse(text) }
      } catch {
        throw errors.protocol(request.operation)
      }
    },
    /** Opens a newline-delimited frame reader for a 2xx response. */
    async frames(
      ctx: Context,
      request: FetchRequest<Operation>,
      frameOptions?: FrameOptions
    ): Promise<FrameReader> {
      const maxFrameBytes = frameOptions?.maxFrameBytes ?? 1_048_576
      if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) {
        throw new RangeError("maxFrameBytes must be a positive safe integer")
      }
      const response = await send(ctx, request)
      if (!response.ok) {
        await cancelBody(response)
        throw errors.http(request.operation, response.status, null)
      }
      return newFrameReader(response, maxFrameBytes, () => errors.protocol(request.operation))
    }
  }
}

/** A stand-in used only when Context.err is null after a wait that still observed cancellation. */
function canceledFallback(): Error {
  return new Error("fetch canceled")
}

/** Builds one Request with redirect "error" and the caller signal. */
function buildRequest<Operation extends string>(
  origin: URL,
  request: FetchRequest<Operation>,
  authorize: ((headers: Headers) => void) | undefined,
  signal: AbortSignal | null
): Request {
  if (!methods.has(request.method)) throw new TypeError("fetch method must be an HTTP method")
  if (typeof request.path !== "string" || !request.path.startsWith("/")) {
    throw new TypeError("fetch path must be an absolute path")
  }
  if (request.json !== undefined && request.body !== undefined) {
    throw new TypeError("fetch json and body are mutually exclusive")
  }
  const url = new URL(request.path, origin)
  if (request.query !== undefined) {
    for (const [key, value] of Object.entries(request.query)) {
      if (typeof value !== "string") throw new TypeError("fetch query values must be strings")
      url.searchParams.set(key, value)
    }
  }
  const headers = new Headers()
  headers.set("accept", request.accept ?? "application/json")
  let body: string | undefined
  if (request.json !== undefined) {
    body = JSON.stringify(request.json)
    headers.set("content-type", "application/json")
  } else if (request.body !== undefined) {
    body = request.body
    if (request.contentType !== undefined) headers.set("content-type", request.contentType)
  }
  if (authorize !== undefined) authorize(headers)
  const omitBody = request.method === "GET" || request.method === "HEAD"
  return new Request(url, {
    method: request.method,
    headers,
    redirect: "error",
    ...(omitBody || body === undefined ? {} : { body }),
    ...(signal === undefined ? {} : { signal })
  })
}

/** Reports whether a status was listed in allow. */
function allowed<Operation extends string>(
  request: FetchRequest<Operation>,
  status: number
): boolean {
  const list = request.allow
  if (list === undefined) return false
  for (const item of list) {
    if (item === status) return true
  }
  return false
}

/** Reads up to `limit` bytes of an error body, or null when the body is discarded or unreadable. */
async function errorBody(
  ctx: Context,
  response: Response,
  limit: number,
  _operation: string
): Promise<string | null> {
  if (limit === 0 || response.body === null) {
    await cancelBody(response)
    return null
  }
  try {
    const bytes = await waitForContext(ctx, response.arrayBuffer())
    const view = new Uint8Array(bytes).subarray(0, limit)
    return new TextDecoder().decode(view)
  } catch (error) {
    if (ctx.err() !== null) throw cause(ctx) ?? ctx.err() ?? canceledFallback()
    void error
    return null
  }
}

const utf8Error = Object.freeze(new Error("invalid utf-8"))

/** Reads a response body as fatal UTF-8. Rejects with `utf8Error` when the bytes are not UTF-8. */
async function readUtf8(ctx: Context, response: Response): Promise<string> {
  const bytes = new Uint8Array(await waitForContext(ctx, response.arrayBuffer()))
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw utf8Error
  }
}

/** Cancels an unread body and ignores an already-used or missing body. */
async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    return
  }
}

/** Reads newline-delimited frames from one response body. */
function newFrameReader(
  response: Response,
  maxFrameBytes: number,
  protocol: () => Error
): FrameReader {
  const reader = response.body?.getReader() ?? null
  const decoder = new TextDecoder("utf-8", { fatal: true })
  let pending = new Uint8Array(0)
  let closed = false
  let done = reader === null

  /** Appends bytes and rejects a frame that crosses the bound before a newline. */
  function push(chunk: Uint8Array): void {
    const next = new Uint8Array(pending.length + chunk.length)
    next.set(pending)
    next.set(chunk, pending.length)
    pending = next
  }

  /** Takes one complete frame, or null when more bytes are required. */
  function take(): string | null {
    const newline = pending.indexOf(0x0a)
    if (newline < 0) {
      if (pending.length > maxFrameBytes) throw protocol()
      return null
    }
    if (newline > maxFrameBytes) throw protocol()
    const slice = pending.subarray(0, newline)
    pending = pending.subarray(newline + 1)
    const withoutReturn =
      slice.length > 0 && slice[slice.length - 1] === 0x0d ? slice.subarray(0, -1) : slice
    try {
      return decoder.decode(withoutReturn)
    } catch {
      throw protocol()
    }
  }

  return {
    status: response.status,
    headers: response.headers,
    /** Reads the next frame. Null is the clean end of the body. */
    async next(ctx: Context): Promise<string | null> {
      const ended = cause(ctx)
      if (ended !== null) throw ended
      if (closed) throw protocol()
      const ready = take()
      if (ready !== null) return ready
      if (done) {
        if (pending.length === 0) return null
        throw protocol()
      }
      if (reader === null) return null
      try {
        const chunk = await waitForContext(ctx, reader.read())
        if (chunk.done) {
          done = true
          if (pending.length === 0) return null
          throw protocol()
        }
        push(chunk.value)
      } catch (error) {
        if (ctx.err() !== null) throw cause(ctx) ?? ctx.err() ?? canceledFallback()
        throw error
      }
      return this.next(ctx)
    },
    /** Cancels the unread body. */
    close(): void {
      if (closed) return
      closed = true
      void reader?.cancel().catch(() => {})
    }
  }
}
