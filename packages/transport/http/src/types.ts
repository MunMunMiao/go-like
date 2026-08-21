import type { Context } from "@go-like/context"
import type { Listener, ListenOptions, TLSConfig, Transport } from "@go-like/transport"

/** Executes one standard Fetch request. */
export interface HTTPExecutor {
  /** Executes one standard RequestInfo value and returns its standard Response. */
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>
}

/** Contains HTTP-specific transport construction configuration. */
export interface HTTPTransportOptions {
  readonly executor: HTTPExecutor
  /** Maximum unary request or successful-response body size in bytes. */
  readonly maxMessageBytes: number
}

/** Immutably reduces HTTP-specific transport construction configuration. */
export type HTTPTransportOption = (options: HTTPTransportOptions) => HTTPTransportOptions

/** Contains HTTP-specific options for one listen operation. */
export interface HTTPListenOptions extends ListenOptions {
  readonly host: HTTPHost | null
}

/** Immutably reduces HTTP-specific listen configuration. */
export type HTTPListenOption = (options: HTTPListenOptions) => HTTPListenOptions

/** Dispatches one standard HTTP request envelope. */
export type HTTPHandler = (input: HTTPHostRequest) => Response | Promise<Response>

/** Carries a standard Request and optional connection metadata from a runtime host. */
export interface HTTPHostRequest {
  readonly request: Request
  readonly localAddress: string
  readonly remoteAddress: string
  /** Verified client URI SAN when `clientAuth("require")` admitted the connection. */
  readonly peerIdentity?: string
}

/** Declares capabilities a borrowed runtime HTTP host can actually honor. */
export interface HTTPHostCapabilities {
  readonly tls: boolean
  readonly forceClose: boolean
  readonly connectionMetadata: boolean
}

/** Carries the portable listen configuration admitted before host bind. */
export interface HTTPHostListenOptions {
  readonly secure: boolean
  readonly tlsConfig: TLSConfig | null
}

/** Supplies runtime-specific HTTP binding behind a standard Web API boundary. */
export interface HTTPHost {
  /** Returns an immutable capability snapshot before bind. */
  capabilities(): HTTPHostCapabilities
  /** Binds one address and returns its owned runtime handle. */
  bind(ctx: Context, address: string, options: HTTPHostListenOptions): Promise<HTTPHostHandle>
}

/** Owns one bound runtime HTTP endpoint. */
export interface HTTPHostHandle {
  /** Returns the actual bound address. */
  address(): string
  /** Starts serving and returns independently observable admission and terminal state. */
  serve(ctx: Context, handler: HTTPHandler): HTTPServeHandle
  /** Returns the stable host terminal Promise. */
  done(): Promise<void>
  /** Starts graceful host cleanup while ctx bounds only this caller's wait. */
  close(ctx: Context): Promise<void>
  /** Optionally starts force cleanup when the host declared that capability. */
  forceClose?(reason: Error): Promise<void>
}

/** Exposes runtime server admission and terminal state. */
export interface HTTPServeHandle {
  /** Resolves once requests can be dispatched. */
  ready(): Promise<void>
  /** Returns the stable serve terminal Promise. */
  done(): Promise<void>
}

/** Implements go-like Transport with a portable unary HTTP wire. */
export interface HTTPTransport extends Transport {
  /** Binds one HTTP listener through a borrowed runtime host. */
  listen(
    ctx: Context,
    address: string,
    ...options: readonly HTTPListenOption[]
  ): Promise<HTTPListener>
}

/** Extends Listener with a stable request-admission Promise. */
export interface HTTPListener extends Listener {
  /** Returns the identity-stable admission Promise. */
  accepted(): Promise<void>
}

/** Describes a bounded non-200 HTTP response. */
export interface HTTPStatusError extends Error {
  readonly name: "HTTPStatusError"
  readonly code: "GO_LIKE_HTTP_STATUS"
  readonly status: number
  readonly statusText: string
  readonly body: Uint8Array
  readonly bodyTruncated: boolean
}

/** Describes a runtime host or serve loop that ended without an upstream Error. */
export interface HTTPTransportUnexpectedExitError extends Error {
  readonly name: "HTTPTransportUnexpectedExitError"
  readonly code: "GO_LIKE_HTTP_TRANSPORT_UNEXPECTED_EXIT"
  readonly source: "serve" | "host"
  readonly phase: "before-ready" | "running"
}
