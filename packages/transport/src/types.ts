import type { Context } from "@go-like/context"
import type { Metadata } from "@go-like/metadata"

/** Configures and creates internal service transport clients and listeners. */
export interface Transport {
  /** Returns the provider-neutral protocol kind when the implementation can identify it. */
  kind?(): string
  /** Applies common options in declaration order without performing I/O. */
  init(...options: readonly Option[]): void
  /** Returns an immutable defensive snapshot of the current common options. */
  options(): Options
  /** Creates a client for address under the supplied operation Context. */
  dial(ctx: Context, address: string, ...options: readonly DialOption[]): Promise<Client>
  /** Creates a bound listener for address under the supplied operation Context. */
  listen(ctx: Context, address: string, ...options: readonly ListenOption[]): Promise<Listener>
  /** Returns the implementation's stable diagnostic name. */
  string(): string
}

/** Exposes provider-neutral transport details carried through one operation Context. */
export interface TransportInfo {
  /** Returns the stable provider kind, such as http or nats. */
  kind(): string
  /** Returns the provider endpoint, or an empty string when unavailable. */
  endpoint(): string
  /** Returns the provider operation name, or an empty string when unavailable. */
  operation(): string
  /** Returns an immutable current request-header snapshot. */
  requestHeaders(): Metadata
  /** Returns an immutable current reply-header snapshot. */
  replyHeaders(): Metadata
}

/** Carries one immutable header snapshot and one defensively copied binary body. */
export interface Message {
  readonly header: Readonly<Record<string, string>>
  readonly body: Uint8Array
}

/** Describes one immutable provider-neutral service failure. */
export interface ServiceError extends Error {
  readonly name: "ServiceError"
  readonly code: string
  readonly status: number
  readonly metadata: Readonly<Record<string, string>>
}

/** Carries one canonical ServiceError across a concrete transport boundary. */
export interface ServiceErrorEnvelope {
  readonly serviceStatus: number
  readonly carrierStatus: number
  readonly header: Readonly<Record<string, string>>
  readonly body: Uint8Array
}

/** Selects the canonical internal unary ServiceError wire. */
export type ServiceErrorWireKind = "unary"

/** Exchanges Messages over one owned transport connection or request slot. */
export interface Socket {
  /** Receives one Message while ctx remains active. */
  recv(ctx: Context): Promise<Message>
  /** Sends one Message while ctx remains active. */
  send(ctx: Context, message: Message): Promise<void>
  /** Idempotently closes this Socket while ctx bounds only the caller's wait. */
  close(ctx: Context): Promise<void>
  /** Returns the opaque local address, or an empty string when unavailable. */
  local(): string
  /** Returns the opaque remote address, or an empty string when unavailable. */
  remote(): string
}

/** Represents a structural transport Socket reusable for sequential exchanges until close. */
export interface Client extends Socket {}

/** Handles one accepted Socket with a Context derived from the accept operation. */
export type AcceptHandler = (ctx: Context, socket: Socket) => void | PromiseLike<void>

/** Owns one bound transport endpoint and one one-shot accept loop. */
export interface Listener {
  /** Returns the actual bound opaque address. */
  addr(): string
  /** Idempotently closes the listener while ctx bounds only the caller's wait. */
  close(ctx: Context): Promise<void>
  /** Runs the one-shot accept loop until close, cancellation, or host failure. */
  accept(ctx: Context, handler: AcceptHandler): Promise<void>
}

/** Enumerates diagnostic levels accepted by a structural TransportLogger. */
export type TransportLogLevel = "debug" | "info" | "warn" | "error"

/** Receives optional transport diagnostics without controlling protocol results. */
export interface TransportLogger {
  /** Records one diagnostic event; implementations must isolate sink failures. */
  log(level: TransportLogLevel, message: string, fields?: Readonly<Record<string, unknown>>): void
}

/** Converts Messages to and from one implementation-specific binary representation. */
export interface MessageCodec {
  /** Marshals a defensive Message snapshot into detached bytes. */
  marshal(message: Message): Uint8Array
  /** Unmarshals detached bytes into a defensive Message snapshot. */
  unmarshal(bytes: Uint8Array): Message
}

/** Identifies the encoding used by portable TLS material. */
export type TLSEncoding = "pem" | "der"

/** Holds one defensively copied portable TLS byte sequence. */
export interface TLSEncodedBytes {
  readonly encoding: TLSEncoding
  readonly bytes: Uint8Array
}

/** Describes portable TLS identity and trust material without runtime-specific types. */
export interface TLSConfig {
  readonly serverName: string | null
  readonly caCertificate: TLSEncodedBytes | null
  readonly certificateChain: TLSEncodedBytes | null
  readonly privateKey: TLSEncodedBytes | null
}

/** Contains common immutable Transport configuration. */
export interface Options {
  readonly codec: MessageCodec | null
  readonly logger: TransportLogger | null
  readonly timeoutMs: number
  readonly secure: boolean
  readonly tlsConfig: TLSConfig | null
}

/** Contains immutable options for one dial operation. */
export interface DialOptions {
  readonly timeoutMs: number
  readonly connectionClose: boolean
}

/** Provides the extensible structural base for implementation-specific listen options. */
export interface ListenOptions {}

/** Immutably reduces common Transport options. */
export type Option = (options: Options) => Options

/** Immutably reduces options for one dial operation. */
export type DialOption = (options: DialOptions) => DialOptions

/** Immutably reduces an implementation-specific extension of ListenOptions. */
export type ListenOption = <T extends ListenOptions>(options: T) => T

/** Describes an operation attempted on a closed transport resource. */
export interface TransportClosedError extends Error {
  readonly name: "TransportClosedError"
  readonly code: "GO_LIKE_TRANSPORT_CLOSED"
  readonly cause: Error | undefined
}

/** Describes an invalid transport state transition. */
export interface TransportStateError extends Error {
  readonly name: "TransportStateError"
  readonly code: "GO_LIKE_TRANSPORT_STATE"
  readonly cause: Error | undefined
}

/** Describes an explicitly requested capability that an implementation cannot honor. */
export interface UnsupportedTransportCapabilityError extends Error {
  readonly name: "UnsupportedTransportCapabilityError"
  readonly code: "GO_LIKE_TRANSPORT_UNSUPPORTED_CAPABILITY"
  readonly cause: Error | undefined
}

/** Describes invalid transport wire data or protocol behavior. */
export interface TransportProtocolError extends Error {
  readonly name: "TransportProtocolError"
  readonly code: "GO_LIKE_TRANSPORT_PROTOCOL"
  readonly cause: Error | undefined
}
