import type {
  DialOption,
  DialOptions,
  Message,
  MessageCodec,
  Option,
  Options,
  TLSEncodedBytes,
  TLSConfig,
  TransportLogLevel,
  TransportLogger
} from "@likego/transport"
import { snapshotMessage } from "@likego/transport/provider"
import type {
  HTTPExecutor,
  HTTPHost,
  HTTPListenOption,
  HTTPListenOptions,
  HTTPTransportOption,
  HTTPTransportOptions
} from "./types"

const DefaultDialTimeoutMs = 5_000
const MaximumTimerDurationMs = 2_147_483_647
const PromiseThen = Promise.prototype.then

/** Defines the safe default unary HTTP message limit. */
export const defaultHTTPMaxMessageBytes = 4 * 1024 * 1024

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
  try {
    observeNativePromise(Promise.resolve(value))
  } catch {
    // Diagnostics never control protocol behavior, including hostile assimilation.
  }
}

/** Validates one non-negative safe integer duration. */
function duration(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MaximumTimerDurationMs) {
    throw new RangeError(`${name} must be an integer from 0 through ${MaximumTimerDurationMs}`)
  }
  return value
}

/** Validates one positive safe-integer unary message limit. */
function messageLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError("HTTP maxMessageBytes must be a finite positive integer")
  }
  return value
}

/** Copies one optional TLS byte sequence and protects retained bytes. */
function snapshotTLSBytes(value: TLSEncodedBytes | null): TLSEncodedBytes | null {
  if (value === null) return null
  if (value.encoding !== "pem" && value.encoding !== "der") {
    throw new TypeError("TLS material encoding must be pem or der")
  }
  if (!(value.bytes instanceof Uint8Array))
    throw new TypeError("TLS material bytes must be Uint8Array")
  const copied = new Uint8Array(value.bytes)
  return Object.freeze({
    encoding: value.encoding,
    /** Returns detached TLS bytes for every read. */
    get bytes(): Uint8Array {
      return new Uint8Array(copied)
    }
  })
}

/** Copies one portable TLS configuration. */
function snapshotTLSConfig(value: TLSConfig | null): TLSConfig | null {
  if (value === null) return null
  if (value.serverName !== null && typeof value.serverName !== "string") {
    throw new TypeError("TLS serverName must be a string or null")
  }
  return Object.freeze({
    serverName: value.serverName,
    caCertificate: snapshotTLSBytes(value.caCertificate),
    certificateChain: snapshotTLSBytes(value.certificateChain),
    privateKey: snapshotTLSBytes(value.privateKey)
  })
}

/** Wraps one borrowed codec at defensive Message and byte boundaries. */
function snapshotCodec(value: MessageCodec | null): MessageCodec | null {
  if (value === null) return null
  const marshal = value.marshal
  const unmarshal = value.unmarshal
  if (typeof marshal !== "function" || typeof unmarshal !== "function") {
    throw new TypeError("transport codec must provide marshal and unmarshal")
  }
  return Object.freeze({
    /** Marshals one detached Message through the borrowed codec. */
    marshal(message: Message): Uint8Array {
      const bytes = marshal.call(value, snapshotMessage(message))
      if (!(bytes instanceof Uint8Array))
        throw new TypeError("codec marshal must return Uint8Array")
      return new Uint8Array(bytes)
    },
    /** Unmarshals detached bytes through the borrowed codec. */
    unmarshal(bytes: Uint8Array): Message {
      if (!(bytes instanceof Uint8Array)) throw new TypeError("codec input must be Uint8Array")
      return snapshotMessage(unmarshal.call(value, new Uint8Array(bytes)))
    }
  })
}

/** Wraps one borrowed logger while isolating diagnostic sink failures. */
function snapshotLogger(value: TransportLogger | null): TransportLogger | null {
  if (value === null) return null
  const log = value.log
  if (typeof log !== "function") throw new TypeError("transport logger must provide log")
  return Object.freeze({
    /** Delegates one diagnostic event without allowing sink failure to escape. */
    log(
      level: TransportLogLevel,
      message: string,
      fields?: Readonly<Record<string, unknown>>
    ): void {
      try {
        const copied =
          fields === undefined
            ? undefined
            : Object.freeze(Object.fromEntries(Object.entries(fields)))
        const result: unknown = log.call(value, level, message, copied)
        observeDiagnosticResult(result)
      } catch {
        // Diagnostics never control protocol behavior.
      }
    }
  })
}

/** Produces one deep immutable common option snapshot. */
export function snapshotHTTPCommonOptions(value: Options): Options {
  if (typeof value !== "object" || value === null)
    throw new TypeError("transport options must be an object")
  if (typeof value.secure !== "boolean") throw new TypeError("transport secure must be a boolean")
  return Object.freeze({
    codec: snapshotCodec(value.codec),
    logger: snapshotLogger(value.logger),
    timeoutMs: duration(value.timeoutMs, "transport timeoutMs"),
    secure: value.secure,
    tlsConfig: snapshotTLSConfig(value.tlsConfig)
  })
}

/** Produces the reviewed common defaults. */
export function defaultHTTPCommonOptions(): Options {
  return snapshotHTTPCommonOptions(
    Object.freeze({
      codec: null,
      logger: null,
      timeoutMs: 0,
      secure: false,
      tlsConfig: null
    })
  )
}

/** Applies common options in declaration order to a prior immutable snapshot. */
export function applyHTTPCommonOptions(current: Options, options: readonly Option[]): Options {
  let value = current
  for (const option of options) {
    if (typeof option !== "function") throw new TypeError("transport option must be a function")
    value = snapshotHTTPCommonOptions(option(value))
  }
  return value
}

/** Produces one immutable dial option snapshot. */
export function applyHTTPDialOptions(options: readonly DialOption[]): DialOptions {
  let value: DialOptions = Object.freeze({
    timeoutMs: DefaultDialTimeoutMs,
    connectionClose: false
  })
  for (const option of options) {
    if (typeof option !== "function") throw new TypeError("dial option must be a function")
    const reduced = option(value)
    if (typeof reduced !== "object" || reduced === null)
      throw new TypeError("dial options must be an object")
    if (typeof reduced.connectionClose !== "boolean")
      throw new TypeError("dial connectionClose must be a boolean")
    value = Object.freeze({
      timeoutMs: duration(reduced.timeoutMs, "dial timeoutMs"),
      connectionClose: reduced.connectionClose
    })
  }
  return value
}

/** Captures the current standard Fetch executor for one transport construction. */
export function defaultHTTPTransportOptions(): HTTPTransportOptions {
  const value = globalThis.fetch
  if (typeof value !== "function") throw new TypeError("global fetch must be a function")
  return Object.freeze({ executor: value, maxMessageBytes: defaultHTTPMaxMessageBytes })
}

/** Applies HTTP construction reducers in declaration order. */
export function applyHTTPTransportOptions(
  options: readonly HTTPTransportOption[]
): HTTPTransportOptions {
  let value = defaultHTTPTransportOptions()
  for (const option of options) {
    if (typeof option !== "function")
      throw new TypeError("HTTP transport option must be a function")
    const reduced = option(value)
    if (typeof reduced !== "object" || reduced === null || typeof reduced.executor !== "function") {
      throw new TypeError("HTTP executor must be a function")
    }
    value = Object.freeze({
      executor: reduced.executor,
      maxMessageBytes: messageLimit(reduced.maxMessageBytes)
    })
  }
  return value
}

/** Replaces the borrowed standard Fetch executor. */
export function executor(value: HTTPExecutor): HTTPTransportOption {
  if (typeof value !== "function") throw new TypeError("HTTP executor must be a function")
  return function reduceExecutor(options): HTTPTransportOptions {
    return Object.freeze({ executor: value, maxMessageBytes: options.maxMessageBytes })
  }
}

/** Sets the maximum unary request and successful-response body size. */
export function maxMessageBytes(value: number): HTTPTransportOption {
  const selected = messageLimit(value)
  return function reduceMessageLimit(options): HTTPTransportOptions {
    return Object.freeze({ executor: options.executor, maxMessageBytes: selected })
  }
}

/** Applies HTTP listen reducers in declaration order. */
export function applyHTTPListenOptions(options: readonly HTTPListenOption[]): HTTPListenOptions {
  let value: HTTPListenOptions = Object.freeze({ host: null })
  for (const option of options) {
    if (typeof option !== "function") throw new TypeError("HTTP listen option must be a function")
    const reduced = option(value)
    if (typeof reduced !== "object" || reduced === null)
      throw new TypeError("HTTP listen options must be an object")
    const selected = reduced.host
    if (
      selected !== null &&
      (typeof selected !== "object" ||
        typeof selected.capabilities !== "function" ||
        typeof selected.bind !== "function")
    ) {
      throw new TypeError("HTTP host must provide capabilities and bind")
    }
    value = Object.freeze({ host: selected })
  }
  return value
}

/** Selects one borrowed runtime HTTP host for a listen operation. */
export function host(value: HTTPHost): HTTPListenOption {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.capabilities !== "function" ||
    typeof value.bind !== "function"
  ) {
    throw new TypeError("HTTP host must provide capabilities and bind")
  }
  return function reduceHost(): HTTPListenOptions {
    return Object.freeze({ host: value })
  }
}
