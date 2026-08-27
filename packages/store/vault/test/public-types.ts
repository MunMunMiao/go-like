import type { Store } from "@go-like/store"

import {
  newVaultStore,
  type VaultFetch,
  type VaultStore,
  type VaultStoreHttpError,
  type VaultStoreOperation,
  type VaultStoreOptions,
  type VaultStoreProtocolError,
  type VaultStoreSnapshotError,
  type VaultStoreTransportError,
  type VaultStoreUncertainError
} from "../src/index"

declare const fetch: VaultFetch
const options: VaultStoreOptions = {
  fetch,
  address: "http://127.0.0.1:8200",
  mount: "secret"
}
const vault: VaultStore = newVaultStore(options)
const structural: Store = vault
declare const operation: VaultStoreOperation
declare const http: VaultStoreHttpError
declare const protocol: VaultStoreProtocolError
declare const transport: VaultStoreTransportError
declare const uncertain: VaultStoreUncertainError
declare const snapshot: VaultStoreSnapshotError

void [structural, operation, http, protocol, transport, uncertain, snapshot]
