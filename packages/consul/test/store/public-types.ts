import type { Store } from "@go-like/core/store"

import type {
  ConsulHttpError,
  ConsulOperation,
  ConsulProtocolError,
  ConsulTransportError
} from "../../src/index"
import { newConsulClient } from "../../src/index"
import {
  newConsulStore,
  type ConsulStore,
  type ConsulStoreOptions,
  type ConsulStoreUncertainError,
  type ConsulStoreUnsupportedCombination,
  type ConsulStoreUnsupportedCombinationError
} from "../../src/store/index"

declare const fetch: (request: Request) => Promise<Response>
const client = newConsulClient({
  fetch,
  address: "http://127.0.0.1:8500"
})
const options: ConsulStoreOptions = {
  root: "services/orders"
}
const consul: ConsulStore = newConsulStore(client, options)
const structural: Store = consul
declare const operation: ConsulOperation
declare const http: ConsulHttpError
declare const protocol: ConsulProtocolError
declare const transport: ConsulTransportError
declare const uncertain: ConsulStoreUncertainError
declare const combination: ConsulStoreUnsupportedCombination
declare const unsupported: ConsulStoreUnsupportedCombinationError

void [structural, operation, http, protocol, transport, uncertain, combination, unsupported]
