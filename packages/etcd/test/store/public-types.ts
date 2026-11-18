import type { Store } from "@go-like/core/store"

import { newEtcdClient } from "../../src/index"
import {
  newEtcdStore,
  type EtcdStore,
  type EtcdStoreCleanupError,
  type EtcdStoreCompactedError,
  type EtcdStoreLeaseLostError,
  type EtcdStoreUncertainError
} from "../../src/store/index"

const client = newEtcdClient({
  address: "http://127.0.0.1:2379",
  async fetch(): Promise<Response> {
    return new Response()
  }
})
const etcd: EtcdStore = newEtcdStore(client)
const structural: Store = etcd
declare const compacted: EtcdStoreCompactedError
declare const leaseLost: EtcdStoreLeaseLostError
declare const uncertain: EtcdStoreUncertainError
declare const cleanup: EtcdStoreCleanupError

void [structural, compacted, leaseLost, uncertain, cleanup]
