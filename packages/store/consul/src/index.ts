import { createConsulStore } from "./store"
import type { ConsulStore, ConsulStoreOptions } from "./types"

export type {
  ConsulFetch,
  ConsulStore,
  ConsulStoreHttpError,
  ConsulStoreOperation,
  ConsulStoreOptions,
  ConsulStoreProtocolError,
  ConsulStoreTransportError,
  ConsulStoreUncertainError,
  ConsulStoreUnsupportedCombination,
  ConsulStoreUnsupportedCombinationError
} from "./types"

/** Creates one immediately usable Consul KV Store over a borrowed standard Fetch capability. */
export function newConsulStore(options: ConsulStoreOptions): ConsulStore {
  return createConsulStore(options)
}
