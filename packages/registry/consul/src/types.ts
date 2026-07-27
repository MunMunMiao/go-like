import type { Registry } from "@likego/registry"
import type { ProviderLogger, RegistrationErrorHandler } from "@likego/registry/provider"

/** Executes one borrowed standard Web Fetch request without runtime-specific static properties. */
export interface ConsulFetch {
  /** Performs one standard Fetch operation. */
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>
}

/** Configures one portable Consul Registry backed only by a borrowed Fetch capability. */
export interface ConsulRegistryOptions {
  readonly fetch: ConsulFetch
  readonly address: string
  readonly token?: string
  readonly datacenter?: string
  readonly namespace?: string
  readonly waitMs?: number
  readonly minimumQueryIntervalMs?: number
  readonly retryInitialMs?: number
  readonly retryMaximumMs?: number
  readonly deregisterCriticalServiceAfterMs?: number
  readonly watchBufferSize?: number
  readonly ttlMs?: number
  readonly timeoutMs?: number
  readonly logger?: ProviderLogger | null
  readonly onRegistrationError?: RegistrationErrorHandler | null
}

/** Identifies one Consul HTTP boundary without retaining a secret-bearing Request. */
export type ConsulOperation = "register" | "heartbeat" | "deregister" | "readback" | "get" | "watch"

/** Describes one non-success Consul HTTP response. */
export interface ConsulHttpError extends Error {
  readonly name: "ConsulHttpError"
  readonly code: "LIKEGO_CONSUL_HTTP"
  readonly operation: ConsulOperation
  readonly status: number
}

/** Describes one secret-safe Fetch rejection. */
export interface ConsulTransportError extends Error {
  readonly name: "ConsulTransportError"
  readonly code: "LIKEGO_CONSUL_TRANSPORT"
  readonly operation: ConsulOperation
  readonly cause: Error
}

/** Documents the structural result of the sole public constructor. */
export interface ConsulRegistry extends Registry {}
