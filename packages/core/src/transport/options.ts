import type { DialOption, Option, TLSConfig, TLSEncodedBytes } from "./types"

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

/** Replaces the default send and receive timeout in milliseconds. */
export function timeout(timeoutMs: number): Option {
  const validated = duration(timeoutMs, "transport timeoutMs")
  return (options) =>
    Object.freeze({
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
      timeoutMs: options.timeoutMs,
      secure: validated,
      tlsConfig: options.tlsConfig
    })
}

/** Replaces portable TLS material with one defensive snapshot. */
export function tlsConfig(value: TLSConfig | null): Option {
  return (options) =>
    Object.freeze({
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
