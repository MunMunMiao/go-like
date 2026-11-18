import { captureConnection, type Connection } from "./options"
import type { Fetch } from "@go-like/core/fetch"

declare const vaultClientBrand: unique symbol

/**
 * Opaque Vault client handle. The runtime brand is the module-private WeakMap in this file;
 * sockets reject any object that newVaultClient did not create.
 */
export interface VaultClient {
  readonly [vaultClientBrand]: true
}

/** Connection options previously spread across config and store. */
export interface VaultClientOptions {
  readonly fetch: Fetch
  /** HTTP(S) origin of Vault, for example "https://vault.example:8200". */
  readonly address: string
  /** Sent as X-Vault-Token. */
  readonly token?: string
  /** Sent as X-Vault-Namespace (Vault Enterprise). */
  readonly namespace?: string
}

const clients = new WeakMap<VaultClient, Connection>()

/** Creates the shared Vault client. Invalid address, token, or namespace throws before any I/O. */
export function newVaultClient(options: VaultClientOptions): VaultClient {
  const connection = captureConnection(options)
  const client = Object.freeze(Object.create(null)) as VaultClient
  clients.set(client, connection)
  return client
}

/** Returns the connection for a client created by this package. */
export function openVaultClient(client: VaultClient): Connection {
  if (typeof client !== "object" || client === null) {
    throw new TypeError("Vault client must be created by newVaultClient")
  }
  const connection = clients.get(client)
  if (connection === undefined) {
    throw new TypeError("Vault client must be created by newVaultClient")
  }
  return connection
}
