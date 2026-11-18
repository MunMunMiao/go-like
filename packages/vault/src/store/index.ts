import type { VaultClient } from "../client/client"
import { createStore } from "./store"
import type { VaultStore, VaultStoreOptions } from "./types"

export type {
  VaultStore,
  VaultStoreOptions,
  VaultStoreSnapshotError,
  VaultStoreUncertainError
} from "./types"

/** Creates one immediately usable Vault KV v2 Store on a shared Vault client. */
export function newVaultStore(client: VaultClient, options: VaultStoreOptions): VaultStore {
  return createStore(client, options)
}
