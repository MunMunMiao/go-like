import type { MDNSFamily, MDNSOption, MDNSOptions } from "./types"
import type { RegistrationErrorHandler } from "@go-like/registry/provider"
import { validateDNSName } from "./dns"

const defaultFamilies: readonly MDNSFamily[] = Object.freeze(["ipv4"])
const defaultOptions: MDNSOptions = Object.freeze({
  domain: "go-like.",
  interfaceIds: Object.freeze([]),
  families: defaultFamilies,
  queryTimeoutMs: 1_000,
  port: 5_353,
  maxPacketBytes: 1_200,
  maxDecodedPayloadBytes: 65_536,
  watchBufferSize: 128,
  ttlMs: 120_000,
  onRegistrationError: null
})
const worstServiceLabel = `ls-${"a".repeat(52)}`
const worstIdentityLabel = `li-${"a".repeat(52)}`
const worstHostLabel = `lh-${"a".repeat(52)}`

/** Joins fixed owner labels to one configured domain without array spread syntax. */
function ownerLabels(
  prefixes: readonly string[],
  domainLabels: readonly string[]
): readonly string[] {
  const joined: string[] = []
  for (const prefix of prefixes) joined.push(prefix)
  for (const label of domainLabels) joined.push(label)
  return joined
}

/** Reports whether a value can structurally carry option fields. */
function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function"
}

/** Validates one finite integer against inclusive construction bounds. */
function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} through ${maximum}`)
  }
  return value
}

/** Validates one borrowed terminal registration observer. */
function registrationErrorHandlerSnapshot(
  value: RegistrationErrorHandler | null
): RegistrationErrorHandler | null {
  if (value === null) return null
  if (typeof value !== "function") {
    throw new TypeError("mDNS onRegistrationError must be callable or null")
  }
  return value
}

/** Validates and normalizes one DNS-safe provider domain. */
function domainSnapshot(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("mDNS domain must be a non-empty string")
  }
  const normalized = value.endsWith(".") ? value.slice(0, -1).toLowerCase() : value.toLowerCase()
  const labels = normalized.split(".")
  for (const label of labels) {
    if (
      label.length === 0 ||
      !/^[a-z0-9-]+$/.test(label) ||
      label.startsWith("-") ||
      label.endsWith("-")
    )
      throw new TypeError("mDNS domain must contain only DNS-safe labels")
  }
  validateDNSName(labels)
  validateDNSName(ownerLabels(["_services"], labels))
  validateDNSName(ownerLabels([worstServiceLabel], labels))
  validateDNSName(ownerLabels([worstIdentityLabel, worstServiceLabel], labels))
  validateDNSName(ownerLabels([worstHostLabel], labels))
  return `${normalized}.`
}

/** Copies and de-duplicates runtime interface identifiers in declaration order. */
function interfaceSnapshot(values: readonly (string | number)[]): readonly (string | number)[] {
  if (!Array.isArray(values)) throw new TypeError("mDNS interfaceIds must be an array")
  const copied: (string | number)[] = []
  const seen = new Set<string | number>()
  for (const value of values) {
    if (
      (typeof value !== "string" || value.length === 0) &&
      (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    )
      throw new TypeError(
        "mDNS interface id must be a non-empty string or non-negative safe integer"
      )
    if (!seen.has(value)) {
      seen.add(value)
      copied.push(value)
    }
  }
  return Object.freeze(copied)
}

/** Copies and de-duplicates an explicit non-empty family selection. */
function familySnapshot(values: readonly MDNSFamily[]): readonly MDNSFamily[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new RangeError("mDNS families must be a non-empty array")
  }
  const copied: MDNSFamily[] = []
  const seen = new Set<MDNSFamily>()
  for (const value of values) {
    if (value !== "ipv4" && value !== "ipv6")
      throw new TypeError("mDNS family must be ipv4 or ipv6")
    if (!seen.has(value)) {
      seen.add(value)
      copied.push(value)
    }
  }
  return Object.freeze(copied)
}

/** Validates and freezes one complete construction snapshot. */
function snapshot(value: MDNSOptions): MDNSOptions {
  if (!isObjectLike(value)) throw new TypeError("mDNS options must be an object")
  return Object.freeze({
    domain: domainSnapshot(value.domain),
    interfaceIds: interfaceSnapshot(value.interfaceIds),
    families: familySnapshot(value.families),
    queryTimeoutMs: boundedInteger(value.queryTimeoutMs, 1, 60_000, "mDNS queryTimeoutMs"),
    port: boundedInteger(value.port, 1, 65_535, "mDNS port"),
    maxPacketBytes: boundedInteger(value.maxPacketBytes, 512, 1_200, "mDNS maxPacketBytes"),
    maxDecodedPayloadBytes: boundedInteger(
      value.maxDecodedPayloadBytes,
      1_024,
      65_536,
      "mDNS maxDecodedPayloadBytes"
    ),
    watchBufferSize: boundedInteger(value.watchBufferSize, 1, 4_096, "mDNS watchBufferSize"),
    ttlMs: boundedInteger(value.ttlMs, 2_000, 86_400_000, "mDNS ttlMs"),
    onRegistrationError: registrationErrorHandlerSnapshot(value.onRegistrationError)
  })
}

/** Resolves immutable mDNS construction options. */
export function mdnsOptions(
  ...options: readonly MDNSOption[] /* go-like-typed-rest: preserves Go-style functional options. */
): MDNSOptions {
  let candidate = defaultOptions
  for (const option of options) {
    if (typeof option !== "function") throw new TypeError("mDNS option must be a function")
    candidate = snapshot(option(candidate))
  }
  return snapshot(candidate)
}

/** Replaces and normalizes the provider DNS domain. */
export function domain(value: string): MDNSOption {
  const captured = domainSnapshot(value)
  /** Applies the captured domain to one construction snapshot. */
  function apply(options: MDNSOptions): MDNSOptions {
    return Object.freeze({
      domain: captured,
      interfaceIds: options.interfaceIds,
      families: options.families,
      queryTimeoutMs: options.queryTimeoutMs,
      port: options.port,
      maxPacketBytes: options.maxPacketBytes,
      maxDecodedPayloadBytes: options.maxDecodedPayloadBytes,
      watchBufferSize: options.watchBufferSize,
      ttlMs: options.ttlMs,
      onRegistrationError: options.onRegistrationError
    })
  }
  return apply
}

/** Replaces the selected runtime interface identifiers. */
export function interfaces(
  ...ids: readonly (
    | string
    | number
  )[] /* go-like-typed-rest: preserves Go-style functional options. */
): MDNSOption {
  const captured = interfaceSnapshot(ids)
  /** Applies the captured interface selection to one construction snapshot. */
  function apply(options: MDNSOptions): MDNSOptions {
    return Object.freeze({
      domain: options.domain,
      interfaceIds: captured,
      families: options.families,
      queryTimeoutMs: options.queryTimeoutMs,
      port: options.port,
      maxPacketBytes: options.maxPacketBytes,
      maxDecodedPayloadBytes: options.maxDecodedPayloadBytes,
      watchBufferSize: options.watchBufferSize,
      ttlMs: options.ttlMs,
      onRegistrationError: options.onRegistrationError
    })
  }
  return apply
}

/** Replaces the selected multicast address families. */
export function families(
  ...values: readonly MDNSFamily[] /* go-like-typed-rest: preserves Go-style functional options. */
): MDNSOption {
  const captured = familySnapshot(values)
  /** Applies the captured family selection to one construction snapshot. */
  function apply(options: MDNSOptions): MDNSOptions {
    return Object.freeze({
      domain: options.domain,
      interfaceIds: options.interfaceIds,
      families: captured,
      queryTimeoutMs: options.queryTimeoutMs,
      port: options.port,
      maxPacketBytes: options.maxPacketBytes,
      maxDecodedPayloadBytes: options.maxDecodedPayloadBytes,
      watchBufferSize: options.watchBufferSize,
      ttlMs: options.ttlMs,
      onRegistrationError: options.onRegistrationError
    })
  }
  return apply
}

/** Replaces the provider query timeout. */
export function queryTimeout(valueMs: number): MDNSOption {
  const captured = boundedInteger(valueMs, 1, 60_000, "mDNS queryTimeoutMs")
  /** Applies the captured query timeout to one construction snapshot. */
  function apply(options: MDNSOptions): MDNSOptions {
    return Object.freeze({
      domain: options.domain,
      interfaceIds: options.interfaceIds,
      families: options.families,
      queryTimeoutMs: captured,
      port: options.port,
      maxPacketBytes: options.maxPacketBytes,
      maxDecodedPayloadBytes: options.maxDecodedPayloadBytes,
      watchBufferSize: options.watchBufferSize,
      ttlMs: options.ttlMs,
      onRegistrationError: options.onRegistrationError
    })
  }
  return apply
}

/** Replaces the provider UDP port. */
export function port(value: number): MDNSOption {
  const captured = boundedInteger(value, 1, 65_535, "mDNS port")
  /** Applies the captured UDP port to one construction snapshot. */
  function apply(options: MDNSOptions): MDNSOptions {
    return Object.freeze({
      domain: options.domain,
      interfaceIds: options.interfaceIds,
      families: options.families,
      queryTimeoutMs: options.queryTimeoutMs,
      port: captured,
      maxPacketBytes: options.maxPacketBytes,
      maxDecodedPayloadBytes: options.maxDecodedPayloadBytes,
      watchBufferSize: options.watchBufferSize,
      ttlMs: options.ttlMs,
      onRegistrationError: options.onRegistrationError
    })
  }
  return apply
}

/** Replaces the maximum encoded DNS packet size. */
export function maxPacketBytes(value: number): MDNSOption {
  const captured = boundedInteger(value, 512, 1_200, "mDNS maxPacketBytes")
  /** Applies the captured DNS packet ceiling to one construction snapshot. */
  function apply(options: MDNSOptions): MDNSOptions {
    return Object.freeze({
      domain: options.domain,
      interfaceIds: options.interfaceIds,
      families: options.families,
      queryTimeoutMs: options.queryTimeoutMs,
      port: options.port,
      maxPacketBytes: captured,
      maxDecodedPayloadBytes: options.maxDecodedPayloadBytes,
      watchBufferSize: options.watchBufferSize,
      ttlMs: options.ttlMs,
      onRegistrationError: options.onRegistrationError
    })
  }
  return apply
}

/** Replaces the maximum decoded service payload size. */
export function maxDecodedPayloadBytes(value: number): MDNSOption {
  const captured = boundedInteger(value, 1_024, 65_536, "mDNS maxDecodedPayloadBytes")
  /** Applies the captured decoded payload ceiling to one construction snapshot. */
  function apply(options: MDNSOptions): MDNSOptions {
    return Object.freeze({
      domain: options.domain,
      interfaceIds: options.interfaceIds,
      families: options.families,
      queryTimeoutMs: options.queryTimeoutMs,
      port: options.port,
      maxPacketBytes: options.maxPacketBytes,
      maxDecodedPayloadBytes: captured,
      watchBufferSize: options.watchBufferSize,
      ttlMs: options.ttlMs,
      onRegistrationError: options.onRegistrationError
    })
  }
  return apply
}

/** Replaces the bounded replacement-snapshot queue capacity. */
export function watchBufferSize(value: number): MDNSOption {
  const captured = boundedInteger(value, 1, 4_096, "mDNS watchBufferSize")
  /** Applies the captured watcher queue capacity to one construction snapshot. */
  function apply(options: MDNSOptions): MDNSOptions {
    return Object.freeze({
      domain: options.domain,
      interfaceIds: options.interfaceIds,
      families: options.families,
      queryTimeoutMs: options.queryTimeoutMs,
      port: options.port,
      maxPacketBytes: options.maxPacketBytes,
      maxDecodedPayloadBytes: options.maxDecodedPayloadBytes,
      watchBufferSize: captured,
      ttlMs: options.ttlMs,
      onRegistrationError: options.onRegistrationError
    })
  }
  return apply
}

/** Replaces the provider registration record lifetime in integer milliseconds. */
export function ttl(valueMs: number): MDNSOption {
  const captured = boundedInteger(valueMs, 2_000, 86_400_000, "mDNS ttlMs")
  /** Applies the captured record lifetime to one construction snapshot. */
  function apply(options: MDNSOptions): MDNSOptions {
    return Object.freeze({
      domain: options.domain,
      interfaceIds: options.interfaceIds,
      families: options.families,
      queryTimeoutMs: options.queryTimeoutMs,
      port: options.port,
      maxPacketBytes: options.maxPacketBytes,
      maxDecodedPayloadBytes: options.maxDecodedPayloadBytes,
      watchBufferSize: options.watchBufferSize,
      ttlMs: captured,
      onRegistrationError: options.onRegistrationError
    })
  }
  return apply
}

/** Replaces the borrowed observer for permanent resident registration loss. */
export function onRegistrationError(handler: RegistrationErrorHandler): MDNSOption {
  if (typeof handler !== "function")
    throw new TypeError("mDNS onRegistrationError must be callable")
  const captured = handler
  /** Applies the captured terminal registration observer. */
  function apply(options: MDNSOptions): MDNSOptions {
    return Object.freeze({
      domain: options.domain,
      interfaceIds: options.interfaceIds,
      families: options.families,
      queryTimeoutMs: options.queryTimeoutMs,
      port: options.port,
      maxPacketBytes: options.maxPacketBytes,
      maxDecodedPayloadBytes: options.maxDecodedPayloadBytes,
      watchBufferSize: options.watchBufferSize,
      ttlMs: options.ttlMs,
      onRegistrationError: captured
    })
  }
  return apply
}
