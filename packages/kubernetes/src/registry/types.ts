import type { RegistrationErrorHandler, Registry } from "@go-like/core/registry"

/** Identifies the same-namespace Pod that owns managed EndpointSlices. */
export interface KubernetesPodOwner {
  readonly name: string
  readonly uid: string
}

/** Configures one namespace-scoped Kubernetes EndpointSlice Registry. */
export interface KubernetesRegistryOptions {
  /** DNS-label namespace of the EndpointSlices. */
  readonly namespace: string
  /** Same-namespace Pod that owns the slices (ownerReference, garbage-collected with the Pod). */
  readonly owner?: KubernetesPodOwner
  readonly retryInitialMs?: number
  readonly retryMaximumMs?: number
  /** Server-side watch timeout, default 30. */
  readonly watchTimeoutSeconds?: number
  readonly watchBufferSize?: number
  readonly timeoutMs?: number
  readonly onRegistrationError?: RegistrationErrorHandler | null
}

/** Documents the structural result of the sole public constructor. */
export interface KubernetesRegistry extends Registry {}
