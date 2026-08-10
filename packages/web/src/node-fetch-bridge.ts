/*
 * Fetch <-> node:http protocol bridge, vendored in-tree so `@go-like/web` carries zero
 * third-party runtime dependencies for its Node host.
 *
 * Adapted from @hono/node-server 2.0.12 (MIT License; https://github.com/honojs/node-server).
 * Copyright (c) 2022 - present, Yusuke Wada and Hono contributors.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this
 * software and associated documentation files (the "Software"), to deal in the Software
 * without restriction, including without limitation the rights to use, copy, modify,
 * merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so, subject to the following
 * conditions: the above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS",
 * WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
 * WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
 * NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR
 * OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
 * OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 * go-like's Node host (`createNativeServer` in node-server.ts) only ever calls
 * `createAdaptorServer({ fetch, hostname })` with a plain `node:http` server. Compared to
 * upstream, this port intentionally drops:
 *  - WebSocket upgrade handling (`options.websocket`) - go-like's `NodeServerOptions` has
 *    no such capability.
 *  - HTTP/2 request support (`Http2ServerRequest` branches) - unreachable because go-like
 *    never supplies a custom `createServer`/`serverOptions` factory.
 *  - The `serve()` convenience helper and `options.errorHandler` - go-like manages
 *    `.listen()`/`.close()` itself and has no error-handler override.
 *  - Global `Request`/`Response` override (`overrideGlobalObjects`) - go-like always
 *    disables it, which also makes the upstream cached-`Response` fast path unreachable
 *    dead code, so that wrapper class is omitted entirely.
 * Everything else (lazy Request materialization, buffered-body recovery after a client
 * disconnect, streaming body writes, header/content-length handling) is preserved
 * behavior-for-behavior from upstream.
 */

import {
  createServer,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse
} from "node:http"
import { Readable } from "node:stream"
import {
  bufferedLengthBeforeDisconnect,
  createDrainByteCounter,
  decideBodyRecoveryAfterDisconnect,
  isPrematureCloseError,
  normalizeIncomingMethod as normalizeIncomingMethodFromLogic,
  pullIncomingBody,
  resolveDirectPrebufferedBody,
  resolveBufferedBody,
  settleBodyRecoveryDecision,
  validateDirectReadMethod,
  type BufferedBodySnapshot
} from "./node-fetch-bridge-logic"

/** Native Node HTTP server returned by {@link createAdaptorServer}. */
export type ServerType = Server

const defaultContentType = "text/plain; charset=UTF-8"

class RequestError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "RequestError"
  }
}

function toRequestError(e: unknown): RequestError {
  if (e instanceof RequestError) return e
  return new RequestError(e instanceof Error ? e.message : String(e), { cause: e })
}

// ---- URL construction --------------------------------------------------------------

const reValidRequestUrl = /^\/[!#$&-;=?-\[\]_a-z~]*$/
const reDotSegment = /\/\.\.?(?:[/?#]|$)/
const reValidHost = /^[a-z0-9._-]+(?::(?:[1-5]\d{3,4}|[6-9]\d{3}))?$/

function buildUrl(scheme: string, host: string, incomingUrl: string): string {
  const url = `${scheme}://${host}${incomingUrl}`
  if (!reValidHost.test(host)) {
    const urlObj = new URL(url)
    if (
      urlObj.hostname.length !== host.length &&
      urlObj.hostname !== (host.includes(":") ? host.replace(/:\d+$/, "") : host).toLowerCase()
    ) {
      throw new RequestError("Invalid host header")
    }
    return urlObj.href
  }
  if (incomingUrl.length === 0) return url + "/"
  if (incomingUrl.charCodeAt(0) !== 47) throw new RequestError("Invalid URL")
  if (!reValidRequestUrl.test(incomingUrl) || reDotSegment.test(incomingUrl))
    return new URL(url).href
  return url
}

// ---- Lightweight Request wrapper ----------------------------------------------------

const incomingKey: unique symbol = Symbol("incoming")
const urlKey: unique symbol = Symbol("url")
const methodKey: unique symbol = Symbol("method")
const headersKey: unique symbol = Symbol("headers")
const abortControllerKey: unique symbol = Symbol("abortController")
const requestCacheKey: unique symbol = Symbol("requestCache")
const getRequestCacheKey: unique symbol = Symbol("getRequestCache")
const getAbortControllerKey: unique symbol = Symbol("getAbortController")
const abortRequestKey: unique symbol = Symbol("abortRequest")
const bodyBufferKey: unique symbol = Symbol("bodyBuffer")
const bodyReadPromiseKey: unique symbol = Symbol("bodyReadPromise")
const bodyConsumedDirectlyKey: unique symbol = Symbol("bodyConsumedDirectly")
const bodyLockReaderKey: unique symbol = Symbol("bodyLockReader")
const abortReasonKey: unique symbol = Symbol("abortReason")
const bodyBufferedBeforeDisconnectKey: unique symbol = Symbol("bodyBufferedBeforeDisconnect")
const bodyBufferedLengthBeforeDisconnectKey: unique symbol = Symbol(
  "bodyBufferedLengthBeforeDisconnect"
)

interface IncomingWithRecovery extends IncomingMessage {
  [bodyBufferedBeforeDisconnectKey]?: Buffer | Error
  [bodyBufferedLengthBeforeDisconnectKey]?: number | undefined
}

const GlobalRequest = globalThis.Request

/** Materializes the real, spec-compliant Request only when something needs it. */
class BridgeRequest extends GlobalRequest {
  constructor(input: BridgeRequestView | string | URL, init?: RequestInit & { duplex?: "half" }) {
    if (typeof input === "object" && input !== null && getRequestCacheKey in input) {
      const source = input
      const hasReplacementBody = init !== undefined && "body" in init && init.body != null
      if (source[bodyConsumedDirectlyKey] === true && !hasReplacementBody) {
        throw new TypeError(
          "Cannot construct a Request with a Request object that has already been used."
        )
      }
      input = source[getRequestCacheKey]() as unknown as BridgeRequestView
    }
    if (
      init !== undefined &&
      typeof (init.body as ReadableStream | null | undefined)?.getReader !== "undefined"
    ) {
      init.duplex ??= "half"
    }
    super(input as unknown as string | URL | Request, init)
  }
}

function newHeadersFromIncoming(incoming: IncomingMessage): Headers {
  const headerRecord: [string, string][] = []
  const rawHeaders = incoming.rawHeaders
  for (let i = 0, len = rawHeaders.length; i < len; i += 2) {
    const key = rawHeaders[i] as string
    const value = rawHeaders[i + 1] as string
    if (key.charCodeAt(0) !== 58) headerRecord.push([key, value])
  }
  return new Headers(headerRecord)
}

function toBufferChunk(chunk: Buffer | string, encoding: BufferEncoding | null): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding ?? "utf8")
}

function bodyRecoverySnapshot(incoming: IncomingWithRecovery): BufferedBodySnapshot {
  return {
    complete: !!incoming.complete,
    canRead: typeof incoming.read === "function",
    readableEncoding: incoming.readableEncoding,
    readableDidRead: incoming.readableDidRead,
    readableLength: incoming.readableLength,
    bufferedLengthBeforeDisconnect: incoming[bodyBufferedLengthBeforeDisconnectKey],
    cached: incoming[bodyBufferedBeforeDisconnectKey],
    errored: incoming.errored ?? undefined,
    contentLength: incoming.headers["content-length"]
  }
}

/** Detects a complete, unread body that the plain node:http host can recover directly. */
function recordBodyBufferedBeforeDisconnect(incoming: IncomingWithRecovery): void {
  const snapshot = bodyRecoverySnapshot(incoming)
  incoming[bodyBufferedLengthBeforeDisconnectKey] = bufferedLengthBeforeDisconnect(
    snapshot,
    incoming[bodyBufferedLengthBeforeDisconnectKey]
  )
}

/** Recovers an already-fully-buffered body after ECONNRESET, verified against Content-Length. */
function readBodyBufferedBeforeDisconnect(
  incoming: IncomingWithRecovery,
  chunks?: Buffer[]
): Buffer | Error | undefined {
  const snapshot = bodyRecoverySnapshot(incoming)
  const result = resolveBufferedBody(snapshot, chunks, incoming.read.bind(incoming))
  if (result !== undefined) incoming[bodyBufferedBeforeDisconnectKey] = result
  return result
}

function newRequestFromIncoming(
  method: string,
  url: string,
  headers: Headers,
  incoming: IncomingWithRecovery,
  abortController: AbortController
): Request {
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers,
    signal: abortController.signal
  }
  if (method === "TRACE") {
    init.method = "GET"
    const req = new BridgeRequest(url, init)
    Object.defineProperty(req, "method", {
      value: "TRACE"
    })
    return req
  }
  if (!(method === "GET" || method === "HEAD")) {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    init.body = new ReadableStream({
      pull(controller) {
        const buffered = reader ? undefined : readBodyBufferedBeforeDisconnect(incoming)
        return pullIncomingBody(controller, buffered, () => {
          reader ||= (Readable.toWeb(incoming) as unknown as ReadableStream<Uint8Array>).getReader()
          return reader.read()
        })
      }
    })
  }
  return new BridgeRequest(url, init)
}

function rejectBodyUnusable<T = never>(): Promise<T> {
  return Promise.reject(new TypeError("Body is unusable"))
}

const textDecoder = new TextDecoder()

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

const normalizeIncomingMethod = normalizeIncomingMethodFromLogic

function consumeBodyDirectOnce(request: BridgeRequestView): Promise<never> | undefined {
  if (request[bodyConsumedDirectlyKey] === true) return rejectBodyUnusable()
  request[bodyConsumedDirectlyKey] = true
  return undefined
}

/** Waits for the full body, recovering an already-buffered body across a clean ECONNRESET. */
function readBodyDirect(request: BridgeRequestView): Promise<Buffer> {
  if (request[bodyBufferKey]) return Promise.resolve(request[bodyBufferKey])
  if (request[bodyReadPromiseKey]) return request[bodyReadPromiseKey]
  const incoming = request[incomingKey] as IncomingWithRecovery
  if (incoming.readableDidRead) return rejectBodyUnusable()
  const buffered = readBodyBufferedBeforeDisconnect(incoming)
  const prebuffered = resolveDirectPrebufferedBody(buffered)
  if (prebuffered) return prebuffered
  const promise = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    let settled = false
    const finish = (): boolean => {
      if (settled) return false
      settled = true
      cleanup()
      return true
    }
    const onData = (chunk: Buffer | string): void => {
      chunks.push(toBufferChunk(chunk, incoming.readableEncoding))
    }
    const onEnd = (): void => {
      if (!finish()) return
      const buffer = chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks)
      request[bodyBufferKey] = buffer
      resolve(buffer)
    }
    const onError = (error: unknown): void => {
      const decision = decideBodyRecoveryAfterDisconnect(
        bodyRecoverySnapshot(incoming),
        error,
        readBodyBufferedBeforeDisconnect.bind(undefined, incoming, chunks),
        request[abortReasonKey]
      )
      if (settleBodyRecoveryDecision(decision, finish, resolve, reject)) return
      if (finish()) reject(error)
    }
    const cleanup = (): void => {
      incoming.off("data", onData)
      incoming.off("end", onEnd)
      incoming.off("error", onError)
      request[bodyReadPromiseKey] = undefined
    }
    incoming.on("data", onData)
    incoming.on("end", onEnd)
    incoming.on("error", onError)
    queueMicrotask(() => {
      if (settled) return
      if (incoming.readableEnded) onEnd()
      else if (incoming.errored) onError(incoming.errored)
    })
  })
  request[bodyReadPromiseKey] = promise
  return promise
}

function readBodyWithFastPath<T>(
  request: BridgeRequestView,
  method: "text" | "arrayBuffer" | "blob",
  fromBuffer: (buf: Buffer, request: BridgeRequestView) => T | Promise<T>
): Promise<T> {
  if (request[bodyConsumedDirectlyKey] === true) return rejectBodyUnusable()
  const methodName = request.method
  if (methodName === "GET" || methodName === "HEAD") {
    return (request[getRequestCacheKey]()[method] as () => Promise<T>)()
  }
  const methodValidationError = validateDirectReadMethod(methodName)
  if (methodValidationError) return Promise.reject(methodValidationError)
  if (request[requestCacheKey] && methodName !== "TRACE") {
    return (request[requestCacheKey][method] as () => Promise<T>)()
  }
  const alreadyUsedRejection = consumeBodyDirectOnce(request)
  if (alreadyUsedRejection) return alreadyUsedRejection
  return readBodyDirect(request).then((buf) => {
    const result = fromBuffer(buf, request)
    request[bodyBufferKey] = undefined
    return result
  })
}

/**
 * Lazy Request view: avoids constructing a full spec Request until something needs one.
 * Its prototype chain is wired to `BridgeRequest.prototype` below, so `instanceof Request`
 * still holds even though instances are created via `new BridgeRequestView()` without ever
 * running `BridgeRequest`'s (or the native `Request`'s) constructor.
 */
class BridgeRequestView {
  declare [incomingKey]: IncomingMessage
  declare [urlKey]: string
  declare [methodKey]: string
  declare [headersKey]?: Headers
  declare [abortControllerKey]?: AbortController
  declare [requestCacheKey]?: Request
  declare [bodyBufferKey]: Buffer | undefined
  declare [bodyReadPromiseKey]: Promise<Buffer> | undefined
  declare [bodyConsumedDirectlyKey]?: boolean
  declare [bodyLockReaderKey]?: ReadableStreamDefaultReader<Uint8Array>
  declare [abortReasonKey]?: unknown

  constructor() {
    this[bodyBufferKey] = undefined
    this[bodyReadPromiseKey] = undefined
  }

  get method(): string {
    return this[methodKey]
  }

  get url(): string {
    return this[urlKey]
  }

  get headers(): Headers {
    return (this[headersKey] ??= newHeadersFromIncoming(this[incomingKey]))
  }

  get signal(): AbortSignal {
    return this[getAbortControllerKey]().signal
  }

  get cache(): string {
    return this[getRequestCacheKey]().cache
  }

  get credentials(): string {
    return this[getRequestCacheKey]().credentials
  }

  get destination(): string {
    return this[getRequestCacheKey]().destination
  }

  get integrity(): string {
    return this[getRequestCacheKey]().integrity
  }

  get mode(): string {
    return this[getRequestCacheKey]().mode
  }

  get redirect(): string {
    return this[getRequestCacheKey]().redirect
  }

  get referrer(): string {
    return this[getRequestCacheKey]().referrer
  }

  get referrerPolicy(): string {
    return this[getRequestCacheKey]().referrerPolicy
  }

  get keepalive(): boolean {
    return this[getRequestCacheKey]().keepalive
  }

  get body(): ReadableStream<Uint8Array> | null {
    if (this[bodyConsumedDirectlyKey] !== true) return this[getRequestCacheKey]().body
    const request = this[getRequestCacheKey]()
    if (!this[bodyLockReaderKey] && request.body) this[bodyLockReaderKey] = request.body.getReader()
    return request.body
  }

  get bodyUsed(): boolean {
    if (this[bodyConsumedDirectlyKey] === true) return true
    if (this[requestCacheKey]) return this[requestCacheKey].bodyUsed
    return false
  }

  [abortRequestKey](reason: unknown): void {
    if (this[abortReasonKey] === undefined) this[abortReasonKey] = reason
    const controller = this[abortControllerKey]
    if (controller && !controller.signal.aborted) controller.abort(reason)
  }

  [getAbortControllerKey](): AbortController {
    this[abortControllerKey] ??= new AbortController()
    const controller = this[abortControllerKey]
    if (this[abortReasonKey] !== undefined && !controller.signal.aborted)
      controller.abort(this[abortReasonKey])
    return controller
  }

  [getRequestCacheKey](): Request {
    const controller = this[getAbortControllerKey]()
    if (this[requestCacheKey]) return this[requestCacheKey]
    const method = this.method
    if (this[bodyConsumedDirectlyKey] === true && !(method === "GET" || method === "HEAD")) {
      this[bodyBufferKey] = undefined
      const init: RequestInit & { duplex?: "half" } = {
        method: method === "TRACE" ? "GET" : method,
        headers: this.headers,
        signal: controller.signal
      }
      if (method !== "TRACE") {
        init.body = new ReadableStream({
          start(c) {
            c.close()
          }
        })
        init.duplex = "half"
      }
      const req = new BridgeRequest(this[urlKey], init) as unknown as Request
      if (method === "TRACE") {
        Object.defineProperty(req, "method", {
          value: "TRACE"
        })
      }
      this[requestCacheKey] = req
      return req
    }
    const req = newRequestFromIncoming(
      this.method,
      this[urlKey],
      this.headers,
      this[incomingKey],
      controller
    )
    this[requestCacheKey] = req
    return req
  }

  clone(): Request {
    if (this[bodyConsumedDirectlyKey] === true) throw new TypeError("Body is unusable")
    return this[getRequestCacheKey]().clone()
  }

  formData(): Promise<FormData> {
    if (this[bodyConsumedDirectlyKey] === true) return rejectBodyUnusable()
    return this[getRequestCacheKey]().formData()
  }

  text(): Promise<string> {
    return readBodyWithFastPath(this, "text", (buf) => textDecoder.decode(buf))
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    return readBodyWithFastPath(this, "arrayBuffer", (buf) => toArrayBuffer(buf))
  }

  blob(): Promise<Blob> {
    return readBodyWithFastPath(this, "blob", (buf, request) => {
      const type = request.headers.get("content-type") || ""
      const init = type ? { headers: { "content-type": type } } : undefined
      return new Response(buf as unknown as BodyInit, init).blob()
    })
  }

  json(): Promise<unknown> {
    if (this[bodyConsumedDirectlyKey] === true) return rejectBodyUnusable()
    return this.text().then((text) => JSON.parse(text))
  }

  [Symbol.for("nodejs.util.inspect.custom")](
    depth: number | null,
    options: object,
    inspect: (value: unknown, options: object) => string
  ): string {
    return `Request (lightweight) ${inspect(
      {
        method: this.method,
        url: this.url,
        headers: this.headers,
        nativeRequest: this[requestCacheKey]
      },
      { ...options, depth: depth == null ? null : depth - 1 }
    )}`
  }
}

Object.setPrototypeOf(BridgeRequestView.prototype, BridgeRequest.prototype)

function newRequest(incoming: IncomingMessage, defaultHostname: string | undefined): Request {
  const req = new BridgeRequestView()
  req[incomingKey] = incoming
  req[methodKey] = normalizeIncomingMethod(incoming.method)
  const incomingUrl = incoming.url || ""
  if (
    incomingUrl[0] !== "/" &&
    (incomingUrl.startsWith("http://") || incomingUrl.startsWith("https://"))
  ) {
    try {
      req[urlKey] = new URL(incomingUrl).href
    } catch (e) {
      throw new RequestError("Invalid absolute URL", { cause: e })
    }
    return req as unknown as Request
  }
  const host = incoming.headers.host || defaultHostname
  if (!host) throw new RequestError("Missing host header")
  const socket = incoming.socket as { encrypted?: boolean } | null
  const scheme = socket?.encrypted === true ? "https" : "http"
  try {
    req[urlKey] = buildUrl(scheme, host, incomingUrl)
  } catch (e) {
    if (e instanceof RequestError) throw e
    throw new RequestError("Invalid URL", { cause: e })
  }
  return req as unknown as Request
}

// ---- Response streaming --------------------------------------------------------------

type StreamReadResult<T> = Awaited<ReturnType<ReadableStreamDefaultReader<T>["read"]>>

async function readWithoutBlocking<T>(readPromise: Promise<T>): Promise<T | undefined> {
  return Promise.race([readPromise, Promise.resolve().then(() => Promise.resolve(undefined))])
}

function writeFromReadableStreamDefaultReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  writable: ServerResponse,
  currentReadPromise?: Promise<StreamReadResult<Uint8Array>>
): Promise<void> {
  let cancelled = false
  const cancel = (error?: unknown): void => {
    if (cancelled) return
    cancelled = true
    reader.cancel(error).then(undefined, String)
  }
  writable.on("close", cancel)
  writable.on("error", cancel)
  writable.socket?.on("close", cancel)
  const handleStreamError = (error: unknown): void => {
    if (error) writable.destroy(error as Error)
  }
  const onDrain = (): void => {
    reader.read().then(flow, handleStreamError)
  }
  function flow({ done, value }: StreamReadResult<Uint8Array>): Promise<void> | void {
    if (done) writable.end()
    else if (!writable.write(value)) writable.once("drain", onDrain)
    else return reader.read().then(flow, handleStreamError)
  }
  ;(currentReadPromise ?? reader.read()).then(flow, handleStreamError)
  return reader.closed.finally(() => {
    writable.off("close", cancel)
    writable.off("error", cancel)
    writable.socket?.off("close", cancel)
  })
}

function buildOutgoingHttpHeaders(
  headers: Headers | HeadersInit | undefined,
  defaultType?: string
): OutgoingHttpHeaders {
  const res: OutgoingHttpHeaders = {}
  const realHeaders = headers instanceof Headers ? headers : new Headers(headers ?? undefined)
  if (realHeaders.has("set-cookie")) {
    const cookies: string[] = []
    for (const [k, v] of realHeaders) {
      if (k === "set-cookie") cookies.push(v)
      else res[k] = v
    }
    if (cookies.length > 0) res["set-cookie"] = cookies
  } else {
    for (const [k, v] of realHeaders) res[k] = v
  }
  if (defaultType) res["content-type"] ??= defaultType
  return res
}

// ---- Listener glue --------------------------------------------------------------------

const incomingDrainingKey: unique symbol = Symbol("incomingDraining")
const DRAIN_TIMEOUT_MS = 500
const MAX_DRAIN_BYTES = 64 * 1024 * 1024

interface IncomingWithDrainState extends IncomingMessage {
  [incomingDrainingKey]?: boolean
}

/** Drains (or force-closes) an unconsumed request body so the socket stays reusable. */
function drainIncoming(incoming: IncomingMessage): void {
  const incomingWithDrainState = incoming as IncomingWithDrainState
  if (incoming.destroyed || incomingWithDrainState[incomingDrainingKey]) return
  incomingWithDrainState[incomingDrainingKey] = true
  const cleanup = (): void => {
    clearTimeout(timer)
    incoming.off("data", onData)
    incoming.off("end", onEnd)
    incoming.off("error", cleanup)
  }
  const forceClose = (): void => {
    cleanup()
    const socket = incoming.socket
    if (!socket.destroyed) (socket.destroySoon ?? socket.destroy).call(socket)
  }
  const timer = setTimeout(forceClose, DRAIN_TIMEOUT_MS)
  timer.unref?.()
  const onData = createDrainByteCounter(MAX_DRAIN_BYTES, forceClose)
  const onEnd = (): void => {
    const contentLength = incoming.headers["content-length"]
    if (incoming.readableDidRead || contentLength === undefined || contentLength === "0") cleanup()
  }
  incoming.on("data", onData)
  incoming.on("end", onEnd)
  incoming.on("error", cleanup)
  incoming.resume()
}

function makeCloseHandler(
  req: BridgeRequestView,
  incoming: IncomingWithRecovery,
  outgoing: ServerResponse
): () => void {
  let handled = false
  return () => {
    if (handled) return
    handled = true
    recordBodyBufferedBeforeDisconnect(incoming)
    if (incoming.errored) {
      req[abortRequestKey](incoming.errored.toString())
    } else if (!outgoing.writableFinished) {
      req[abortRequestKey]("Client connection prematurely closed.")
    }
  }
}

function handleRequestError(): Response {
  return new Response(null, { status: 400 })
}

function handleFetchError(e: unknown): Response {
  const isTimeout =
    e instanceof Error && (e.name === "TimeoutError" || e.constructor.name === "TimeoutError")
  return new Response(null, { status: isTimeout ? 504 : 500 })
}

function handleResponseError(e: unknown, outgoing: ServerResponse): void {
  const err = e instanceof Error ? e : new Error("unknown error", { cause: e })
  if (isPrematureCloseError(err)) {
    console.info("The user aborted a request.")
    return
  }
  console.error(e)
  if (!outgoing.headersSent) outgoing.writeHead(500, { "Content-Type": "text/plain" })
  outgoing.end(`Error: ${err.message}`)
  outgoing.destroy(err)
}

function flushHeaders(outgoing: ServerResponse): void {
  if ("flushHeaders" in outgoing && outgoing.writable) outgoing.flushHeaders()
}

function isPromise(res: Response | Promise<Response>): res is Promise<Response> {
  return typeof (res as Promise<Response>).then === "function"
}

async function responseViaResponseObject(
  res: Response | Promise<Response>,
  outgoing: ServerResponse
): Promise<void> {
  const resolved = isPromise(res) ? await res.catch(handleFetchError) : res
  const resHeaderRecord = buildOutgoingHttpHeaders(
    resolved.headers,
    resolved.body === null ? undefined : defaultContentType
  )
  if (resolved.body) {
    const reader = resolved.body.getReader()
    const values: Uint8Array[] = []
    let done = false
    let currentReadPromise: Promise<StreamReadResult<Uint8Array>> | undefined = undefined
    if (resHeaderRecord["transfer-encoding"] !== "chunked") {
      let maxReadCount = 2
      for (let i = 0; i < maxReadCount; i++) {
        currentReadPromise ||= reader.read()
        const chunk = await readWithoutBlocking(currentReadPromise).catch((e) => {
          console.error(e)
          done = true
          return undefined
        })
        if (!chunk) {
          if (i === 1) {
            await new Promise<void>((resolve) => setTimeout(resolve))
            maxReadCount = 3
            continue
          }
          break
        }
        currentReadPromise = undefined
        if (chunk.value) values.push(chunk.value)
        if (chunk.done) {
          done = true
          break
        }
      }
      if (done && !("content-length" in resHeaderRecord)) {
        resHeaderRecord["content-length"] = values.reduce((acc, value) => acc + value.length, 0)
      }
    }
    outgoing.writeHead(resolved.status, resHeaderRecord)
    values.forEach((value) => {
      outgoing.write(value)
    })
    if (done) {
      outgoing.end()
    } else {
      if (values.length === 0) flushHeaders(outgoing)
      await writeFromReadableStreamDefaultReader(reader, outgoing, currentReadPromise)?.catch((e) =>
        handleResponseError(e, outgoing)
      )
    }
  } else {
    outgoing.writeHead(resolved.status, resHeaderRecord)
    outgoing.end()
  }
}

function getRequestListener(
  fetchCallback: (request: Request) => Response | Promise<Response>,
  hostname: string | undefined
): (incoming: IncomingMessage, outgoing: ServerResponse) => Promise<void> {
  return async (incoming, outgoing) => {
    let res: Response | Promise<Response> | undefined
    let req: BridgeRequestView | undefined
    const needsBodyCleanup = !(incoming.method === "GET" || incoming.method === "HEAD")
    let detachCloseHandlers: (() => void) | undefined
    try {
      req = newRequest(incoming, hostname) as unknown as BridgeRequestView
      res = fetchCallback(req as unknown as Request)
    } catch (e) {
      res = req === undefined ? handleRequestError() : handleFetchError(toRequestError(e))
    }
    if (req) {
      const closeHandler = makeCloseHandler(req, incoming as IncomingWithRecovery, outgoing)
      const socket = incoming.socket
      const detach = (): void => {
        outgoing.off("close", onClose)
        socket.off("close", onClose)
      }
      const onClose = (): void => {
        detach()
        closeHandler()
      }
      detachCloseHandlers = detach
      outgoing.on("close", onClose)
      socket.on("close", onClose)
    }
    outgoing.once("finish", () => {
      detachCloseHandlers?.()
      if (needsBodyCleanup && !incoming.readableEnded) drainIncoming(incoming)
    })
    try {
      return await responseViaResponseObject(res, outgoing)
    } catch (e) {
      return handleResponseError(e, outgoing)
    }
  }
}

// ---- Public factory ---------------------------------------------------------------------

export interface AdaptorServerOptions {
  /** Exact one-argument Fetch handler invoked for every incoming request. */
  readonly fetch: (request: Request) => Response | Promise<Response>
  /** Hostname used to build the request URL when the Host header is absent. */
  readonly hostname?: string
}

/** Creates one unlistened native `node:http` server bridging Fetch Request/Response. */
export function createAdaptorServer(options: AdaptorServerOptions): ServerType {
  const requestListener = getRequestListener(options.fetch, options.hostname)
  return createServer({}, requestListener)
}
