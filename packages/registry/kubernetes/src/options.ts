import { providerOptions, type ProviderOptions } from "@likego/registry/provider"

import type { KubernetesFetch, KubernetesPodOwner, KubernetesRegistryOptions } from "./types"

const maximumTimerMs = 2_147_483_647

/** Captures constructor-only Kubernetes controls. */
export interface CapturedOptions {
  readonly fetch: KubernetesFetch
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

/** Canonicalizes one credentials-free and path-free HTTP(S) API origin. */
export function kubernetesOrigin(value: string): string {
  if (typeof value !== "string") throw new TypeError("Kubernetes address must be a string")
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new TypeError("Kubernetes address must be a valid HTTP or HTTPS origin")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("Kubernetes address must use HTTP or HTTPS")
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
      "Kubernetes address must be an origin without credentials, path, query, or fragment"
    )
  }
  return url.origin
}

/** Validates one Kubernetes namespace name without normalizing it. */
export function kubernetesNamespace(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 63 ||
    !/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(value)
  ) {
    throw new TypeError("Kubernetes namespace must be a DNS-1123 label")
  }
  return value
}

/** Snapshots one optional same-namespace Pod owner reference. */
export function kubernetesPodOwner(
  value: KubernetesPodOwner | undefined
): KubernetesPodOwner | null {
  if (value === undefined) return null
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Kubernetes owner must identify one Pod")
  }
  const name = value.name
  const uid = value.uid
  if (
    typeof name !== "string" ||
    name.length < 1 ||
    name.length > 253 ||
    name.split(".").some((label) => !/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(label))
  ) {
    throw new TypeError("Kubernetes owner name must be a DNS-1123 subdomain")
  }
  if (typeof uid !== "string" || uid.length === 0) {
    throw new TypeError("Kubernetes owner uid must be a non-empty string")
  }
  return Object.freeze({ name, uid })
}

/** Validates one optional bearer token without reflecting its bytes. */
function bearerToken(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || value.length === 0 || /[\r\n]/.test(value)) {
    throw new TypeError("Kubernetes token must be a non-empty HTTP header value")
  }
  try {
    const headers = new Headers()
    headers.set("Authorization", `Bearer ${value}`)
  } catch {
    throw new TypeError("Kubernetes token must be a valid HTTP header value")
  }
  return value
}

/** Captures all construction getters once without performing I/O. */
export function captureOptions(value: KubernetesRegistryOptions): CapturedOptions {
  if (value === null || typeof value !== "object") {
    throw new TypeError("Kubernetes Registry options must be an object")
  }
  const fetch = value.fetch
  const origin = kubernetesOrigin(value.address)
  const namespace = kubernetesNamespace(value.namespace)
  const owner = kubernetesPodOwner(value.owner)
  const token = bearerToken(value.token)
  const retryInitialMs = value.retryInitialMs ?? 250
  const retryMaximumMs = value.retryMaximumMs ?? 30_000
  const watchTimeoutSeconds = value.watchTimeoutSeconds ?? 30
  const watchBufferSize = value.watchBufferSize ?? 128
  if (typeof fetch !== "function") {
    throw new TypeError("Kubernetes Fetch capability must be callable")
  }
  boundedInteger(retryInitialMs, 1, 60_000, "retryInitialMs")
  boundedInteger(retryMaximumMs, retryInitialMs, 600_000, "retryMaximumMs")
  boundedInteger(watchTimeoutSeconds, 1, 300, "watchTimeoutSeconds")
  boundedInteger(watchBufferSize, 1, 4_096, "watchBufferSize")
  return Object.freeze({
    fetch,
    origin,
    namespace,
    owner,
    token,
    retryInitialMs,
    retryMaximumMs,
    watchTimeoutSeconds,
    watchBufferSize,
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
