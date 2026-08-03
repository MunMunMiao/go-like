import { createEtcdStore } from "./store"
import type { EtcdStore, EtcdStoreOptions } from "./types"

export type {
  EtcdStore,
  EtcdStoreCleanupError,
  EtcdStoreCompactedError,
  EtcdStoreFetch,
  EtcdStoreHttpError,
  EtcdStoreLeaseLostError,
  EtcdStoreOperation,
  EtcdStoreOptions,
  EtcdStoreProtocolError,
  EtcdStoreTransportError,
  EtcdStoreUncertainError
} from "./types"

/** Creates one immediately usable etcd Store over a borrowed standard Fetch capability. */
export function newEtcdStore(options: EtcdStoreOptions): EtcdStore {
  return createEtcdStore(options)
}
