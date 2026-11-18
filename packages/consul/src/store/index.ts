import type { ConsulClient } from "../client/client"
import { createConsulStore } from "./store"
import type { ConsulStore, ConsulStoreOptions } from "./types"

export type {
  ConsulStore,
  ConsulStoreOptions,
  ConsulStoreUncertainError,
  ConsulStoreUnsupportedCombination,
  ConsulStoreUnsupportedCombinationError
} from "./types"

/** Creates one immediately usable Consul KV Store on a shared Consul client. */
export function newConsulStore(client: ConsulClient, options?: ConsulStoreOptions): ConsulStore {
  return createConsulStore(client, options)
}
