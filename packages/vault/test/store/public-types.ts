import type { Store } from "@go-like/core/store"

import type {
  VaultHttpError,
  VaultOperation,
  VaultProtocolError,
  VaultTransportError
} from "../../src/index"
import { newVaultClient } from "../../src/index"
import {
  newVaultStore,
  type VaultStore,
  type VaultStoreOptions,
  type VaultStoreSnapshotError,
  type VaultStoreUncertainError
} from "../../src/store/index"

declare const fetch: (request: Request) => Promise<Response>
const client = newVaultClient({
  fetch,
  address: "http://127.0.0.1:8200"
})
const options: VaultStoreOptions = {
  mount: "secret"
}
const vault: VaultStore = newVaultStore(client, options)
const structural: Store = vault
declare const operation: VaultOperation
declare const http: VaultHttpError
declare const protocol: VaultProtocolError
declare const transport: VaultTransportError
declare const uncertain: VaultStoreUncertainError
declare const snapshot: VaultStoreSnapshotError

void [structural, operation, http, protocol, transport, uncertain, snapshot]

// @ts-expect-error Fetch accepts one standard Request rather than a URL string.
fetch(new Request("https://vault.example"), undefined)
