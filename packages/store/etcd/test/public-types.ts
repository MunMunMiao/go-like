import type { Store } from "@likego/store"

import {
  newEtcdStore,
  type EtcdStore,
  type EtcdStoreCleanupError,
  type EtcdStoreCompactedError,
  type EtcdStoreFetch,
  type EtcdStoreHttpError,
  type EtcdStoreLeaseLostError,
  type EtcdStoreOperation,
  type EtcdStoreOptions,
  type EtcdStoreProtocolError,
  type EtcdStoreTransportError,
  type EtcdStoreUncertainError
} from "../src/index"

declare const fetch: EtcdStoreFetch
const options: EtcdStoreOptions = { fetch, address: "http://127.0.0.1:2379" }
const etcd: EtcdStore = newEtcdStore(options)
const structural: Store = etcd
declare const operation: EtcdStoreOperation
declare const http: EtcdStoreHttpError
declare const protocol: EtcdStoreProtocolError
declare const transport: EtcdStoreTransportError
declare const compacted: EtcdStoreCompactedError
declare const leaseLost: EtcdStoreLeaseLostError
declare const uncertain: EtcdStoreUncertainError
declare const cleanup: EtcdStoreCleanupError

void [structural, operation, http, protocol, transport, compacted, leaseLost, uncertain, cleanup]
