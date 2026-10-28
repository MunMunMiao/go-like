import type { ConnectRouter } from "@connectrpc/connect"
import { connectNodeAdapter, type ConnectNodeAdapterOptions } from "@connectrpc/connect-node"
import { cause, type Context } from "@go-like/context"
import type { Endpointer, Server as CoreServer } from "@go-like/core"
import { waitForContext } from "@go-like/core/lifecycle"
import { Buffer } from "node:buffer"
import {
  createSecureServer as createSecureHTTP2Server,
  createServer as createHTTP2Server
} from "node:http2"
import type { AddressInfo } from "node:net"

import type { Routes, ServiceRegistrar } from "./handler"
import {
  isWildcardServerHost,
  parseServerAddress,
  parseServerAdvertise,
  serverOptions,
  type ServerOption,
  type ServerOptions
} from "./options"

type NodeHandler = ReturnType<typeof connectNodeAdapter>

/** Structural HTTP/2 session used only by the private construction seam. */
export interface NativeHTTP2Session {
  close(): void
  destroy(reason?: Error): void
  once(event: "close", listener: () => void): this
}

/** Structural HTTP/2 owner used only by the private construction seam. */
export interface NativeHTTP2Server {
  on(event: "listening", listener: () => void): this
  on(event: "error", listener: (error: Error) => void): this
  on(event: "session", listener: (session: NativeHTTP2Session) => void): this
  on(event: "close", listener: () => void): this
  listen(options: { readonly host: string; readonly port: number }): this
  address(): AddressInfo | string | null
  close(callback: (error?: Error) => void): this
}

/** Detached Node TLS inputs used only by the private construction seam. */
export interface ServerTLSOptions {
  readonly key: Buffer
  readonly cert: Buffer
  readonly ca?: Buffer
  readonly requestCert: boolean
  readonly rejectUnauthorized: boolean
  readonly allowHTTP1: false
}

/** Private factories for deterministic lifecycle tests; not exported by the package. */
export interface ServerFactories {
  createAdapter(options: ConnectNodeAdapterOptions): NodeHandler
  createServer(options: ServerTLSOptions | null, handler: NodeHandler): NativeHTTP2Server
}

/** One managed standard-gRPC Server and protobuf service registrar. */
export interface Server extends CoreServer, Endpointer, ServiceRegistrar {}

interface RouteRegistration {
  readonly typeName: string
  apply(server: ServiceRegistrar): void
}

interface BoundEndpoint {
  readonly endpoint: string
}

const defaultFactories: ServerFactories = Object.freeze({
  createAdapter(options: ConnectNodeAdapterOptions): NodeHandler {
    return connectNodeAdapter(options)
  },
  createServer(options: ServerTLSOptions | null, handler: NodeHandler): NativeHTTP2Server {
    const server =
      options === null ? createHTTP2Server({}, handler) : createSecureHTTP2Server(options, handler)
    return server as unknown as NativeHTTP2Server
  }
})

/** Preserves Error identity and supplies one stable native boundary otherwise. */
function boundaryError(value: unknown, message: string): Error {
  return value instanceof Error ? value : new Error(message, { cause: value })
}

/** Returns the effective terminal error of one Context when it has one. */
function contextError(ctx: Context): Error | null {
  try {
    const error = ctx.err()
    return error === null ? null : (cause(ctx) ?? error)
  } catch (value) {
    return boundaryError(value, "gRPC server Context inspection failed")
  }
}

/** Formats one host for an HTTP URL without duplicating IPv6 brackets. */
function urlHost(host: string): string {
  if (host.startsWith("[") && host.endsWith("]")) return host
  return host.includes(":") ? `[${host}]` : host
}

/** Resolves the externally dialable endpoint from one actual bound address. */
function publishedEndpoint(options: ServerOptions, bound: AddressInfo): string {
  if (!Number.isInteger(bound.port) || bound.port <= 0 || bound.port > 65_535) {
    throw new TypeError("gRPC server listening address must contain an assigned TCP port")
  }
  const advertised = options.advertise === null ? null : parseServerAdvertise(options.advertise)
  if (advertised?.absolute !== null && advertised?.absolute !== undefined) {
    return advertised.absolute.toString()
  }
  const host = advertised?.host ?? bound.address
  if (isWildcardServerHost(host)) {
    throw new TypeError("gRPC server cannot publish a wildcard endpoint")
  }
  const port = advertised?.port.length ? Number(advertised.port) : bound.port
  const scheme = options.tlsConfig === null ? "http" : "https"
  return new URL(`${scheme}://${urlHost(host)}:${port}/`).toString()
}

/** Maps copied portable PEM material into detached Node HTTP/2 server inputs. */
function nativeTLSOptions(options: ServerOptions): ServerTLSOptions | null {
  const config = options.tlsConfig
  if (config === null) return null
  const certificate = config.certificateChain!
  const privateKey = config.privateKey!
  const requireClient = options.clientAuth === "require"
  const ca = config.caCertificate
  return {
    key: Buffer.from(privateKey.bytes),
    cert: Buffer.from(certificate.bytes),
    ...(ca === null ? {} : { ca: Buffer.from(ca.bytes) }),
    requestCert: requireClient,
    rejectUnauthorized: requireClient,
    allowHTTP1: false
  }
}

/** Builds the managed owner with an injectable, package-private native seam. */
export function newServerForTest(
  factories: ServerFactories,
  ...optionList: readonly ServerOption[]
): Server {
  const options = serverOptions(optionList)
  const bind = parseServerAddress(options.address)
  const registrations: RouteRegistration[] = []
  const registeredTypeNames = new Set<string>()
  const sessions = new Set<NativeHTTP2Session>()
  const stoppedError = new Error("gRPC server is stopped")

  let grpcServer!: Server
  let sealed = false
  let started = false
  let stopping = false
  let forcedReason: Error | null = null
  let nativeServer: NativeHTTP2Server | null = null
  let shutdown: AbortController | null = null
  let bindingState: "idle" | "binding" | "bound" | "failed" = "idle"
  let binding: Promise<BoundEndpoint> | null = null
  let bindingResolve: ((value: BoundEndpoint) => void) | null = null
  let bindingReject: ((reason?: unknown) => void) | null = null
  let nativeClosed = false
  let nativeCleanup: Promise<void> | null = null
  let nativeCleanupResolve: (() => void) | null = null
  let cleanup: Promise<void> | null = null
  let cleanupDone = false
  let runtimeFailure: Error | null = null
  let terminalSettled = false
  const terminal = Promise.withResolvers<void>()
  void terminal.promise.catch(() => {})

  function resolveTerminal(): void {
    if (terminalSettled) return
    terminalSettled = true
    terminal.resolve()
  }

  function rejectTerminal(error: Error): void {
    if (terminalSettled) return
    terminalSettled = true
    terminal.reject(error)
  }

  function closeSession(session: NativeHTTP2Session): void {
    if (forcedReason !== null) {
      try {
        session.destroy(forcedReason)
      } catch {
        // Force close is best effort after the caller's bounded wait has expired.
      }
      return
    }
    try {
      session.close()
    } catch {
      // Native server close remains the authoritative drain completion boundary.
    }
  }

  function trackSession(session: NativeHTTP2Session): void {
    sessions.add(session)
    session.once("close", () => sessions.delete(session))
    if (stopping) closeSession(session)
  }

  function startNativeCleanup(): Promise<void> {
    if (nativeCleanup !== null) return nativeCleanup
    const deferred = Promise.withResolvers<void>()
    nativeCleanup = deferred.promise
    nativeCleanupResolve = deferred.resolve
    void nativeCleanup.catch(() => {})

    const owner = nativeServer
    if (owner === null || nativeClosed) {
      for (const session of sessions) closeSession(session)
      deferred.resolve()
      return nativeCleanup
    }

    try {
      owner.close((error) => {
        if (error === undefined) deferred.resolve()
        else deferred.reject(error)
      })
    } catch (value) {
      deferred.reject(boundaryError(value, "gRPC server close failed"))
    }
    for (const session of sessions) closeSession(session)
    return nativeCleanup
  }

  function finishCleanup(operation: Promise<void>): Promise<void> {
    const finished = operation.then(
      () => {
        cleanupDone = true
        if (runtimeFailure === null) resolveTerminal()
      },
      (value: unknown) => {
        cleanupDone = true
        const error = boundaryError(value, "gRPC server cleanup failed")
        if (runtimeFailure === null) rejectTerminal(error)
        throw error
      }
    )
    void finished.catch(() => {})
    return finished
  }

  function beginCleanup(): Promise<void> {
    if (cleanup !== null) return cleanup
    stopping = true
    sealed = true

    if (bindingState === "idle" || (bindingState === "failed" && nativeServer === null)) {
      cleanupDone = true
      resolveTerminal()
      cleanup = Promise.resolve()
      return cleanup
    }
    if (bindingState === "bound" || bindingState === "failed") {
      cleanup = finishCleanup(startNativeCleanup())
      return cleanup
    }

    const pending = binding!
    cleanup = finishCleanup(
      pending.then(
        () => startNativeCleanup(),
        () => (nativeServer === null ? undefined : startNativeCleanup())
      )
    )
    return cleanup
  }

  function forceCleanup(error: Error): void {
    if (forcedReason !== null) return
    forcedReason = error
    shutdown?.abort(error)
    for (const session of sessions) closeSession(session)
  }

  function failRuntime(value: unknown): void {
    if (runtimeFailure !== null) return
    const error = boundaryError(value, "gRPC server runtime failed")
    runtimeFailure = error
    rejectTerminal(error)
    void beginCleanup()
    forceCleanup(error)
  }

  function onListening(): void {
    if (bindingState !== "binding") return
    const owner = nativeServer
    if (owner === null) return
    const address = owner.address()
    if (address === null || typeof address === "string") {
      const error = new TypeError("gRPC server listening address must be an AddressInfo")
      bindingState = "failed"
      bindingReject?.(error)
      void beginCleanup()
      return
    }
    let endpoint: string
    try {
      endpoint = publishedEndpoint(options, address)
    } catch (value) {
      bindingState = "failed"
      bindingReject?.(value)
      void beginCleanup()
      return
    }
    bindingState = "bound"
    bindingResolve?.({ endpoint })
    if (stopping) void startNativeCleanup()
  }

  function onNativeError(error: Error): void {
    if (bindingState === "binding") {
      bindingState = "failed"
      bindingReject?.(error)
      void beginCleanup()
      return
    }
    if (bindingState === "bound") failRuntime(error)
  }

  function onNativeClose(): void {
    nativeClosed = true
    nativeCleanupResolve?.()
    if (bindingState === "binding") {
      const error = new Error("gRPC server closed before listening")
      bindingState = "failed"
      bindingReject?.(error)
      if (!stopping) void beginCleanup()
      return
    }
    if (!stopping && bindingState === "bound") {
      failRuntime(new Error("gRPC server closed unexpectedly"))
    }
  }

  function cacheBindingFailure(value: unknown): Promise<BoundEndpoint> {
    const error = boundaryError(value, "gRPC server seal failed")
    bindingState = "failed"
    binding = Promise.reject(error)
    void binding.catch(() => {})
    return binding
  }

  function beginBind(): Promise<BoundEndpoint> {
    if (stopping) return Promise.reject(stoppedError)
    if (binding !== null) return binding
    sealed = true
    if (registrations.length === 0) {
      return cacheBindingFailure(new TypeError("gRPC server requires at least one service"))
    }

    const replay = Object.freeze([...registrations])
    const routes: Routes = (server) => {
      for (const registration of replay) registration.apply(server)
    }
    const shutdownController = new AbortController()
    shutdown = shutdownController
    const adapterOptions: ConnectNodeAdapterOptions = {
      routes,
      grpc: true,
      grpcWeb: false,
      connect: false,
      shutdownSignal: shutdownController.signal
    }

    let handler: NodeHandler
    let owner: NativeHTTP2Server
    try {
      handler = factories.createAdapter(adapterOptions)
      owner = factories.createServer(nativeTLSOptions(options), handler)
    } catch (value) {
      return cacheBindingFailure(value)
    }

    nativeServer = owner
    bindingState = "binding"
    const deferred = Promise.withResolvers<BoundEndpoint>()
    binding = deferred.promise
    bindingResolve = deferred.resolve
    bindingReject = deferred.reject
    void binding.catch(() => {})
    owner.on("listening", onListening)
    owner.on("error", onNativeError)
    owner.on("session", trackSession)
    owner.on("close", onNativeClose)
    try {
      owner.listen(bind)
    } catch (value) {
      bindingState = "failed"
      deferred.reject(boundaryError(value, "gRPC server listen failed"))
      void beginCleanup()
    }
    return binding
  }

  const service: ServiceRegistrar["service"] = function registerService(
    descriptor,
    implementation,
    serviceOptions
  ) {
    if (sealed) throw new TypeError("gRPC server registration is sealed")
    if (typeof descriptor.typeName !== "string" || descriptor.typeName.length === 0) {
      throw new TypeError("gRPC service descriptor typeName must be non-empty")
    }
    if (registeredTypeNames.has(descriptor.typeName)) {
      throw new TypeError(`gRPC service already registered: ${descriptor.typeName}`)
    }
    const capturedServiceOptions =
      serviceOptions === undefined
        ? undefined
        : Object.freeze({
            ...serviceOptions,
            ...(serviceOptions.acceptCompression === undefined
              ? {}
              : { acceptCompression: [...serviceOptions.acceptCompression] }),
            ...(serviceOptions.interceptors === undefined
              ? {}
              : { interceptors: [...serviceOptions.interceptors] }),
            ...(serviceOptions.jsonOptions === undefined
              ? {}
              : { jsonOptions: { ...serviceOptions.jsonOptions } }),
            ...(serviceOptions.binaryOptions === undefined
              ? {}
              : { binaryOptions: { ...serviceOptions.binaryOptions } })
          })
    registeredTypeNames.add(descriptor.typeName)
    registrations.push(
      Object.freeze({
        typeName: descriptor.typeName,
        apply(server: ServiceRegistrar): void {
          const replayOptions = {
            ...capturedServiceOptions,
            grpc: true,
            grpcWeb: false,
            connect: false
          }
          server.service(descriptor, implementation, replayOptions)
        }
      })
    )
    return grpcServer as Server & ConnectRouter
  }

  function lifecycleAdmissionError(ctx: Context): Error | null {
    sealed = true
    if (stopping) return stoppedError
    if (binding !== null || registrations.length === 0) return null
    return contextError(ctx)
  }

  grpcServer = Object.freeze({
    service,
    protocol(): string {
      return "grpc"
    },
    endpoint(ctx: Context): Promise<string> {
      const admissionError = lifecycleAdmissionError(ctx)
      if (admissionError !== null) return Promise.reject(admissionError)
      const pending = beginBind().then((result) => result.endpoint)
      return waitForContext(ctx, pending)
    },
    start(ctx: Context): Promise<void> {
      const admissionError = lifecycleAdmissionError(ctx)
      if (admissionError !== null) return Promise.reject(admissionError)
      if (started) return Promise.reject(new TypeError("gRPC server can only be started once"))
      started = true
      const pending = beginBind().then(() => terminal.promise)
      return waitForContext(ctx, pending)
    },
    stop(ctx: Context): Promise<void> {
      const pending = beginCleanup()
      return waitForContext(ctx, pending).catch((value: unknown) => {
        let expired = false
        try {
          expired = ctx.err() !== null
        } catch {
          expired = false
        }
        if (expired && !cleanupDone) {
          forceCleanup(boundaryError(value, "gRPC server stop Context expired"))
        }
        throw value
      })
    }
  })
  return grpcServer
}

/** Creates one managed standard-gRPC Server without performing native I/O. */
export function newServer(...options: readonly ServerOption[]): Server {
  return newServerForTest(defaultFactories, ...options)
}
