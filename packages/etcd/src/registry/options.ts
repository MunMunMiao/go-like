import { providerOptions, type ProviderOptions } from "@go-like/core/registry/provider"

import { openEtcdClient, type EtcdClient } from "../client/client"
import type { Fetch } from "@go-like/core/fetch"
import type { EtcdRegistryOptions } from "./types"

const maximumTimerMs = 2_147_483_647

/** Captures constructor-only controls independently from mutable common options. */
export interface CapturedOptions {
  readonly fetch: Fetch
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

/** Captures every construction getter once and publishes immutable defaults. */
export function captureOptions(
  client: EtcdClient,
  value: EtcdRegistryOptions = {}
): CapturedOptions {
  if (value === null || typeof value !== "object") {
    throw new TypeError("etcd Registry options must be an object")
  }
  const connection = openEtcdClient(client)
  const prefix = value.prefix ?? "/go-like/registry/v1/"
  const retryInitialMs = value.retryInitialMs ?? 250
  const retryMaximumMs = value.retryMaximumMs ?? 30_000
  const watchBufferSize = value.watchBufferSize ?? 128
  const ttlMs = value.ttlMs ?? 120_000
  const capturedPrefix = etcdPrefix(prefix)
  boundedInteger(retryInitialMs, 1, 60_000, "retryInitialMs")
  boundedInteger(retryMaximumMs, retryInitialMs, 600_000, "retryMaximumMs")
  boundedInteger(watchBufferSize, 1, 4_096, "watchBufferSize")
  boundedInteger(ttlMs, 2_000, 86_400_000, "ttlMs")
  return Object.freeze({
    fetch: connection.fetch,
    origin: connection.origin,
    prefix: capturedPrefix,
    token: connection.token,
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
