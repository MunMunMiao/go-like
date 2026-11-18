import { providerOptions, type ProviderOptions } from "@go-like/core/registry/provider"

import { openConsulClient, type ConsulClient } from "../client/client"
import type { Fetch } from "@go-like/core/fetch"
import type { ConsulRegistryOptions } from "./types"

/** Captures constructor-only provider controls independently from mutable common options. */
export interface CapturedOptions {
  readonly fetch: Fetch
  readonly origin: string
  readonly token: string | undefined
  readonly datacenter: string | undefined
  readonly namespace: string | undefined
  readonly waitMs: number
  readonly minimumQueryIntervalMs: number
  readonly retryInitialMs: number
  readonly retryMaximumMs: number
  readonly deregisterCriticalServiceAfterMs: number
  readonly watchBufferSize: number
  readonly ttlMs: number
  readonly common: ProviderOptions
}

/** Binds one operation or owner handle to its creation-time effective address snapshot. */
export interface OperationOptions extends CapturedOptions {
  readonly timeoutMs: number
}

/** Validates one finite inclusive integer provider option. */
function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`Consul ${name} must be an integer from ${minimum} through ${maximum}`)
  }
  return value
}

/** Captures every construction getter once and publishes immutable provider defaults. */
export function captureOptions(
  client: ConsulClient,
  value: ConsulRegistryOptions = {}
): CapturedOptions {
  if (value === null || typeof value !== "object") {
    throw new TypeError("Consul Registry options must be an object")
  }
  const connection = openConsulClient(client)
  const waitMs = value.waitMs ?? 300_000
  const minimumQueryIntervalMs = value.minimumQueryIntervalMs ?? 1_000
  const retryInitialMs = value.retryInitialMs ?? 250
  const retryMaximumMs = value.retryMaximumMs ?? 30_000
  const deregisterCriticalServiceAfterMs = value.deregisterCriticalServiceAfterMs ?? 60_000
  const watchBufferSize = value.watchBufferSize ?? 128
  const ttlMs = value.ttlMs ?? 120_000
  boundedInteger(waitMs, 1, 600_000, "waitMs")
  boundedInteger(minimumQueryIntervalMs, 1, 60_000, "minimumQueryIntervalMs")
  boundedInteger(retryInitialMs, 1, 60_000, "retryInitialMs")
  boundedInteger(retryMaximumMs, retryInitialMs, 600_000, "retryMaximumMs")
  boundedInteger(
    deregisterCriticalServiceAfterMs,
    60_000,
    86_400_000,
    "deregisterCriticalServiceAfterMs"
  )
  boundedInteger(watchBufferSize, 1, 4_096, "watchBufferSize")
  boundedInteger(ttlMs, 2_000, 86_400_000, "ttlMs")
  return Object.freeze({
    fetch: connection.fetch,
    origin: connection.origin,
    token: connection.token,
    datacenter: connection.datacenter,
    namespace: connection.namespace,
    waitMs,
    minimumQueryIntervalMs,
    retryInitialMs,
    retryMaximumMs,
    deregisterCriticalServiceAfterMs,
    watchBufferSize,
    ttlMs,
    common: providerOptions(value)
  })
}

/** Binds a provider snapshot to one already-validated effective common Registry snapshot. */
export function operationOptions(
  provider: CapturedOptions,
  common: ProviderOptions,
  timeoutMs = common.timeoutMs
): OperationOptions {
  return Object.freeze({
    fetch: provider.fetch,
    origin: provider.origin,
    token: provider.token,
    datacenter: provider.datacenter,
    namespace: provider.namespace,
    waitMs: provider.waitMs,
    minimumQueryIntervalMs: provider.minimumQueryIntervalMs,
    retryInitialMs: provider.retryInitialMs,
    retryMaximumMs: provider.retryMaximumMs,
    deregisterCriticalServiceAfterMs: provider.deregisterCriticalServiceAfterMs,
    watchBufferSize: provider.watchBufferSize,
    ttlMs: provider.ttlMs,
    common,
    timeoutMs: boundedInteger(timeoutMs, 1, 2_147_483_647, "operation timeoutMs")
  })
}
