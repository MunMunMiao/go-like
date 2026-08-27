import {
  Agent as HTTPAgent,
  request as requestHTTP,
  type ClientRequest,
  type IncomingMessage,
  type RequestOptions
} from "node:http"
import {
  connect as connectHTTP2,
  type ClientHttp2Session,
  type ClientHttp2Stream,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders
} from "node:http2"
import { isIP, type Socket } from "node:net"
import {
  connect as connectTLS,
  type ConnectionOptions as TLSConnectionOptions,
  type TLSSocket
} from "node:tls"

import type { DialOptions, Options, TLSEncodedBytes, TLSConfig } from "@go-like/transport"

import type { HTTPDialTarget } from "./address"
import type { HTTPDialExecutorHandle } from "./transport"
import type { HTTPExecutor } from "./types"

/** Exposes the two ClientRequest operations owned by one unary exchange. */
interface HTTP1RequestHandle {
  readonly destroyed: boolean
  /** Observes request admission failure. */
  once(event: "error", listener: (error: Error) => void): void
  /** Sends the complete unary request body. */
  end(body: Uint8Array): void
  /** Releases the native request after failure or response completion. */
  destroy(error?: Error): void
}

/** Opens one native HTTP/1 request behind a deterministic runtime seam. */
interface HTTP1RequestFactory {
  /** Creates one native request handle and transfers the eventual response. */
  (
    request: Request,
    headers: Record<string, string>,
    socket: TLSSocket | null,
    received: (response: IncomingMessage) => void
  ): HTTP1RequestHandle
}

/** Opens one native HTTP/2 session around a pre-negotiated TLS socket. */
interface HTTP2SessionFactory {
  /** Creates one session that owns the supplied verified socket. */
  (origin: string, socket: TLSSocket): ClientHttp2Session
}

/** Supplies the four Node constructors needed by one deterministic client owner. */
export interface NodeHTTPClientRuntime {
  /** Creates one client-owned HTTP/1 keep-alive agent. */
  newHTTPAgent(): HTTPAgent
  /** Opens one TLS socket from validated Node options. */
  connectTLS(options: TLSConnectionOptions): TLSSocket
  /** Opens one HTTP/2 session around a verified socket. */
  connectHTTP2(origin: string, socket: TLSSocket): ClientHttp2Session
  /** Opens one HTTP/1 request from completed Node options. */
  requestHTTP(options: RequestOptions, received: (response: IncomingMessage) => void): ClientRequest
}

/** Creates the native keep-alive agent used outside deterministic tests. */
function newNativeHTTPAgent(): HTTPAgent {
  return new HTTPAgent({ keepAlive: true })
}

/** Opens the native HTTP/1 request used outside deterministic tests. */
function requestNativeHTTP1(
  options: RequestOptions,
  received: (response: IncomingMessage) => void
): ClientRequest {
  return requestHTTP(options, received)
}

const nativeHTTPClientRuntime: NodeHTTPClientRuntime = Object.freeze({
  newHTTPAgent: newNativeHTTPAgent,
  connectTLS,
  connectHTTP2: openHTTP2Session,
  requestHTTP: requestNativeHTTP1
})

/** Describes one native resource with idempotent terminal cleanup. */
interface NativeDestroyable {
  readonly destroyed: boolean
  /** Releases the native resource. */
  destroy(error?: Error): unknown
}

/** Recognizes built-in Error values across realms with a legacy-runtime fallback. */
function isError(value: unknown): value is Error {
  const candidate: unknown = Object.getOwnPropertyDescriptor(Error, "isError")?.value
  return (typeof candidate === "function" && candidate(value) === true) || value instanceof Error
}

/** Preserves native Error identity and normalizes hostile synchronous throws. */
function nativeError(value: unknown, message: string): Error {
  return isError(value) ? value : new Error(message, { cause: value })
}

/** Best-effort destroys one owned native resource without replacing a primary failure. */
function destroyNative(resource: NativeDestroyable | null, error?: Error): void {
  if (resource === null) return
  try {
    if (!resource.destroyed) resource.destroy(error)
  } catch {
    // Native cleanup failure cannot replace the exchange result.
  }
}

/** Reports whether Fetch requires this response status to omit its body. */
function bodylessStatus(status: number): boolean {
  return status === 204 || status === 205 || status === 304
}

/** Returns one Error suitable for terminating native work after Fetch cancellation. */
function abortError(signal: AbortSignal): Error {
  return nativeError(signal.reason, "HTTP request aborted")
}

/** Waits for shared owner work while one request signal remains active. */
function waitForSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal))
  return new Promise<T>(function wait(resolve, reject): void {
    let settled = false
    /** Removes the request observer after either side wins. */
    function cleanup(): void {
      signal.removeEventListener("abort", aborted)
    }
    /** Rejects only this waiter without canceling shared owner work. */
    function aborted(): void {
      if (settled) return
      settled = true
      cleanup()
      reject(abortError(signal))
    }
    signal.addEventListener("abort", aborted, { once: true })
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
    if (signal.aborted) aborted()
  })
}

/** Converts one optional PEM value into detached Node TLS bytes. */
function pem(value: TLSEncodedBytes | null, label: string): Buffer | undefined {
  if (value === null) return undefined
  if (value.encoding !== "pem") throw new TypeError(`Node HTTP ${label} must use PEM encoding`)
  return Buffer.from(value.bytes)
}

/** Returns a bracket-free hostname suitable for Node socket APIs. */
function socketHost(url: URL): string {
  return url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname
}

/** Selects an explicit TLS server name or the URL DNS hostname. */
function serverName(url: URL, config: TLSConfig | null): string | undefined {
  const configured = config?.serverName ?? null
  const hostname = socketHost(url)
  return configured === null && isIP(hostname) === 0
    ? hostname
    : configured === null
      ? undefined
      : configured
}

/** Opens one verified TLS socket and negotiates HTTP/2 before HTTP/1.1. */
function tlsOptions(
  url: URL,
  config: TLSConfig | null,
  alpn: readonly string[]
): TLSConnectionOptions {
  const certificate = pem(config?.certificateChain ?? null, "client certificate")
  const key = pem(config?.privateKey ?? null, "client private key")
  if ((certificate === undefined) !== (key === undefined)) {
    throw new TypeError("Node HTTP mTLS requires both a PEM certificate chain and private key")
  }
  return {
    host: socketHost(url),
    port: url.port === "" ? 443 : Number(url.port),
    servername: serverName(url, config),
    ca: pem(config?.caCertificate ?? null, "CA certificate"),
    cert: certificate,
    key,
    rejectUnauthorized: true,
    ALPNProtocols: Array.from(alpn)
  }
}

/** Opens one verified TLS socket with the selected HTTP protocols. */
function openTLS(
  url: URL,
  config: TLSConfig | null,
  signal: AbortSignal,
  alpn: readonly string[],
  connectSocket: NodeHTTPClientRuntime["connectTLS"] = connectTLS
): Promise<TLSSocket> {
  return new Promise<TLSSocket>(function open(resolve, reject): void {
    const socket = Reflect.apply(connectSocket, undefined, [tlsOptions(url, config, alpn)])
    let settled = false
    /** Removes competing TLS admission observers. */
    function cleanup(): void {
      socket.off("secureConnect", connected)
      socket.off("error", failed)
      signal.removeEventListener("abort", aborted)
    }
    /** Publishes the verified TLS socket. */
    function connected(): void {
      if (settled) return
      settled = true
      cleanup()
      resolve(socket)
    }
    /** Publishes one TLS admission failure. */
    function failed(error: Error): void {
      if (settled) return
      settled = true
      cleanup()
      destroyNative(socket, error)
      reject(error)
    }
    /** Cancels an in-flight TLS handshake with the Fetch signal reason. */
    function aborted(): void {
      const error = abortError(signal)
      socket.destroy()
      failed(error)
    }
    socket.once("secureConnect", connected)
    socket.once("error", failed)
    signal.addEventListener("abort", aborted, { once: true })
    if (signal.aborted) aborted()
  })
}

/** Copies standard Fetch request headers into one native HTTP record. */
function requestHeaders(request: Request, connectionClose: boolean): Record<string, string> {
  const headers = Object.fromEntries(request.headers.entries())
  if (connectionClose) headers.connection = "close"
  return headers
}

/** Copies one Node response-header record into the standard Web API. */
function responseHeaders(values: IncomingHttpHeaders): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(values)) {
    if (name.startsWith(":") || value === undefined) continue
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item)
    } else {
      headers.append(name, String(value))
    }
  }
  return headers
}

/** Bridges one Node readable response into a standard cancelable body. */
function responseBody(
  source: IncomingMessage | ClientHttp2Stream,
  finished: (healthy: boolean) => void
): ReadableStream<Uint8Array> {
  let settled = false
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  /** Removes every native response observer. */
  function cleanup(): void {
    source.off("data", received)
    source.off("end", ended)
    source.off("error", failed)
    source.off("aborted", aborted)
    source.off("close", closed)
  }
  /** Claims the single response terminal and releases its owner. */
  function settle(healthy: boolean): boolean {
    if (settled) return false
    settled = true
    cleanup()
    if (!healthy) destroyNative(source)
    finished(healthy)
    return true
  }
  /** Transfers one detached native body chunk. */
  function received(chunk: Buffer): void {
    if (settled || controller === null) return
    controller.enqueue(new Uint8Array(chunk))
    if ((controller.desiredSize ?? 1) <= 0) source.pause()
  }
  /** Publishes normal response completion once. */
  function ended(): void {
    if (!settle(true) || controller === null) return
    controller.close()
  }
  /** Publishes one native body failure once. */
  function failed(error: Error): void {
    if (!settle(false) || controller === null) return
    controller.error(error)
  }
  /** Rejects a body explicitly aborted by the remote peer. */
  function aborted(): void {
    failed(new Error("Node HTTP response body aborted"))
  }
  /** Rejects a source that closed before its normal end event. */
  function closed(): void {
    failed(new Error("Node HTTP response body closed before end"))
  }
  return new ReadableStream<Uint8Array>({
    /** Transfers native response chunks while preserving Web stream backpressure. */
    start(value): void {
      controller = value
      source.on("data", received)
      source.once("end", ended)
      source.once("error", failed)
      source.once("aborted", aborted)
      source.once("close", closed)
    },
    /** Resumes native reads after Web stream demand recovers. */
    pull(): void {
      source.resume()
    },
    /** Cancels the native response and releases any per-request session. */
    cancel(reason): void {
      settle(false)
    }
  })
}

/** Drains a bodyless native response while preserving healthy pooled connections. */
function drainBodylessSource(
  source: IncomingMessage | ClientHttp2Stream,
  finished: (healthy: boolean) => void
): void {
  let settled = false
  /** Removes every terminal observer. */
  function cleanup(): void {
    source.off("end", ended)
    source.off("error", failed)
    source.off("aborted", aborted)
    source.off("close", closed)
  }
  /** Releases the source exactly once. */
  function settle(healthy: boolean): void {
    if (settled) return
    settled = true
    cleanup()
    if (!healthy) destroyNative(source)
    finished(healthy)
  }
  /** Publishes normal bodyless completion. */
  function ended(): void {
    settle(true)
  }
  /** Publishes one broken bodyless response. */
  function failed(): void {
    settle(false)
  }
  /** Publishes a remote body abort. */
  function aborted(): void {
    settle(false)
  }
  /** Rejects premature close before end. */
  function closed(): void {
    settle(false)
  }
  source.once("end", ended)
  source.once("error", failed)
  source.once("aborted", aborted)
  source.once("close", closed)
  source.resume()
}

/** Creates a standard Response from one native HTTP/1 response. */
function http1Response(
  response: IncomingMessage,
  finished: (healthy: boolean) => void,
  keepAlive: boolean
): Response {
  const status = response.statusCode
  if (status === undefined) throw new Error("Node HTTP/1 response omitted status")
  const init = Object.freeze({
    status,
    statusText: response.statusMessage ?? "",
    headers: responseHeaders(response.headers)
  })
  if (!bodylessStatus(status)) return new Response(responseBody(response, finished), init)
  const result = new Response(null, init)
  if (keepAlive) drainBodylessSource(response, finished)
  else {
    destroyNative(response)
    finished(true)
  }
  return result
}

/** Builds native HTTP/1 options that reuse an already verified TLS socket when supplied. */
export function nodeHTTP1RequestOptions(
  request: Request,
  headers: Record<string, string>,
  socket: TLSSocket | null
): RequestOptions {
  const url = new URL(request.url)
  const options: RequestOptions = {
    hostname: socketHost(url),
    port: url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port),
    path: `${url.pathname}${url.search}`,
    method: request.method,
    headers,
    signal: request.signal
  }
  if (socket === null) {
    options.agent = false
    return options
  }
  const selectedSocket = socket
  /** Returns the socket on which TLS and ALPN already completed. */
  options.createConnection = function reuseVerifiedSocket(): TLSSocket {
    return selectedSocket
  }
  return options
}

/** Opens one HTTP/1 request over plaintext TCP or an already verified TLS socket. */
function openHTTP1Request(
  request: Request,
  headers: Record<string, string>,
  socket: TLSSocket | null,
  received: (response: IncomingMessage) => void
): ClientRequest {
  return requestHTTP(nodeHTTP1RequestOptions(request, headers, socket), received)
}

/** Executes one request over plaintext HTTP/1 or a pre-negotiated TLS socket. */
export function executeNodeHTTP1(
  request: Request,
  body: Uint8Array,
  dial: DialOptions,
  socket: TLSSocket | null,
  open: HTTP1RequestFactory = openHTTP1Request,
  keepAlive = false
): Promise<Response> {
  const headers = requestHeaders(request, dial.connectionClose)
  if (socket !== null) headers.connection = "close"
  return new Promise<Response>(function exchange(resolve, reject): void {
    const selectedSocket = socket
    let outgoing: HTTP1RequestHandle | null = null
    let response: IncomingMessage | null = null
    let settled = false
    /** Releases request-owned resources after a response body reaches terminal state. */
    function finished(healthy: boolean): void {
      if (healthy && keepAlive) return
      destroyNative(outgoing)
      destroyNative(selectedSocket)
    }
    /** Publishes the first native HTTP/1 response. */
    function received(value: IncomingMessage): void {
      if (settled) {
        destroyNative(value)
        return
      }
      response = value
      try {
        const result = http1Response(value, finished, keepAlive)
        settled = true
        resolve(result)
      } catch (error) {
        failed(error)
      }
    }
    /** Rejects once and releases every native resource admitted so far. */
    function failed(value: unknown): void {
      if (settled) return
      settled = true
      const error = nativeError(value, "Node HTTP/1 request failed")
      destroyNative(response, error)
      destroyNative(outgoing, error)
      destroyNative(selectedSocket, error)
      reject(error)
    }
    try {
      outgoing = open(request, headers, selectedSocket, received)
      outgoing.once("error", failed)
      if (!settled) outgoing.end(body)
    } catch (error) {
      failed(error)
    }
  })
}

/** Builds native HTTP/1 options for one client-owned keep-alive agent. */
function pooledHTTP1RequestOptions(
  request: Request,
  headers: Record<string, string>,
  agent: HTTPAgent
): RequestOptions {
  const options = nodeHTTP1RequestOptions(request, headers, null)
  options.agent = agent
  return options
}

/** Executes one HTTP/1 request through a client-owned keep-alive agent. */
function executePooledHTTP1(
  request: Request,
  body: Uint8Array,
  dial: DialOptions,
  agent: HTTPAgent,
  open: NodeHTTPClientRuntime["requestHTTP"] = requestNativeHTTP1
): Promise<Response> {
  return executeNodeHTTP1(
    request,
    body,
    dial,
    null,
    function openPooled(value, headers, _socket, received): ClientRequest {
      const options = pooledHTTP1RequestOptions(value, headers, agent)
      return Reflect.apply(open, undefined, [options, received])
    },
    true
  )
}

/** Copies one standard request into an HTTP/2 header block. */
function http2Headers(request: Request): OutgoingHttpHeaders {
  const url = new URL(request.url)
  const entries: Array<[string, string]> = [
    [":method", request.method],
    [":path", `${url.pathname}${url.search}`],
    [":scheme", url.protocol.slice(0, -1)],
    [":authority", url.host]
  ]
  request.headers.forEach(function copy(value, name): void {
    entries.push([name, value])
  })
  return Object.fromEntries(entries)
}

/** Creates a standard Response around one client-owned HTTP/2 stream. */
function http2Response(
  stream: ClientHttp2Stream,
  headers: IncomingHttpHeaders,
  finished: (healthy: boolean) => void,
  keepAlive: boolean
): Response {
  const status = headers[":status"]
  if (typeof status !== "number") throw new Error("Node HTTP/2 response omitted status")
  const init = {
    status,
    headers: responseHeaders(headers)
  }
  if (!bodylessStatus(status)) return new Response(responseBody(stream, finished), init)
  const result = new Response(null, init)
  if (keepAlive) drainBodylessSource(stream, finished)
  else {
    destroyNative(stream)
    finished(true)
  }
  return result
}

/** Opens one HTTP/2 session that reuses the already verified ALPN socket. */
function openHTTP2Session(origin: string, socket: TLSSocket): ClientHttp2Session {
  return connectHTTP2(origin, {
    /** Transfers the already verified ALPN socket into the HTTP/2 session. */
    createConnection(): TLSSocket {
      return socket
    }
  })
}

/** Executes one request over an already verified HTTP/2 TLS socket. */
export function executeNodeHTTP2(
  request: Request,
  body: Uint8Array,
  socket: TLSSocket,
  connect: HTTP2SessionFactory = openHTTP2Session
): Promise<Response> {
  const url = new URL(request.url)
  return new Promise<Response>(function exchange(resolve, reject): void {
    let session: ClientHttp2Session | null = null
    let stream: ClientHttp2Stream | null = null
    let settled = false
    /** Rejects admission and releases both native resources. */
    function failed(value: unknown): void {
      if (settled) return
      settled = true
      const error = nativeError(value, "Node HTTP/2 request failed")
      destroyNative(stream, error)
      destroyNative(session, error)
      destroyNative(socket, error)
      reject(error)
    }
    /** Converts response headers without allowing callback throws to escape the Promise. */
    function received(
      admittedStream: ClientHttp2Stream,
      admittedSession: ClientHttp2Session,
      headers: IncomingHttpHeaders
    ): void {
      if (settled) return
      try {
        const result = http2Response(
          admittedStream,
          headers,
          function finished(): void {
            destroyNative(admittedSession)
          },
          false
        )
        settled = true
        resolve(result)
      } catch (error) {
        failed(error)
      }
    }
    try {
      const admittedSession = connect(url.origin, socket)
      session = admittedSession
      const admittedStream = admittedSession.request(http2Headers(request), {
        signal: request.signal
      })
      stream = admittedStream
      admittedSession.once("error", failed)
      admittedStream.once("error", failed)
      admittedStream.once("response", received.bind(undefined, admittedStream, admittedSession))
      if (!settled) admittedStream.end(body)
    } catch (error) {
      failed(error)
    }
  })
}

/** Executes one request as a stream on a reusable client-owned HTTP/2 session. */
function executePooledHTTP2(
  request: Request,
  body: Uint8Array,
  session: ClientHttp2Session,
  finished: () => void
): Promise<Response> {
  return new Promise<Response>(function exchange(resolve, reject): void {
    let stream: ClientHttp2Stream | null = null
    let settled = false
    let released = false
    /** Releases this stream from its session owner once. */
    function release(): void {
      if (released) return
      released = true
      finished()
    }
    /** Rejects stream admission without terminating sibling requests. */
    function failed(value: unknown): void {
      if (settled) return
      settled = true
      const error = nativeError(value, "Node HTTP/2 request failed")
      destroyNative(stream)
      release()
      reject(error)
    }
    /** Rejects a stream that ended before response headers. */
    function closed(): void {
      failed(new Error("Node HTTP/2 stream closed before response headers"))
    }
    /** Converts response headers without transferring session ownership. */
    function received(headers: IncomingHttpHeaders): void {
      if (settled || stream === null) return
      try {
        const result = http2Response(stream, headers, release, true)
        settled = true
        resolve(result)
      } catch (error) {
        failed(error)
      }
    }
    try {
      const admitted = session.request(http2Headers(request), { signal: request.signal })
      stream = admitted
      admitted.once("error", failed)
      admitted.once("aborted", closed)
      admitted.once("close", closed)
      admitted.once("response", received)
      if (!settled) admitted.end(body)
    } catch (error) {
      failed(error)
    }
  })
}

/** Returns every socket currently owned by one HTTP/1 agent. */
function agentSockets(agent: HTTPAgent): Socket[] {
  const sockets = new Set<Socket>()
  for (const values of Object.values(agent.sockets)) {
    if (values === undefined) continue
    for (const socket of values) sockets.add(socket)
  }
  for (const values of Object.values(agent.freeSockets)) {
    if (values === undefined) continue
    for (const socket of values) sockets.add(socket)
  }
  return Array.from(sockets)
}

/** Destroys one HTTP/1 agent after observing its current socket terminals. */
function closeAgent(agent: HTTPAgent): Promise<void> {
  const waits: Promise<void>[] = []
  for (const socket of agentSockets(agent)) {
    waits.push(
      new Promise<void>(function observe(resolve): void {
        if (socket.destroyed) {
          resolve()
          return
        }
        socket.once("close", resolve)
      })
    )
  }
  agent.destroy()
  return Promise.all(waits).then(function closed(): void {})
}

interface HTTP2PoolSlot {
  readonly session: ClientHttp2Session
  accepting: boolean
  draining: boolean
  active: number
}

interface HTTP1Protocol {
  readonly kind: "h1"
  readonly agent: HTTPAgent
}

interface HTTP2Protocol {
  readonly kind: "h2"
  readonly slot: HTTP2PoolSlot
}

type SecureProtocol = HTTP1Protocol | HTTP2Protocol

/** Creates one Node-native Fetch executor owner with immutable dial and TLS behavior. */
export function newNodeHTTPExecutor(
  target: HTTPDialTarget,
  common: Options,
  dial: DialOptions,
  runtime: NodeHTTPClientRuntime = nativeHTTPClientRuntime
): HTTPDialExecutorHandle {
  const tlsConfig = common.tlsConfig
  const targetURL = new URL(target.href)
  const secure = targetURL.protocol === "https:"
  const closeController = new AbortController()
  const plaintextAgent = secure || dial.connectionClose ? null : runtime.newHTTPAgent()
  const sessions = new Set<ClientHttp2Session>()
  let secureAgent: HTTPAgent | null = null
  let firstHTTP1Socket: TLSSocket | null = null
  let http2Slot: HTTP2PoolSlot | null = null
  let opening: Promise<SecureProtocol> | null = null
  let openingController: AbortController | null = null
  let openingWaiters = 0
  let closed = false
  let closeWork: Promise<void> | null = null

  /** Creates one HTTPS keep-alive agent and transfers the negotiated socket once. */
  function openHTTP1Pool(socket: TLSSocket): HTTP1Protocol {
    const agent = runtime.newHTTPAgent()
    firstHTTP1Socket = socket
    agent.createConnection = function createOwnedConnection() {
      const first = firstHTTP1Socket
      if (first !== null) {
        firstHTTP1Socket = null
        return first
      }
      return runtime.connectTLS(tlsOptions(targetURL, tlsConfig, ["http/1.1"]))
    }
    secureAgent = agent
    return Object.freeze({ kind: "h1", agent })
  }

  /** Evicts one session only when it still occupies the allocation slot. */
  function evictHTTP2(slot: HTTP2PoolSlot): void {
    slot.accepting = false
    if (http2Slot === slot) http2Slot = null
  }

  /** Admits one HTTP/2 session and owns every terminal transition. */
  function openHTTP2Pool(socket: TLSSocket): HTTP2Protocol {
    let session: ClientHttp2Session
    try {
      session = runtime.connectHTTP2(target.origin, socket)
    } catch (error) {
      destroyNative(socket)
      throw error
    }
    const slot: HTTP2PoolSlot = { session, accepting: true, draining: false, active: 0 }
    sessions.add(session)
    http2Slot = slot
    session.once("goaway", function draining(): void {
      evictHTTP2(slot)
      slot.draining = true
      try {
        session.close()
      } catch {
        destroyNative(session)
      }
      if (slot.active === 0) destroyNative(session)
    })
    session.once("error", function failed(): void {
      evictHTTP2(slot)
      destroyNative(session)
    })
    session.once("close", function closedSession(): void {
      evictHTTP2(slot)
      sessions.delete(session)
    })
    return Object.freeze({ kind: "h2", slot })
  }

  /** Negotiates one replacement secure protocol allocation. */
  async function openSecureProtocol(signal: AbortSignal): Promise<SecureProtocol> {
    const socket = await openTLS(
      targetURL,
      tlsConfig,
      AbortSignal.any([signal, closeController.signal]),
      ["h2", "http/1.1"],
      runtime.connectTLS
    )
    if (closed) {
      destroyNative(socket)
      throw new Error("Node HTTP executor is closed")
    }
    return socket.alpnProtocol === "h2" ? openHTTP2Pool(socket) : openHTTP1Pool(socket)
  }

  /** Returns the current allocatable secure protocol, merging replacement handshakes. */
  async function secureProtocol(signal: AbortSignal): Promise<SecureProtocol> {
    while (true) {
      if (signal.aborted) throw abortError(signal)
      if (closed) throw new Error("Node HTTP executor is closed")
      if (secureAgent !== null) return Object.freeze({ kind: "h1", agent: secureAgent })
      if (
        http2Slot !== null &&
        http2Slot.accepting &&
        !http2Slot.session.closed &&
        !http2Slot.session.destroyed
      ) {
        return Object.freeze({ kind: "h2", slot: http2Slot })
      }
      if (opening === null) {
        const controller = new AbortController()
        const admitted = openSecureProtocol(controller.signal)
        openingController = controller
        opening = admitted
        void admitted.then(
          function opened(): void {
            if (opening !== admitted) return
            opening = null
            openingController = null
          },
          function failed(): void {
            if (opening !== admitted) return
            opening = null
            openingController = null
          }
        )
      }
      const selectedOpening = opening
      if (selectedOpening === null) continue
      const selectedController = openingController
      openingWaiters += 1
      let selected: SecureProtocol
      try {
        selected = await waitForSignal(selectedOpening, signal)
      } finally {
        openingWaiters -= 1
        if (signal.aborted && opening === selectedOpening && openingWaiters === 0) {
          opening = null
          openingController = null
          selectedController?.abort(new Error("Node HTTP handshake has no active waiters"))
        }
      }
      if (selected.kind === "h1" || selected.slot.accepting) return selected
    }
  }

  /** Executes one request using only resources owned by this dial. */
  const executor: HTTPExecutor = async function execute(input, init): Promise<Response> {
    if (closed) throw new Error("Node HTTP executor is closed")
    const request =
      input instanceof Request && init === undefined ? input : new Request(input, init)
    if (new URL(request.url).origin !== target.origin)
      throw new TypeError("Node HTTP executor request must remain on its dial origin")
    const body = new Uint8Array(await request.arrayBuffer())
    closeController.signal.throwIfAborted()
    const url = new URL(request.url)
    if (dial.connectionClose) {
      if (url.protocol === "http:") {
        return executeNodeHTTP1(
          request,
          body,
          dial,
          null,
          function open(value, headers, socket, received): ClientRequest {
            return runtime.requestHTTP(nodeHTTP1RequestOptions(value, headers, socket), received)
          }
        )
      }
      const signal = AbortSignal.any([request.signal, closeController.signal])
      const socket = await openTLS(url, tlsConfig, signal, ["http/1.1"], runtime.connectTLS)
      if (signal.aborted) {
        destroyNative(socket)
        throw abortError(signal)
      }
      return executeNodeHTTP1(
        request,
        body,
        dial,
        socket,
        function open(value, headers, selected, received): ClientRequest {
          return runtime.requestHTTP(nodeHTTP1RequestOptions(value, headers, selected), received)
        }
      )
    }
    if (plaintextAgent !== null) {
      return executePooledHTTP1(request, body, dial, plaintextAgent, runtime.requestHTTP)
    }
    const selected = await secureProtocol(request.signal)
    if (request.signal.aborted) throw abortError(request.signal)
    closeController.signal.throwIfAborted()
    if (selected.kind === "h1") {
      return executePooledHTTP1(request, body, dial, selected.agent, runtime.requestHTTP)
    }
    const slot = selected.slot
    slot.active += 1
    return executePooledHTTP2(request, body, slot.session, function finished(): void {
      slot.active -= 1
      if (slot.draining && slot.active === 0) destroyNative(slot.session)
    })
  }

  return Object.freeze({
    executor,
    /** Atomically prevents admission and releases every agent, session, and late handshake. */
    close(): Promise<void> {
      if (closeWork !== null) return closeWork
      closed = true
      closeController.abort(new Error("Node HTTP executor is closed"))
      const admittedOpening = opening
      const work = (async function closeOwnedResources(): Promise<void> {
        if (admittedOpening !== null) {
          try {
            await admittedOpening
          } catch {
            // Failed or canceled handshakes own no reusable resource.
          }
        }
        destroyNative(firstHTTP1Socket)
        firstHTTP1Socket = null
        const agentClosures: Promise<void>[] = []
        if (plaintextAgent !== null) agentClosures.push(closeAgent(plaintextAgent))
        if (secureAgent !== null) agentClosures.push(closeAgent(secureAgent))
        const sessionClosures: Promise<void>[] = []
        for (const session of Array.from(sessions)) {
          sessionClosures.push(
            new Promise<void>(function destroySession(resolve): void {
              if (session.closed || session.destroyed) {
                destroyNative(session)
                resolve()
                return
              }
              session.once("close", resolve)
              destroyNative(session)
            })
          )
        }
        await Promise.all([Promise.all(agentClosures), Promise.all(sessionClosures)])
      })()
      closeWork = work
      return work
    }
  })
}
