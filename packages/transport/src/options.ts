import { snapshotMessage } from "./message"
import type {
  DialOption,
  Message,
  MessageCodec,
  Option,
  TLSConfig,
  TLSEncodedBytes,
  TransportLogger
} from "./types"

const PromiseThen = Promise.prototype.then

/** Intentionally consumes one diagnostic Promise rejection. */
function ignoreDiagnosticFailure(): void {}

/** Attaches a rejection observer through the native Promise boundary when possible. */
function observeNativePromise(value: unknown): boolean {
  try {
    Reflect.apply(PromiseThen, value, [undefined, ignoreDiagnosticFailure])
    return true
  } catch {
    return false
  }
}

/** Observes a Promise-like diagnostic result without waiting for the borrowed sink. */
function observeDiagnosticResult(value: unknown): void {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return
  if (observeNativePromise(value)) return
  observeNativePromise(Promise.resolve(value))
}

/** Validates one finite, non-negative integer duration. */
function duration(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative integer`)
  }
  return value
}

/** Validates one structural boolean without coercing third-party reducer output. */
function flag(value: boolean, name: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${name} must be a boolean`)
  return value
}

/** Copies a diagnostic fields record before invoking a borrowed logger. */
function snapshotFields(
  fields: Readonly<Record<string, unknown>> | undefined
): Readonly<Record<string, unknown>> | undefined {
  if (fields === undefined) return undefined
  const prototype = Object.getPrototypeOf(fields)
  if (prototype !== Object.prototype && prototype !== null) return Object.freeze({})
  return Object.freeze(Object.fromEntries(Object.entries(fields)))
}

/** Wraps a borrowed logger so sink failures never alter protocol behavior. */
function snapshotLogger(value: TransportLogger | null): TransportLogger | null {
  if (value === null) return null
  const log = value.log
  if (typeof log !== "function") throw new TypeError("transport logger log must be a function")
  return Object.freeze({
    /** Delegates one detached diagnostic event and isolates every sink failure. */
    log(
      level: Parameters<TransportLogger["log"]>[0],
      message: string,
      fields?: Readonly<Record<string, unknown>>
    ): void {
      try {
        const result: unknown = log.call(value, level, message, snapshotFields(fields))
        observeDiagnosticResult(result)
      } catch {
        // Diagnostic sinks are explicitly isolated from transport protocol results.
      }
    }
  })
}

/** Wraps a borrowed codec with detached Message and byte boundaries. */
function snapshotCodec(value: MessageCodec | null): MessageCodec | null {
  if (value === null) return null
  const marshal = value.marshal
  const unmarshal = value.unmarshal
  if (typeof marshal !== "function") throw new TypeError("codec marshal must be a function")
  if (typeof unmarshal !== "function") throw new TypeError("codec unmarshal must be a function")
  return Object.freeze({
    /** Marshals one defensive Message snapshot and detaches the resulting bytes. */
    marshal(message: Message): Uint8Array {
      const encoded = marshal.call(value, snapshotMessage(message))
      if (!(encoded instanceof Uint8Array))
        throw new TypeError("codec marshal must return Uint8Array")
      return new Uint8Array(encoded)
    },
    /** Detaches input bytes and snapshots the Message returned by the codec. */
    unmarshal(bytes: Uint8Array): ReturnType<MessageCodec["unmarshal"]> {
      if (!(bytes instanceof Uint8Array))
        throw new TypeError("codec unmarshal input must be Uint8Array")
      return snapshotMessage(unmarshal.call(value, new Uint8Array(bytes)))
    }
  })
}

/** Copies one encoded TLS material value and protects its retained bytes with a getter. */
function snapshotTLSEncodedBytes(value: TLSEncodedBytes | null): TLSEncodedBytes | null {
  if (value === null) return null
  if (value.encoding !== "pem" && value.encoding !== "der") {
    throw new TypeError("TLS material encoding must be pem or der")
  }
  if (!(value.bytes instanceof Uint8Array))
    throw new TypeError("TLS material bytes must be a Uint8Array")
  const bytes = new Uint8Array(value.bytes)
  return Object.freeze({
    encoding: value.encoding,
    /** Returns detached TLS material bytes for every read. */
    get bytes(): Uint8Array {
      return new Uint8Array(bytes)
    }
  })
}

/** Copies and freezes one portable TLS configuration. */
function snapshotTLSConfig(value: TLSConfig | null): TLSConfig | null {
  if (value === null) return null
  if (value.serverName !== null && typeof value.serverName !== "string") {
    throw new TypeError("TLS serverName must be a string or null")
  }
  return Object.freeze({
    serverName: value.serverName,
    caCertificate: snapshotTLSEncodedBytes(value.caCertificate),
    certificateChain: snapshotTLSEncodedBytes(value.certificateChain),
    privateKey: snapshotTLSEncodedBytes(value.privateKey)
  })
}

/** Replaces the optional Message codec with a safely wrapped structural implementation. */
export function codec(value: MessageCodec | null): Option {
  return (options) =>
    Object.freeze({
      codec: snapshotCodec(value),
      logger: options.logger,
      timeoutMs: options.timeoutMs,
      secure: options.secure,
      tlsConfig: options.tlsConfig
    })
}

/** Replaces the optional diagnostic logger with a failure-isolating structural wrapper. */
export function logger(value: TransportLogger | null): Option {
  return (options) =>
    Object.freeze({
      codec: options.codec,
      logger: snapshotLogger(value),
      timeoutMs: options.timeoutMs,
      secure: options.secure,
      tlsConfig: options.tlsConfig
    })
}

/** Replaces the default send and receive timeout in milliseconds. */
export function timeout(timeoutMs: number): Option {
  const validated = duration(timeoutMs, "transport timeoutMs")
  return (options) =>
    Object.freeze({
      codec: options.codec,
      logger: options.logger,
      timeoutMs: validated,
      secure: options.secure,
      tlsConfig: options.tlsConfig
    })
}

/** Replaces whether future resources require a secure transport. */
export function secure(enabled: boolean): Option {
  const validated = flag(enabled, "transport secure")
  return (options) =>
    Object.freeze({
      codec: options.codec,
      logger: options.logger,
      timeoutMs: options.timeoutMs,
      secure: validated,
      tlsConfig: options.tlsConfig
    })
}

/** Replaces portable TLS material with one defensive snapshot. */
export function tlsConfig(value: TLSConfig | null): Option {
  return (options) =>
    Object.freeze({
      codec: options.codec,
      logger: options.logger,
      timeoutMs: options.timeoutMs,
      secure: options.secure,
      tlsConfig: snapshotTLSConfig(value)
    })
}

/** Replaces the dial or response-header phase timeout in milliseconds. */
export function withTimeout(timeoutMs: number): DialOption {
  const validated = duration(timeoutMs, "dial timeoutMs")
  return (options) =>
    Object.freeze({
      timeoutMs: validated,
      connectionClose: options.connectionClose
    })
}

/** Requests connection close semantics from a capable implementation. */
export function withConnClose(): DialOption {
  return (options) =>
    Object.freeze({
      timeoutMs: options.timeoutMs,
      connectionClose: true
    })
}
