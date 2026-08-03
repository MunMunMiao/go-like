import type { Registry } from "@likego/registry"
import type { ProviderLogger, RegistrationErrorHandler } from "@likego/registry/provider"

/** Executes one borrowed standard Web Fetch request. */
export interface EtcdFetch {
  /** Performs one standard Fetch operation. */
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>
}

/** Configures one portable etcd v3 JSON-gateway Registry. */
export interface EtcdRegistryOptions {
  readonly fetch: EtcdFetch
  readonly address: string
  readonly prefix?: string
  readonly token?: string
  readonly retryInitialMs?: number
  readonly retryMaximumMs?: number
  readonly watchBufferSize?: number
  readonly ttlMs?: number
  readonly timeoutMs?: number
  readonly logger?: ProviderLogger | null
  readonly onRegistrationError?: RegistrationErrorHandler | null
}

/** Identifies one etcd JSON-gateway boundary operation. */
export type EtcdOperation =
  | "lease-grant"
  | "lease-keepalive"
  | "lease-revoke"
  | "txn"
  | "range"
  | "watch"

/** Describes one status-only etcd JSON-gateway error. */
export interface EtcdHttpError extends Error {
  readonly name: "EtcdHttpError"
  readonly code: "LIKEGO_ETCD_HTTP"
  readonly operation: EtcdOperation
  readonly status: number
}

/** Describes one secret-safe Fetch rejection. */
export interface EtcdTransportError extends Error {
  readonly name: "EtcdTransportError"
  readonly code: "LIKEGO_ETCD_TRANSPORT"
  readonly operation: EtcdOperation
  readonly cause: Error
}

/** Documents the structural result of the sole public constructor. */
export interface EtcdRegistry extends Registry {}
