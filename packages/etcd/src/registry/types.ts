import type { RegistrationErrorHandler, Registry } from "@go-like/core/registry"

/** Configures one etcd Registry. Connection fields live on EtcdClientOptions. */
export interface EtcdRegistryOptions {
  /** Absolute key prefix ending in "/", default "/go-like/registry/v1/". */
  readonly prefix?: string
  readonly retryInitialMs?: number
  readonly retryMaximumMs?: number
  readonly watchBufferSize?: number
  /** Lease TTL 2000..86400000, default 120000; keepalive every ttlMs / 2. */
  readonly ttlMs?: number
  readonly timeoutMs?: number
  readonly onRegistrationError?: RegistrationErrorHandler | null
}

/** Identifies one etcd JSON-gateway boundary operation before the registry prefix. */
export type RegistryWireOperation =
  | "lease-grant"
  | "lease-keepalive"
  | "lease-revoke"
  | "txn"
  | "range"
  | "watch"

/** Documents the structural result of the sole public constructor. */
export interface EtcdRegistry extends Registry {}
