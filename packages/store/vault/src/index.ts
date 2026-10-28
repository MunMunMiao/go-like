import { createStore } from "./store"
import type { VaultStore, VaultStoreOptions } from "./types"

export type {
  VaultFetch,
  VaultStore,
  VaultStoreHttpError,
  VaultStoreOperation,
  VaultStoreOptions,
  VaultStoreProtocolError,
  VaultStoreSnapshotError,
  VaultStoreTransportError,
  VaultStoreUncertainError
} from "./types"

/** Creates one immediately usable Vault KV v2 Store over a borrowed standard Fetch capability. */
export function newVaultStore(options: VaultStoreOptions): VaultStore {
  return createStore(options)
}
