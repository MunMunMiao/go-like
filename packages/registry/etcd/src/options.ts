import { providerOptions, type ProviderOptions } from "@likego/registry/provider"

import type { EtcdFetch, EtcdRegistryOptions } from "./types"

const maximumTimerMs = 2_147_483_647

/** Captures constructor-only controls independently from mutable common options. */
export interface CapturedOptions {
  readonly fetch: EtcdFetch
  readonly origin: string
  readonly prefix: string
  readonly token: string | undefined
  readonly retryInitialMs: number
  readonly retryMaximumMs: number
  readonly watchBufferSize: number
  readonly ttlMs: number
  readonly common: ProviderOptions
}

/** Binds one operation or owner to an already-validated common snapshot. */
export interface OperationOptions extends CapturedOptions {
  readonly timeoutMs: number
}

/** Validates one finite inclusive integer provider control. */
function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`etcd ${name} must be an integer from ${minimum} through ${maximum}`)
  }
  return value
}

/** Canonicalizes one credentials-free, path-free HTTP(S) origin. */
export function etcdOrigin(value: string): string {
  if (typeof value !== "string") throw new TypeError("etcd address must be a string")
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new TypeError("etcd address must be a valid HTTP or HTTPS origin")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("etcd address must use HTTP or HTTPS")
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    value.includes("?") ||
    value.includes("#")
  ) {
    throw new TypeError(
      "etcd address must be an origin without credentials, path, query, or fragment"
    )
  }
  return url.origin
}

/** Validates one absolute key prefix and preserves its exact UTF-8 text. */
export function etcdPrefix(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < 2 ||
    !value.startsWith("/") ||
    !value.endsWith("/") ||
    value.includes("\u0000") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    throw new TypeError("etcd prefix must be an absolute non-empty key prefix ending in slash")
  }
  return value
}

/** Validates one optional bearer token as an HTTP header without reflecting bytes. */
function bearerToken(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || value.length === 0 || /[\r\n]/.test(value)) {
    throw new TypeError("etcd token must be a non-empty HTTP header value")
  }
  try {
    const headers = new Headers()
    headers.set("Authorization", value)
  } catch {
    throw new TypeError("etcd token must be a valid HTTP header value")
  }
  return value
}

/** Captures every construction getter once and publishes immutable defaults. */
export function captureOptions(value: EtcdRegistryOptions): CapturedOptions {
  if (value === null || typeof value !== "object") {
    throw new TypeError("etcd Registry options must be an object")
  }
  const fetch = value.fetch
  const address = value.address
  const prefix = value.prefix ?? "/likego/registry/v1/"
  const token = value.token
  const retryInitialMs = value.retryInitialMs ?? 250
  const retryMaximumMs = value.retryMaximumMs ?? 30_000
  const watchBufferSize = value.watchBufferSize ?? 128
  const ttlMs = value.ttlMs ?? 120_000
  if (typeof fetch !== "function") throw new TypeError("etcd Fetch capability must be callable")
  const origin = etcdOrigin(address)
  const capturedPrefix = etcdPrefix(prefix)
  const capturedToken = bearerToken(token)
  boundedInteger(retryInitialMs, 1, 60_000, "retryInitialMs")
  boundedInteger(retryMaximumMs, retryInitialMs, 600_000, "retryMaximumMs")
  boundedInteger(watchBufferSize, 1, 4_096, "watchBufferSize")
  boundedInteger(ttlMs, 2_000, 86_400_000, "ttlMs")
  return Object.freeze({
    fetch,
    origin,
    prefix: capturedPrefix,
    token: capturedToken,
    retryInitialMs,
    retryMaximumMs,
    watchBufferSize,
    ttlMs,
    common: providerOptions(value)
  })
}

/** Binds one provider snapshot to one effective Registry option snapshot. */
export function operationOptions(
  provider: CapturedOptions,
  common: ProviderOptions,
  timeoutMs = common.timeoutMs
): OperationOptions {
  return Object.freeze({
    fetch: provider.fetch,
    origin: provider.origin,
    prefix: provider.prefix,
    token: provider.token,
    retryInitialMs: provider.retryInitialMs,
    retryMaximumMs: provider.retryMaximumMs,
    watchBufferSize: provider.watchBufferSize,
    ttlMs: provider.ttlMs,
    common,
    timeoutMs: boundedInteger(timeoutMs, 1, maximumTimerMs, "operation timeoutMs")
  })
}
