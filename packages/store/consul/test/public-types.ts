import type { Store } from "@likego/store"

import {
  newConsulStore,
  type ConsulFetch,
  type ConsulStore,
  type ConsulStoreHttpError,
  type ConsulStoreOperation,
  type ConsulStoreOptions,
  type ConsulStoreProtocolError,
  type ConsulStoreTransportError,
  type ConsulStoreUncertainError,
  type ConsulStoreUnsupportedCombination,
  type ConsulStoreUnsupportedCombinationError
} from "../src/index"

declare const fetch: ConsulFetch
const options: ConsulStoreOptions = {
  fetch,
  address: "http://127.0.0.1:8500",
  root: "services/orders"
}
const consul: ConsulStore = newConsulStore(options)
const structural: Store = consul
declare const operation: ConsulStoreOperation
declare const http: ConsulStoreHttpError
declare const protocol: ConsulStoreProtocolError
declare const transport: ConsulStoreTransportError
declare const uncertain: ConsulStoreUncertainError
declare const combination: ConsulStoreUnsupportedCombination
declare const unsupported: ConsulStoreUnsupportedCombinationError

void [structural, operation, http, protocol, transport, uncertain, combination, unsupported]
