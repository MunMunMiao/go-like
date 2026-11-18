import type { EtcdClient } from "../client/client"
import { createEtcdStore } from "./store"
import type { EtcdStore } from "./types"

export type {
  EtcdStore,
  EtcdStoreCleanupError,
  EtcdStoreCompactedError,
  EtcdStoreLeaseLostError,
  EtcdStoreUncertainError
} from "./types"

/** Creates one immediately usable etcd Store on a shared etcd client. */
export function newEtcdStore(client: EtcdClient): EtcdStore {
  return createEtcdStore(client)
}
