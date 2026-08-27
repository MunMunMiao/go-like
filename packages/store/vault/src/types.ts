import type { Store } from "@go-like/store"

/** Executes one borrowed standard Web Fetch request. */
export interface VaultFetch {
  /** Performs one Vault HTTP operation without transferring capability ownership. */
  (request: Request): Promise<Response>
}

/** Configures one Vault KV v2 Store rooted in an isolated physical keyspace. */
export interface VaultStoreOptions {
  readonly fetch: VaultFetch
  readonly address: string
  readonly mount: string
  readonly root?: string
  readonly token?: string
  readonly namespace?: string
  /** Bounds one process-local immutable pagination snapshot; defaults to 60000 milliseconds. */
  readonly cursorTtlMs?: number
}

/** Identifies one secret-safe Vault boundary operation. */
export type VaultStoreOperation = "read" | "write" | "delete" | "list"

/** Describes one stable Vault non-success response without retaining its body. */
export interface VaultStoreHttpError extends Error {
  readonly name: "VaultStoreHttpError"
  readonly code: "GO_LIKE_VAULT_STORE_HTTP"
  readonly operation: VaultStoreOperation
  readonly status: number
}

/** Describes one malformed Vault response without retaining its body. */
export interface VaultStoreProtocolError extends Error {
  readonly name: "VaultStoreProtocolError"
  readonly code: "GO_LIKE_VAULT_STORE_PROTOCOL"
  readonly operation: VaultStoreOperation
}

/** Describes one Fetch failure; secret-bearing requests replace the foreign rejection graph. */
export interface VaultStoreTransportError extends Error {
  readonly name: "VaultStoreTransportError"
  readonly code: "GO_LIKE_VAULT_STORE_TRANSPORT"
  readonly operation: VaultStoreOperation
  readonly cause: Error
}

/** Describes one mutation whose exact outcome could not be proved by Vault readback. */
export interface VaultStoreUncertainError extends Error {
  readonly name: "VaultStoreUncertainError"
  readonly code: "GO_LIKE_VAULT_STORE_UNCERTAIN"
  readonly operation: "write" | "delete"
  readonly cause: Error
}

/** Identifies one bounded process-local pagination snapshot failure. */
export interface VaultStoreSnapshotError extends Error {
  readonly name: "VaultStoreSnapshotError"
  readonly code: "GO_LIKE_VAULT_STORE_SNAPSHOT"
  readonly reason: "invalid-cursor" | "expired-cursor" | "capacity"
}

/** Exposes the provider-neutral Store contract for Vault KV v2. */
export interface VaultStore extends Store {}
