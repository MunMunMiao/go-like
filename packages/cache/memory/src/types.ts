import type { Cache } from "@go-like/cache"

/** Returns one millisecond timestamp for deterministic expiry decisions. */
export type MemoryCacheClock = () => number

/** Captures immutable Memory Cache construction options. */
export interface MemoryCacheOptions {
  readonly clock: MemoryCacheClock
}

/** Reduces one immutable Memory Cache option snapshot to its next candidate. */
export type MemoryCacheOption = (options: MemoryCacheOptions) => MemoryCacheOptions

/** Implements the provider-neutral Cache SPI with process-local state. */
export interface MemoryCache extends Cache {
  /** Returns the stable provider diagnostic name. */
  string(): "memory"
}
