import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type Server,
  ServerResponse
} from "node:http"
import {
  createSecureServer,
  type Http2SecureServer,
  type Http2ServerRequest,
  type Http2ServerResponse,
  type SecureServerOptions,
  type ServerHttp2Session
} from "node:http2"
import type { Socket } from "node:net"

import { canceled, cause, type Context } from "@go-like/context"
import { waitForContext } from "@go-like/core/lifecycle"
import type { TLSConfig, TLSEncodedBytes } from "@go-like/transport"
import { newTransportStateError } from "@go-like/transport/provider"

import { normalizeHTTPError } from "./errors"
import type {
  HTTPHandler,
  HTTPHost,
  HTTPHostCapabilities,
  HTTPHostHandle,
  HTTPHostListenOptions,
  HTTPHostRequest,
  HTTPServeHandle
} from "./types"

/** Creates one native Node HTTP server with the supplied request listener. */
export type NodeHTTPServerFactory = (listener: RequestListener) => Server

/** Creates one native secure HTTP/2 server for lifecycle fault testing. */
export type NodeSecureHTTPServerFactory = (
  options: SecureServerOptions,
  listener: (
    request: IncomingMessage | Http2ServerRequest,
    response: ServerResponse | Http2ServerResponse
  ) => void
) => Http2SecureServer

/** Selects whether one secure Node host requires peer client certificates. */
export type NodeHTTPClientAuth = "none" | "require"

/** Contains Node-specific secure host behavior without leaking into portable TLS material. */
export interface NodeHTTPHostOptions {
  readonly allowHTTP1: boolean
  readonly clientAuth: NodeHTTPClientAuth
}

/** Immutably reduces Node-specific host construction configuration. */
export type NodeHTTPHostOption = (options: NodeHTTPHostOptions) => NodeHTTPHostOptions

type NodeIncomingMessage = IncomingMessage | Http2ServerRequest
type NodeServerResponse = ServerResponse | Http2ServerResponse
/** Dispatches one native HTTP/1 or HTTP/2 compatibility request. */
type NodeRequestHandler = (request: NodeIncomingMessage, response: NodeServerResponse) => void

interface NodeNativeServer {
  /** Returns whether the native listener is currently bound. */
  readonly listening: () => boolean
  /** Returns the current native address value. */
  readonly address: () => unknown
  /** Starts one exclusive TCP bind. */
  readonly listen: (hostname: string, port: number) => void
  /** Starts graceful native listener close. */
  readonly close: (callback: (error?: Error) => void) => void
  /** Requests idle HTTP/1 connection cleanup when available. */
  readonly closeIdleConnections: () => void
  /** Requests all HTTP/1 connection cleanup when available. */
  readonly closeAllConnections: () => void
  /** Observes each native TCP connection. */
  readonly onConnection: (listener: (socket: Socket) => void) => void
  /** Observes native listener close. */
  readonly onClose: (listener: () => void) => void
  /** Observes native listener failure. */
  readonly onError: (listener: (error: Error) => void) => void
  /** Observes native bind admission once. */
  readonly onceListening: (listener: () => void) => void
  /** Observes each HTTP/2 session when supported. */
  readonly onSession: (listener: (session: ServerHttp2Session) => void) => void
}

/** Creates one native server adapter for an independently owned bind. */
type NodeNativeServerFactory = (
  listener: NodeRequestHandler,
  options: HTTPHostListenOptions
) => NodeNativeServer

type NodeHostMode = "binding" | "bound" | "serving" | "closing" | "terminal"

interface Deferred<T> {
  readonly promise: Promise<T>
  /** Resolves the controlled Promise. */
  readonly resolve: (value: T) => void
  /** Rejects the controlled Promise with one Error. */
  readonly reject: (error: Error) => void
}

interface NodeRequestInit extends RequestInit {
  readonly duplex: "half"
}

interface NodeHostRuntime {
  readonly server: NodeNativeServer
  readonly terminal: Deferred<void>
  readonly sockets: Set<Socket>
  readonly destroyedSockets: WeakSet<Socket>
  readonly sessions: Set<ServerHttp2Session>
  readonly destroyedSessions: WeakSet<ServerHttp2Session>
  readonly cleanupFailures: Error[]
  readonly requests: Set<NodeActiveRequest>
  mode: NodeHostMode
  address: string
  secure: boolean
  handler: HTTPHandler | null
  primaryFailure: Error | null
  activeHandlers: number
  closeStarted: boolean
  nativeCloseStarted: boolean
  closeObserved: boolean
  bindPending: boolean
  forceStarted: boolean
  settled: boolean
  serveUsed: boolean
  serveSignal: AbortSignal | null
  serveAbort: (() => void) | null
}

interface NodeActiveRequest {
  /** Forces only this admitted request toward real handler terminal. */
  readonly force: () => void
}

const PlainCapabilities: HTTPHostCapabilities = Object.freeze({
  tls: false,
  forceClose: true,
  connectionMetadata: true
})

const SecureCapabilities: HTTPHostCapabilities = Object.freeze({
  tls: true,
  forceClose: true,
  connectionMetadata: true
})

/** Validates and freezes one Node host construction snapshot. */
function snapshotNodeHTTPHostOptions(value: NodeHTTPHostOptions): NodeHTTPHostOptions {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Node HTTP host options must be an object")
  }
  if (typeof value.allowHTTP1 !== "boolean") {
    throw new TypeError("Node HTTP host allowHTTP1 must be a boolean")
  }
  if (value.clientAuth !== "none" && value.clientAuth !== "require") {
    throw new TypeError("Node HTTP host clientAuth must be none or require")
  }
  return Object.freeze({ allowHTTP1: value.allowHTTP1, clientAuth: value.clientAuth })
}

/** Applies Node host functional options once in declaration order. */
function applyNodeHTTPHostOptions(options: readonly NodeHTTPHostOption[]): NodeHTTPHostOptions {
  let current = snapshotNodeHTTPHostOptions(Object.freeze({ allowHTTP1: true, clientAuth: "none" }))
  for (const option of options) {
    if (typeof option !== "function")
      throw new TypeError("Node HTTP host option must be a function")
    current = snapshotNodeHTTPHostOptions(option(current))
  }
  return current
}

/** Selects whether a secure Node HTTP/2 host also admits HTTP/1.1 through ALPN. */
export function allowHTTP1(enabled: boolean): NodeHTTPHostOption {
  if (typeof enabled !== "boolean")
    throw new TypeError("Node HTTP host allowHTTP1 must be a boolean")
  return function reduceAllowHTTP1(options): NodeHTTPHostOptions {
    const current = snapshotNodeHTTPHostOptions(options)
    return Object.freeze({ allowHTTP1: enabled, clientAuth: current.clientAuth })
  }
}

/** Selects whether TLS client-certificate authentication is required. */
export function clientAuth(value: NodeHTTPClientAuth): NodeHTTPHostOption {
  if (value !== "none" && value !== "require") {
    throw new TypeError("Node HTTP host clientAuth must be none or require")
  }
  return function reduceClientAuth(options): NodeHTTPHostOptions {
    const current = snapshotNodeHTTPHostOptions(options)
    return Object.freeze({ allowHTTP1: current.allowHTTP1, clientAuth: value })
  }
}

/** Returns one detached PEM buffer while rejecting underspecified DER material. */
function pemBytes(value: TLSEncodedBytes | null, label: string): Buffer | undefined {
  if (value === null) return undefined
  if (value.encoding !== "pem") {
    throw new TypeError(`Node HTTP ${label} must use PEM encoding`)
  }
  return Buffer.from(value.bytes)
}

/** Maps portable TLS identity and Node-only peer policy to a secure server configuration. */
function secureServerOptions(
  tls: TLSConfig | null,
  options: NodeHTTPHostOptions
): SecureServerOptions {
  if (tls === null || tls.certificateChain === null || tls.privateKey === null) {
    throw new TypeError("Node HTTP TLS requires a PEM certificate chain and private key")
  }
  if (options.clientAuth === "require" && tls.caCertificate === null) {
    throw new TypeError("Node HTTP client authentication requires a PEM CA certificate")
  }
  return Object.freeze({
    allowHTTP1: options.allowHTTP1,
    cert: pemBytes(tls.certificateChain, "certificate chain"),
    key: pemBytes(tls.privateKey, "private key"),
    ca: pemBytes(tls.caCertificate, "CA certificate"),
    requestCert: options.clientAuth === "require",
    rejectUnauthorized: options.clientAuth === "require"
  })
}

/** Adapts one HTTP/1 server to the native lifecycle operations used by the host. */
function adaptHTTP1Server(server: Server): NodeNativeServer {
  return Object.freeze({
    /** Returns the current native HTTP/1 listener state. */
    listening(): boolean {
      return server.listening
    },
    /** Returns the current native HTTP/1 address. */
    address(): unknown {
      return server.address()
    },
    /** Starts one exclusive HTTP/1 bind. */
    listen(hostname: string, port: number): void {
      server.listen(Object.freeze({ host: hostname, port, exclusive: true }))
    },
    /** Starts native HTTP/1 graceful close. */
    close(callback: (error?: Error) => void): void {
      server.close(callback)
    },
    /** Closes native idle HTTP/1 connections. */
    closeIdleConnections(): void {
      server.closeIdleConnections()
    },
    /** Closes every native HTTP/1 connection. */
    closeAllConnections(): void {
      server.closeAllConnections()
    },
    /** Installs the native HTTP/1 connection observer. */
    onConnection(listener: (socket: Socket) => void): void {
      server.on("connection", listener)
    },
    /** Installs the native HTTP/1 close observer. */
    onClose(listener: () => void): void {
      server.on("close", listener)
    },
    /** Installs the native HTTP/1 failure observer. */
    onError(listener: (error: Error) => void): void {
      server.on("error", listener)
    },
    /** Installs the one-shot native HTTP/1 listening observer. */
    onceListening(listener: () => void): void {
      server.once("listening", listener)
    },
    /** Ignores HTTP/2 session observation for a plaintext HTTP/1 server. */
    onSession(_listener: (session: ServerHttp2Session) => void): void {}
  })
}

/** Adapts one secure HTTP/2 server while retaining HTTP/1 ALPN compatibility. */
function adaptHTTP2Server(server: Http2SecureServer): NodeNativeServer {
  return Object.freeze({
    /** Returns the current secure HTTP/2 listener state. */
    listening(): boolean {
      return server.listening
    },
    /** Returns the current secure HTTP/2 address. */
    address(): unknown {
      return server.address()
    },
    /** Starts one exclusive secure HTTP/2 bind. */
    listen(hostname: string, port: number): void {
      server.listen(Object.freeze({ host: hostname, port, exclusive: true }))
    },
    /** Starts native HTTP/2 graceful listener close. */
    close(callback: (error?: Error) => void): void {
      server.close(function closed(): void {
        callback()
      })
    },
    /** Leaves HTTP/1 idle cleanup to tracked sockets and HTTP/2 sessions. */
    closeIdleConnections(): void {},
    /** Leaves force cleanup to tracked sockets and HTTP/2 sessions. */
    closeAllConnections(): void {},
    /** Installs the native secure connection observer. */
    onConnection(listener: (socket: Socket) => void): void {
      server.on("connection", listener)
    },
    /** Installs the native secure listener close observer. */
    onClose(listener: () => void): void {
      server.on("close", listener)
    },
    /** Installs the native secure listener failure observer. */
    onError(listener: (error: Error) => void): void {
      server.on("error", listener)
    },
    /** Installs the one-shot native secure listening observer. */
    onceListening(listener: () => void): void {
      server.once("listening", listener)
    },
    /** Installs the native HTTP/2 session observer. */
    onSession(listener: (session: ServerHttp2Session) => void): void {
      server.on("session", listener)
    }
  })
}

/** Lifts the existing HTTP/1 test factory into the generic native host core. */
function plainFactory(factory: NodeHTTPServerFactory): NodeNativeServerFactory {
  return function createPlain(listener): NodeNativeServer {
    return adaptHTTP1Server(
      factory(function dispatch(request, response): void {
        listener(request, response)
      })
    )
  }
}

/** Creates a secure Node HTTP/2 server from portable PEM material. */
function secureFactory(
  options: NodeHTTPHostOptions,
  factory: NodeSecureHTTPServerFactory = function create(options, listener): Http2SecureServer {
    return createSecureServer(options, function dispatch(request, response): void {
      listener(request, response)
    })
  }
): NodeNativeServerFactory {
  return function createSecure(listener, listenOptions): NodeNativeServer {
    const server = factory(secureServerOptions(listenOptions.tlsConfig, options), listener)
    return adaptHTTP2Server(server)
  }
}

/** Selects plaintext HTTP/1 or secure HTTP/2 for each independent bind. */
function defaultFactory(options: NodeHTTPHostOptions): NodeNativeServerFactory {
  const createPlain = plainFactory(function create(listener): Server {
    return createServer(listener)
  })
  const createSecure = secureFactory(options)
  return function createNodeServer(listener, listenOptions): NodeNativeServer {
    const useTLS = listenOptions.secure || listenOptions.tlsConfig !== null
    if (useTLS) return createSecure(listener, listenOptions)
    if (options.clientAuth !== "none") {
      throw new TypeError("Node HTTP client authentication requires TLS")
    }
    return createPlain(listener, listenOptions)
  }
}

/** Creates one externally settleable Promise controller. */
function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | null = null
  let rejectPromise: ((error: Error) => void) | null = null
  const promise = new Promise<T>(function capture(resolve, reject): void {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return Object.freeze({
    promise,
    /** Resolves the controlled Promise. */
    resolve(value: T): void {
      resolvePromise?.(value)
    },
    /** Rejects the controlled Promise with one Error. */
    reject(error: Error): void {
      rejectPromise?.(error)
    }
  })
}

/** Marks one rejection handled without replacing its public identity. */
function observe(operation: Promise<unknown>): void {
  void operation.catch(function ignoreObservedFailure(): void {})
}

/** Returns the exact Go-style Context cancellation cause. */
function contextFailure(ctx: Context): Error {
  return cause(ctx) ?? canceled
}

/** Removes one borrowed abort observer without leaking a hostile signal failure. */
function removeAbortListener(
  signal: AbortSignal,
  listener: () => void,
  message: string
): Error | null {
  try {
    signal.removeEventListener("abort", listener)
    return null
  } catch (error) {
    return normalizeHTTPError(error, message)
  }
}

/** Parses one already-normalized host-port listen authority. */
function parseAddress(address: string): { readonly hostname: string; readonly port: number } {
  const bracketed = /^\[([^\]]+)\]:(\d+)$/.exec(address)
  const matched = bracketed ?? /^([^:[\]]+):(\d+)$/.exec(address)
  if (matched === null) throw new TypeError("Node HTTP listen address must be host:port")
  const [, hostname = "", portText = ""] = matched
  const port = Number(portText)
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError("Node HTTP listen port must be an integer in 0..65535")
  }
  return Object.freeze({ hostname, port })
}

/** Formats one TCP host and port as a listen authority. */
function formatAddress(hostname: string, port: number): string {
  return hostname.includes(":") ? `[${hostname}]:${port}` : `${hostname}:${port}`
}

/** Returns per-connection local metadata, falling back only when Node omitted it. */
function requestLocalAddress(runtime: NodeHostRuntime, request: NodeIncomingMessage): string {
  const hostname = request.socket.localAddress
  const port = request.socket.localPort
  if (hostname === undefined || port === undefined) return runtime.address
  return formatAddress(hostname, port)
}

/** Snapshots the actual native TCP address after successful bind. */
function boundAddress(server: NodeNativeServer): string {
  const address: unknown = server.address()
  if (typeof address !== "object" || address === null) {
    throw new Error("Node HTTP host address is not a TCP address")
  }
  const hostname: unknown = Reflect.get(address, "address")
  const port: unknown = Reflect.get(address, "port")
  if (typeof hostname !== "string" || typeof port !== "number" || !Number.isInteger(port)) {
    throw new Error("Node HTTP host address is not a TCP address")
  }
  return formatAddress(hostname, port)
}

/** Creates an immutable aggregate whose ordered identities cannot be replaced. */
function aggregateFailures(failures: readonly Error[]): AggregateError {
  const retained = Object.freeze(Array.from(failures))
  const aggregate = new AggregateError(retained, "Node HTTP host lifecycle failed")
  Object.defineProperty(aggregate, "errors", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: retained
  })
  return Object.freeze(aggregate)
}

/** Reports whether one failure identity was already admitted. */
function hasFailure(runtime: NodeHostRuntime, failure: Error): boolean {
  return runtime.primaryFailure === failure || runtime.cleanupFailures.includes(failure)
}

/** Claims the first passive runtime failure without replacing it later. */
function admitPrimary(runtime: NodeHostRuntime, failure: Error): void {
  if (runtime.primaryFailure !== null || hasFailure(runtime, failure)) return
  runtime.primaryFailure = failure
}

/** Records one cleanup failure in observation order. */
function admitCleanup(runtime: NodeHostRuntime, value: unknown, message: string): void {
  if (runtime.settled) return
  const failure = normalizeHTTPError(value, message)
  if (!hasFailure(runtime, failure)) runtime.cleanupFailures.push(failure)
}

/** Builds the final exact Error or ordered immutable aggregate. */
function terminalFailure(runtime: NodeHostRuntime): Error | null {
  const failures: Error[] = []
  if (runtime.primaryFailure !== null) failures.push(runtime.primaryFailure)
  for (const failure of runtime.cleanupFailures) failures.push(failure)
  const first = failures[0]
  if (first === undefined) return null
  return failures.length === 1 ? first : aggregateFailures(failures)
}

/** Detaches the long-lived serve Context observer and reports a hostile signal failure. */
function detachServeContext(runtime: NodeHostRuntime): Error | null {
  const signal = runtime.serveSignal
  const listener = runtime.serveAbort
  runtime.serveSignal = null
  runtime.serveAbort = null
  if (signal === null || listener === null) return null
  return removeAbortListener(signal, listener, "Node HTTP serve Context detach failed")
}

/** Settles the stable host terminal only after all native barriers clear. */
function maybeFinish(runtime: NodeHostRuntime): void {
  if (
    runtime.settled ||
    !runtime.closeStarted ||
    !runtime.closeObserved ||
    runtime.sockets.size !== 0 ||
    runtime.sessions.size !== 0 ||
    runtime.activeHandlers !== 0
  )
    return
  runtime.settled = true
  runtime.mode = "terminal"
  const detachFailure = detachServeContext(runtime)
  if (detachFailure !== null && !hasFailure(runtime, detachFailure)) {
    runtime.cleanupFailures.push(detachFailure)
  }
  const failure = terminalFailure(runtime)
  if (failure === null) runtime.terminal.resolve(undefined)
  else runtime.terminal.reject(failure)
}

/** Requests native idle-connection convergence without treating absence as failure. */
function closeIdleConnections(runtime: NodeHostRuntime): void {
  try {
    runtime.server.closeIdleConnections()
  } catch (error) {
    admitCleanup(runtime, error, "Node HTTP closeIdleConnections failed")
  }
}

/** Sends graceful HTTP/2 session close at most once per current session. */
function closeSessions(runtime: NodeHostRuntime): void {
  for (const session of runtime.sessions) {
    try {
      session.close()
    } catch (error) {
      admitCleanup(runtime, error, "Node HTTP/2 session close failed")
    }
  }
}

/** Destroys each tracked HTTP/2 session at most once. */
function destroySessions(runtime: NodeHostRuntime): void {
  for (const session of runtime.sessions) {
    if (runtime.destroyedSessions.has(session)) continue
    runtime.destroyedSessions.add(session)
    try {
      session.destroy()
    } catch (error) {
      admitCleanup(runtime, error, "Node HTTP/2 session destroy failed")
    }
  }
}

/** Starts graceful native listener close exactly once. */
function startClose(runtime: NodeHostRuntime): void {
  if (!runtime.closeStarted) {
    runtime.closeStarted = true
    runtime.mode = "closing"
  }
  if (runtime.nativeCloseStarted || runtime.closeObserved) return
  let listening = true
  let listeningInspectionFailed = false
  try {
    listening = runtime.server.listening()
  } catch (error) {
    listeningInspectionFailed = true
    admitCleanup(runtime, error, "Node HTTP listening inspection failed")
  }
  if (!listening) {
    if (runtime.bindPending) {
      runtime.nativeCloseStarted = true
      try {
        runtime.server.close(function pendingListenCloseCallback(error?: Error): void {
          runtime.bindPending = false
          runtime.closeObserved = true
          if (error !== undefined && Reflect.get(error, "code") !== "ERR_SERVER_NOT_RUNNING") {
            admitCleanup(runtime, error, "Node HTTP pending listen close failed")
          }
          maybeFinish(runtime)
        })
      } catch (error) {
        runtime.bindPending = false
        runtime.closeObserved = true
        admitCleanup(runtime, error, "Node HTTP pending listen close threw")
      }
      maybeFinish(runtime)
      return
    }
    runtime.closeObserved = true
    maybeFinish(runtime)
    return
  }
  runtime.nativeCloseStarted = true
  try {
    runtime.server.close(function nativeCloseCallback(error?: Error): void {
      if (error !== undefined) admitCleanup(runtime, error, "Node HTTP close failed")
      if (runtime.activeHandlers === 0) destroySockets(runtime)
      runtime.closeObserved = true
      maybeFinish(runtime)
    })
    if (listeningInspectionFailed) runtime.nativeCloseStarted = false
  } catch (error) {
    runtime.nativeCloseStarted = false
    admitCleanup(runtime, error, "Node HTTP close threw")
    try {
      if (!runtime.server.listening()) runtime.closeObserved = true
    } catch (inspectionError) {
      admitCleanup(runtime, inspectionError, "Node HTTP listening reinspection failed")
    }
  }
  closeIdleConnections(runtime)
  closeSessions(runtime)
  maybeFinish(runtime)
}

/** Destroys each tracked socket at most once. */
function destroySockets(runtime: NodeHostRuntime): void {
  for (const socket of runtime.sockets) {
    if (runtime.destroyedSockets.has(socket)) continue
    runtime.destroyedSockets.add(socket)
    try {
      socket.destroy()
    } catch (error) {
      admitCleanup(runtime, error, "Node HTTP socket destroy failed")
    }
  }
}

/** Forces one active request without allowing its private fault seam to stop sibling cleanup. */
function forceActiveRequest(runtime: NodeHostRuntime, request: NodeActiveRequest): void {
  try {
    request.force()
  } catch (error) {
    admitCleanup(runtime, error, "Node HTTP request force failed")
  }
}

/** Executes the mandated close-first force sequence once. */
function startForce(runtime: NodeHostRuntime): void {
  startClose(runtime)
  if (runtime.forceStarted) return
  runtime.forceStarted = true
  try {
    runtime.server.closeAllConnections()
  } catch (error) {
    admitCleanup(runtime, error, "Node HTTP closeAllConnections failed")
  }
  for (const request of runtime.requests) forceActiveRequest(runtime, request)
  destroySessions(runtime)
  destroySockets(runtime)
  maybeFinish(runtime)
}

/** Converts native repeated header pairs to one standard Headers object. */
function requestHeaders(request: NodeIncomingMessage): Headers {
  const headers = new Headers()
  const values = request.rawHeaders
  for (let index = 0; index + 1 < values.length; index += 2) {
    const name = values[index]
    const value = values[index + 1]
    if (name !== undefined && value !== undefined && !name.startsWith(":")) {
      headers.append(name, value)
    }
  }
  return headers
}

/** Bridges one native incoming body to a standard Web ReadableStream. */
function requestBody(request: NodeIncomingMessage): ReadableStream<Uint8Array> {
  let terminal = false
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  /** Detaches every native body observer. */
  function cleanup(): void {
    request.removeListener("data", onData)
    request.removeListener("end", onEnd)
    request.removeListener("error", onError)
    request.removeListener("aborted", onAborted)
  }
  /** Copies one native Buffer into the standard stream boundary. */
  function onData(chunk: Buffer): void {
    if (terminal || controller === null) return
    controller.enqueue(new Uint8Array(chunk))
    const desiredSize = controller.desiredSize
    if (desiredSize !== null && desiredSize <= 0) request.pause()
  }
  /** Closes the standard stream after the complete native body. */
  function onEnd(): void {
    if (terminal || controller === null) return
    terminal = true
    cleanup()
    controller.close()
  }
  /** Rejects the standard stream with the native body error identity. */
  function onError(error: Error): void {
    if (terminal || controller === null) return
    terminal = true
    cleanup()
    controller.error(error)
  }
  /** Rejects an incomplete native body without exposing request contents. */
  function onAborted(): void {
    onError(new Error("Node HTTP request body aborted"))
  }
  return new ReadableStream<Uint8Array>({
    /** Installs native body observers without consuming before Request construction. */
    start(streamController): void {
      controller = streamController
      request.on("data", onData)
      request.once("end", onEnd)
      request.once("error", onError)
      request.once("aborted", onAborted)
    },
    /** Resumes the native body only when the standard consumer requests data. */
    pull(): void {
      request.resume()
    },
    /** Releases the owned native request when standard body consumption stops. */
    cancel(): void {
      terminal = true
      cleanup()
      request.resume()
    }
  })
}

/** Creates the standard Request passed through the runtime-neutral host SPI. */
function standardRequest(
  runtime: NodeHostRuntime,
  request: NodeIncomingMessage,
  aborter: AbortController
): Request {
  const method = request.method ?? "GET"
  const scheme = runtime.secure ? "https" : "http"
  const target = new URL(request.url ?? "/", `${scheme}://${runtime.address}`)
  if (method === "GET" || method === "HEAD") {
    return new Request(
      target,
      Object.freeze({
        method,
        headers: requestHeaders(request),
        signal: aborter.signal
      })
    )
  }
  const init: NodeRequestInit = Object.freeze({
    method,
    headers: requestHeaders(request),
    body: requestBody(request),
    duplex: "half",
    signal: aborter.signal
  })
  return new Request(target, init)
}

/** Waits until the native response accepts more bytes or becomes terminal. */
function waitForDrain(response: NodeServerResponse): Promise<void> {
  return new Promise<void>(function wait(resolve, reject): void {
    let settled = false
    /** Detaches every one-shot native response observer. */
    function cleanup(): void {
      response.removeListener("drain", onDrain)
      response.removeListener("close", onClose)
      response.removeListener("error", onError)
    }
    /** Resolves when the native response becomes writable again. */
    function onDrain(): void {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }
    /** Rejects when the peer closes before backpressure clears. */
    function onClose(): void {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error("Node HTTP response closed during write"))
    }
    /** Rejects with the native response error identity. */
    function onError(error: Error): void {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    response.once("drain", onDrain)
    response.once("close", onClose)
    response.once("error", onError)
  })
}

/** Writes one binary chunk through the matching Node response compatibility class. */
function writeNativeResponse(response: NodeServerResponse, chunk: Uint8Array): boolean {
  if (response instanceof ServerResponse) return response.write(chunk)
  return response.write(chunk)
}

/** Writes one standard Response to the native Node response stream. */
async function writeResponse(
  response: NodeServerResponse,
  output: Response,
  signal: AbortSignal
): Promise<void> {
  response.statusCode = output.status
  if (output.statusText !== "") response.statusMessage = output.statusText
  for (const [name, value] of output.headers) response.setHeader(name, value)
  if (output.body === null) {
    response.end()
    return
  }
  const reader = output.body.getReader()
  let finished = false
  /** Cancels the owned standard response reader when the peer disappears. */
  function cancelReader(): void {
    if (finished) return
    try {
      const canceledBody = reader.cancel()
      observe(Promise.resolve(canceledBody))
    } catch {
      // Native response termination remains primary over best-effort body cleanup.
    }
  }
  response.once("close", cancelReader)
  signal.addEventListener("abort", cancelReader, { once: true })
  if (signal.aborted) cancelReader()
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      const chunk = result.value
      if (!(chunk instanceof Uint8Array)) {
        throw new TypeError("Node HTTP Response body must yield Uint8Array chunks")
      }
      if (!writeNativeResponse(response, chunk)) await waitForDrain(response)
    }
    finished = true
    response.end()
  } finally {
    response.removeListener("close", cancelReader)
    signal.removeEventListener("abort", cancelReader)
    if (!finished) cancelReader()
    reader.releaseLock()
  }
}

/** Sends one short admission failure without retaining the request body. */
function unavailable(request: NodeIncomingMessage, response: NodeServerResponse): void {
  request.resume()
  response.statusCode = 503
  response.setHeader("content-type", "text/plain; charset=utf-8")
  response.end("Service Unavailable")
}

/** Sends a secret-safe handler failure when response headers remain mutable. */
function handlerFailure(response: NodeServerResponse): void {
  if (response.headersSent) {
    response.destroy()
    return
  }
  response.statusCode = 500
  response.setHeader("content-type", "text/plain; charset=utf-8")
  response.end("Internal Server Error")
}

/** Dispatches one native request and tracks it through response terminal. */
function dispatchRequest(
  runtime: NodeHostRuntime,
  request: NodeIncomingMessage,
  response: NodeServerResponse
): void {
  const handler = runtime.handler
  if (handler === null || runtime.mode !== "serving") {
    unavailable(request, response)
    return
  }
  const selectedHandler: HTTPHandler = handler
  runtime.activeHandlers += 1
  const aborter = new AbortController()
  let released = false
  let nativeTerminal = false
  let runSettled = false
  let forced = false
  let inputReleased = false
  /** Aborts the standard Request when native input is abandoned. */
  function abortRequest(reason: Error = new Error("Node HTTP request aborted")): void {
    if (!aborter.signal.aborted) aborter.abort(reason)
  }
  /** Preserves native request error identity while the input remains owned. */
  function nativeRequestFailed(error: Error): void {
    abortRequest(error)
  }
  /** Releases native input observers exactly once at request terminal. */
  function releaseInput(): void {
    if (inputReleased) return
    inputReleased = true
    request.removeListener("aborted", abortRequest)
    request.removeListener("error", nativeRequestFailed)
    request.removeListener("close", releaseInput)
  }
  /** Releases this request owner exactly once at native response terminal. */
  function releaseRequest(): void {
    if (released || !runSettled || (!nativeTerminal && !forced)) return
    released = true
    response.removeListener("finish", responseTerminal)
    response.removeListener("close", responseTerminal)
    runtime.requests.delete(control)
    runtime.activeHandlers -= 1
    if (runtime.closeStarted) closeIdleConnections(runtime)
    maybeFinish(runtime)
  }
  /** Records native response terminal independently from borrowed handler terminal. */
  function responseTerminal(): void {
    if (nativeTerminal) return
    nativeTerminal = true
    if (!response.writableFinished) abortRequest()
    releaseRequest()
  }
  /** Forces this request while retaining borrowed handler terminal as a barrier. */
  function forceRequest(): void {
    forced = true
    abortRequest()
    try {
      response.destroy()
    } catch (error) {
      admitCleanup(runtime, error, "Node HTTP response destroy failed")
    } finally {
      releaseRequest()
    }
  }
  const control: NodeActiveRequest = Object.freeze({ force: forceRequest })
  runtime.requests.add(control)
  request.once("aborted", abortRequest)
  request.on("error", nativeRequestFailed)
  request.once("close", releaseInput)
  response.once("finish", responseTerminal)
  response.once("close", responseTerminal)

  /** Runs borrowed standard handler work without rejecting from an event callback. */
  async function run(): Promise<void> {
    try {
      const envelope: HTTPHostRequest = Object.freeze({
        request: standardRequest(runtime, request, aborter),
        localAddress: requestLocalAddress(runtime, request),
        remoteAddress:
          request.socket.remoteAddress === undefined
            ? ""
            : formatAddress(request.socket.remoteAddress, request.socket.remotePort ?? 0)
      })
      const output = await selectedHandler(envelope)
      if (!(output instanceof Response))
        throw new TypeError("Node HTTP handler must return a Response")
      await writeResponse(response, output, aborter.signal)
    } catch {
      handlerFailure(response)
    } finally {
      runSettled = true
      releaseRequest()
    }
  }
  observe(run())
}

/** Creates the complete per-bind runtime before any listen side effect. */
function makeRuntime(
  factory: NodeNativeServerFactory,
  options: HTTPHostListenOptions
): NodeHostRuntime {
  const terminal = deferred<void>()
  let runtime: NodeHostRuntime | null = null
  /** Delegates one native request to the admitted per-bind runtime. */
  function listener(request: NodeIncomingMessage, response: NodeServerResponse): void {
    const active = runtime
    if (active === null) {
      unavailable(request, response)
      return
    }
    dispatchRequest(active, request, response)
  }
  const server = factory(listener, options)
  const created: NodeHostRuntime = {
    server,
    terminal,
    sockets: new Set(),
    destroyedSockets: new WeakSet(),
    sessions: new Set(),
    destroyedSessions: new WeakSet(),
    cleanupFailures: [],
    requests: new Set(),
    mode: "binding",
    address: "",
    secure: options.secure || options.tlsConfig !== null,
    handler: null,
    primaryFailure: null,
    activeHandlers: 0,
    closeStarted: false,
    nativeCloseStarted: false,
    closeObserved: false,
    bindPending: true,
    forceStarted: false,
    settled: false,
    serveUsed: false,
    serveSignal: null,
    serveAbort: null
  }
  runtime = created
  observe(terminal.promise)
  return created
}

/** Installs native lifecycle observers before listen begins. */
function observeRuntime(runtime: NodeHostRuntime): void {
  runtime.server.onConnection(function connected(socket: Socket): void {
    runtime.sockets.add(socket)
    socket.once("close", function socketClosed(): void {
      runtime.sockets.delete(socket)
      maybeFinish(runtime)
    })
    if (runtime.forceStarted) destroySockets(runtime)
  })
  runtime.server.onSession(function sessionStarted(session): void {
    runtime.sessions.add(session)
    session.once("close", function sessionClosed(): void {
      runtime.sessions.delete(session)
      maybeFinish(runtime)
    })
    if (runtime.forceStarted) destroySessions(runtime)
    else if (runtime.closeStarted) closeSessions(runtime)
  })
  runtime.server.onClose(function nativeClosed(): void {
    runtime.bindPending = false
    runtime.closeObserved = true
    if (!runtime.closeStarted) runtime.closeStarted = true
    maybeFinish(runtime)
  })
  runtime.server.onError(function nativeFailed(value: Error): void {
    runtime.bindPending = false
    admitPrimary(runtime, value)
    startForce(runtime)
  })
}

/** Creates the structural runtime handle after native listen admission. */
function runtimeHandle(runtime: NodeHostRuntime): HTTPHostHandle {
  const ready = Promise.resolve()
  return Object.freeze({
    /** Returns the immutable actual bound address. */
    address(): string {
      return runtime.address
    },
    /** Installs the one-shot request dispatcher after bind. */
    serve(ctx: Context, handler: HTTPHandler): HTTPServeHandle {
      if (runtime.serveUsed || runtime.mode !== "bound") {
        throw newTransportStateError("Node HTTP host serve is one-shot")
      }
      if (typeof handler !== "function") throw new TypeError("Node HTTP handler must be a function")
      let signal: AbortSignal | null = null
      let attached = false
      let committed = false
      let canceledBeforeCommit = false
      /** Starts graceful native close only after request ownership is committed. */
      function serveCanceled(): void {
        if (!committed) {
          canceledBeforeCommit = true
          return
        }
        startClose(runtime)
      }
      /** Rolls back a borrowed Context observer or force-closes when detach cannot be proven. */
      function failAdmission(value: unknown): never {
        const primary = normalizeHTTPError(value, "Node HTTP serve Context inspection failed")
        let detachFailure: Error | null = null
        if (signal !== null && attached) {
          attached = false
          detachFailure = removeAbortListener(
            signal,
            serveCanceled,
            "Node HTTP serve Context detach failed"
          )
        }
        if (detachFailure !== null) {
          admitPrimary(runtime, primary)
          admitCleanup(runtime, detachFailure, "Node HTTP serve Context detach failed")
          startForce(runtime)
        }
        throw primary
      }
      try {
        const initial = ctx.err()
        if (initial !== null) throw contextFailure(ctx)
        signal = ctx.done()
        if (signal !== null) {
          attached = true
          signal.addEventListener("abort", serveCanceled, { once: true })
        }
        const raced = ctx.err()
        if (raced !== null || canceledBeforeCommit) throw contextFailure(ctx)
      } catch (error) {
        failAdmission(error)
      }
      runtime.serveUsed = true
      runtime.handler = handler
      runtime.mode = "serving"
      runtime.serveSignal = signal
      runtime.serveAbort = signal === null ? null : serveCanceled
      committed = true
      return Object.freeze({
        /** Resolves after the dispatcher is synchronously installed. */
        ready(): Promise<void> {
          return ready
        },
        /** Returns the same true native terminal Promise. */
        done(): Promise<void> {
          return runtime.terminal.promise
        }
      })
    },
    /** Returns the stable true native terminal Promise. */
    done(): Promise<void> {
      return runtime.terminal.promise
    },
    /** Starts one graceful close while ctx bounds only this caller. */
    close(ctx: Context): Promise<void> {
      startClose(runtime)
      return waitForContext(ctx, runtime.terminal.promise)
    },
    /** Executes close-first native force without pretending terminal settlement. */
    forceClose(reason: Error): Promise<void> {
      if (!(reason instanceof Error))
        return Promise.reject(new TypeError("Node HTTP force reason must be an Error"))
      startForce(runtime)
      return Promise.resolve()
    }
  })
}

/** Binds one fresh native runtime and preserves startup failure identity. */
async function bindRuntime(
  factory: NodeNativeServerFactory,
  capabilities: HTTPHostCapabilities,
  ctx: Context,
  address: string,
  options: HTTPHostListenOptions
): Promise<HTTPHostHandle> {
  let target: { readonly hostname: string; readonly port: number }
  try {
    if ((options.secure || options.tlsConfig !== null) && !capabilities.tls) {
      throw new TypeError("Node HTTP host does not support TLS")
    }
    const initial = ctx.err()
    if (initial !== null) throw contextFailure(ctx)
    target = parseAddress(address)
  } catch (error) {
    throw normalizeHTTPError(error, "Node HTTP host construction failed")
  }
  let runtime: NodeHostRuntime
  try {
    runtime = makeRuntime(factory, options)
    observeRuntime(runtime)
  } catch (error) {
    throw normalizeHTTPError(error, "Node HTTP host construction failed")
  }

  return await new Promise<HTTPHostHandle>(function bind(resolve, reject): void {
    let settled = false
    let signal: AbortSignal | null = null
    let attached = false
    let registeringContext = false
    let canceledDuringRegistration = false
    /** Detaches the startup Context observer and returns a hostile signal failure. */
    function cleanupContext(): Error | null {
      if (signal === null || !attached) return null
      attached = false
      return removeAbortListener(signal, canceledBind, "Node HTTP bind Context detach failed")
    }
    /** Rejects bind only after true native cleanup converges. */
    function failBind(failure: Error): void {
      if (settled) return
      settled = true
      admitPrimary(runtime, failure)
      const detachFailure = cleanupContext()
      if (detachFailure !== null) {
        admitCleanup(runtime, detachFailure, "Node HTTP bind Context detach failed")
      }
      startForce(runtime)
      runtime.terminal.promise
        .catch(function failedBind(error: Error): Error {
          return error
        })
        .then(reject)
    }
    /** Converts startup Context cancellation into active native cleanup. */
    function canceledBind(): void {
      if (settled) return
      if (registeringContext) {
        canceledDuringRegistration = true
        return
      }
      try {
        failBind(contextFailure(ctx))
      } catch (error) {
        failBind(normalizeHTTPError(error, "Node HTTP bind Context inspection failed"))
      }
    }
    try {
      signal = ctx.done()
    } catch (error) {
      failBind(normalizeHTTPError(error, "Node HTTP bind Context inspection failed"))
      return
    }
    if (signal !== null) {
      attached = true
      registeringContext = true
      try {
        signal.addEventListener("abort", canceledBind, { once: true })
      } catch (error) {
        failBind(normalizeHTTPError(error, "Node HTTP bind Context observation failed"))
        return
      } finally {
        registeringContext = false
      }
      if (canceledDuringRegistration) {
        canceledBind()
        return
      }
    }
    try {
      runtime.server.onceListening(function listening(): void {
        runtime.bindPending = false
        if (settled) {
          startClose(runtime)
          return
        }
        try {
          runtime.address = boundAddress(runtime.server)
        } catch (error) {
          failBind(normalizeHTTPError(error, "Node HTTP bound address failed"))
          return
        }
        const detachFailure = cleanupContext()
        if (detachFailure !== null) {
          failBind(detachFailure)
          return
        }
        if (settled) return
        settled = true
        runtime.mode = "bound"
        resolve(runtimeHandle(runtime))
      })
    } catch (error) {
      failBind(normalizeHTTPError(error, "Node HTTP listening observation failed"))
      return
    }
    runtime.terminal.promise.catch(function bindTerminal(error: Error): void {
      if (!settled) failBind(error)
    })
    try {
      runtime.server.listen(target.hostname, target.port)
    } catch (error) {
      runtime.bindPending = false
      if (!settled) failBind(normalizeHTTPError(error, "Node HTTP listen threw"))
    }
    if (settled) return
    try {
      if (ctx.err() !== null) canceledBind()
    } catch (error) {
      failBind(normalizeHTTPError(error, "Node HTTP bind Context inspection failed"))
    }
  })
}

/** Creates a Node HTTP host with an internal native factory seam for conformance tests. */
export function newNodeHTTPHostWithFactory(factory: NodeHTTPServerFactory): HTTPHost {
  const selectedFactory = factory.bind(undefined)
  const nativeFactory = plainFactory(selectedFactory)
  return Object.freeze({
    /** Returns the stable immutable runtime capability snapshot. */
    capabilities(): HTTPHostCapabilities {
      return PlainCapabilities
    },
    /** Binds one independently owned native Node HTTP server. */
    bind(ctx: Context, address: string, options: HTTPHostListenOptions): Promise<HTTPHostHandle> {
      return bindRuntime(nativeFactory, PlainCapabilities, ctx, address, options)
    }
  })
}

/** Creates a secure Node host with an internal native factory seam for lifecycle fault tests. */
export function newNodeHTTPHostWithSecureFactory(
  factory: NodeSecureHTTPServerFactory,
  ...options: readonly NodeHTTPHostOption[]
): HTTPHost {
  const selectedFactory = factory.bind(undefined)
  const hostOptions = applyNodeHTTPHostOptions(options)
  const nativeFactory = secureFactory(hostOptions, selectedFactory)
  return Object.freeze({
    /** Returns the stable secure runtime capability snapshot. */
    capabilities(): HTTPHostCapabilities {
      return SecureCapabilities
    },
    /** Binds one independently owned native secure Node HTTP/2 server. */
    bind(
      ctx: Context,
      address: string,
      listenOptions: HTTPHostListenOptions
    ): Promise<HTTPHostHandle> {
      return bindRuntime(nativeFactory, SecureCapabilities, ctx, address, listenOptions)
    }
  })
}

/** Creates the Node HTTP runtime host without binding a network resource. */
export function newNodeHTTPHost(...options: readonly NodeHTTPHostOption[]): HTTPHost {
  const hostOptions = applyNodeHTTPHostOptions(options)
  const factory = defaultFactory(hostOptions)
  return Object.freeze({
    /** Returns the stable immutable runtime capability snapshot. */
    capabilities(): HTTPHostCapabilities {
      return SecureCapabilities
    },
    /** Binds one plaintext HTTP/1 or secure HTTP/2 server from explicit listen options. */
    bind(
      ctx: Context,
      address: string,
      listenOptions: HTTPHostListenOptions
    ): Promise<HTTPHostHandle> {
      return bindRuntime(factory, SecureCapabilities, ctx, address, listenOptions)
    }
  })
}
