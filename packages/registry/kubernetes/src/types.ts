import type { Registry } from "@go-like/registry"
import type { ProviderLogger, RegistrationErrorHandler } from "@go-like/registry/provider"

/** Executes one borrowed standard Web Fetch request. */
export interface KubernetesFetch {
  /** Performs one standard Fetch operation. */
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>
}

/** Identifies the same-namespace Pod that owns managed EndpointSlices. */
export interface KubernetesPodOwner {
  readonly name: string
  readonly uid: string
}

/** Configures one namespace-scoped Kubernetes EndpointSlice Registry. */
export interface KubernetesRegistryOptions {
  readonly fetch: KubernetesFetch
  readonly address: string
  readonly namespace: string
  readonly owner?: KubernetesPodOwner
  readonly token?: string
  readonly retryInitialMs?: number
  readonly retryMaximumMs?: number
  readonly watchTimeoutSeconds?: number
  readonly watchBufferSize?: number
  readonly timeoutMs?: number
  readonly logger?: ProviderLogger | null
  readonly onRegistrationError?: RegistrationErrorHandler | null
}

/** Identifies one Kubernetes API boundary operation. */
export type KubernetesOperation = "create" | "delete" | "get" | "list" | "update" | "watch"

/** Describes one status-only Kubernetes HTTP failure. */
export interface KubernetesHttpError extends Error {
  readonly name: "KubernetesHttpError"
  readonly code: "GO_LIKE_KUBERNETES_HTTP"
  readonly operation: KubernetesOperation
  readonly status: number
}

/** Describes one secret-safe Kubernetes Fetch rejection. */
export interface KubernetesTransportError extends Error {
  readonly name: "KubernetesTransportError"
  readonly code: "GO_LIKE_KUBERNETES_TRANSPORT"
  readonly operation: KubernetesOperation
  readonly cause: Error
}

/** Documents the structural result of the sole public constructor. */
export interface KubernetesRegistry extends Registry {}
