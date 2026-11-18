import type { RegistrationErrorHandler, Registry } from "@go-like/core/registry"

/** Configures one Consul Registry. Connection fields live on ConsulClientOptions. */
export interface ConsulRegistryOptions {
  /** Blocking-query wait, integer 1..600000, default 300000. */
  readonly waitMs?: number
  /** Minimum time between two health queries of one watcher, 1..60000, default 1000. */
  readonly minimumQueryIntervalMs?: number
  /** Watch and heartbeat retry delays: initial 1..60000 (default 250), maximum initial..600000 (default 30000). */
  readonly retryInitialMs?: number
  readonly retryMaximumMs?: number
  /** DeregisterCriticalServiceAfter of the TTL check, 60000..86400000, default 60000. */
  readonly deregisterCriticalServiceAfterMs?: number
  /** Watcher queue bound 1..4096, default 128. */
  readonly watchBufferSize?: number
  /** TTL check, 2000..86400000, default 120000; heartbeat every ttlMs / 2. */
  readonly ttlMs?: number
  /** Non-blocking request bound, default 5000. */
  readonly timeoutMs?: number
  readonly onRegistrationError?: RegistrationErrorHandler | null
}

/** Documents the structural result of the sole public constructor. */
export interface ConsulRegistry extends Registry {}
