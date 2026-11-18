import type { Store } from "@go-like/core/store"

import type { VaultStoreWireOperation } from "../client/kv2"

/** Store wire operation before the shared `store.` prefix is applied. */
export type VaultStoreOperation = VaultStoreWireOperation

/** Configures one Vault KV v2 Store rooted in an isolated physical keyspace. */
export interface VaultStoreOptions {
  readonly mount: string
  /** Default "go-like/store". */
  readonly root?: string
  /** Bounds one process-local immutable pagination snapshot; defaults to 60000 milliseconds. */
  readonly cursorTtlMs?: number
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
