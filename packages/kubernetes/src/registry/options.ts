import {
  providerOptions,
  type ProviderOptionInput,
  type ProviderOptions
} from "@go-like/core/registry/provider"

import { openKubernetesClient, type KubernetesClient } from "../client/client"
import type { Fetch } from "@go-like/core/fetch"
import { kubernetesNamespace, kubernetesPodOwner } from "../client/names"

import type { KubernetesPodOwner, KubernetesRegistryOptions } from "./types"

const maximumTimerMs = 2_147_483_647

/** Captures constructor-only Kubernetes controls. */
export interface CapturedOptions {
  readonly fetch: Fetch
  readonly origin: string
  readonly namespace: string
  readonly owner: KubernetesPodOwner | null
  readonly token: string | undefined
  readonly retryInitialMs: number
  readonly retryMaximumMs: number
  readonly watchTimeoutSeconds: number
  readonly watchBufferSize: number
  readonly common: ProviderOptions
}

/** Binds one operation to an effective common Registry snapshot. */
export interface OperationOptions extends CapturedOptions {
  readonly timeoutMs: number
}

/** Validates one finite inclusive integer provider control. */
function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`Kubernetes ${name} must be an integer from ${minimum} through ${maximum}`)
  }
  return value
}

/** Forwards registration controls without a logger. Connection fields live on the client. */
function providerInput(value: KubernetesRegistryOptions): ProviderOptionInput {
  if (value.onRegistrationError !== undefined && value.timeoutMs !== undefined) {
    return { onRegistrationError: value.onRegistrationError, timeoutMs: value.timeoutMs }
  }
  if (value.onRegistrationError !== undefined) {
    return { onRegistrationError: value.onRegistrationError }
  }
  if (value.timeoutMs !== undefined) return { timeoutMs: value.timeoutMs }
  return {}
}

/** Captures all construction getters once without performing I/O. */
export function captureOptions(
  client: KubernetesClient,
  value: KubernetesRegistryOptions
): CapturedOptions {
  if (value === null || typeof value !== "object") {
    throw new TypeError("Kubernetes Registry options must be an object")
  }
  const connection = openKubernetesClient(client)
  const namespace = kubernetesNamespace(value.namespace)
  const owner = kubernetesPodOwner(value.owner)
  const retryInitialMs = value.retryInitialMs ?? 250
  const retryMaximumMs = value.retryMaximumMs ?? 30_000
  const watchTimeoutSeconds = value.watchTimeoutSeconds ?? 30
  const watchBufferSize = value.watchBufferSize ?? 128
  boundedInteger(retryInitialMs, 1, 60_000, "retryInitialMs")
  boundedInteger(retryMaximumMs, retryInitialMs, 600_000, "retryMaximumMs")
  boundedInteger(watchTimeoutSeconds, 1, 300, "watchTimeoutSeconds")
  boundedInteger(watchBufferSize, 1, 4_096, "watchBufferSize")
  return Object.freeze({
    fetch: connection.fetch,
    origin: connection.origin,
    namespace,
    owner,
    token: connection.token,
    retryInitialMs,
    retryMaximumMs,
    watchTimeoutSeconds,
    watchBufferSize,
    common: providerOptions(providerInput(value))
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
    namespace: provider.namespace,
    owner: provider.owner,
    token: provider.token,
    retryInitialMs: provider.retryInitialMs,
    retryMaximumMs: provider.retryMaximumMs,
    watchTimeoutSeconds: provider.watchTimeoutSeconds,
    watchBufferSize: provider.watchBufferSize,
    common,
    timeoutMs: boundedInteger(timeoutMs, 1, maximumTimerMs, "operation timeoutMs")
  })
}
