import type { Store } from "@go-like/core/store"

/** Identifies one secret-safe etcd Store protocol boundary before the store prefix. */
export type EtcdStoreOperation =
  | "read"
  | "write"
  | "write-readback"
  | "delete"
  | "delete-readback"
  | "list"
  | "lease-grant"
  | "lease-revoke"

/** Describes a historical pagination revision removed by etcd compaction. */
export interface EtcdStoreCompactedError extends Error {
  readonly name: "EtcdStoreCompactedError"
  readonly code: "GO_LIKE_ETCD_STORE_COMPACTED"
  readonly revision: string
}

/** Describes a TTL mutation whose granted lease disappeared before commit. */
export interface EtcdStoreLeaseLostError extends Error {
  readonly name: "EtcdStoreLeaseLostError"
  readonly code: "GO_LIKE_ETCD_STORE_LEASE_LOST"
  readonly operation: "write"
}

/** Describes a mutation whose exact readback could not prove its outcome. */
export interface EtcdStoreUncertainError extends Error {
  readonly name: "EtcdStoreUncertainError"
  readonly code: "GO_LIKE_ETCD_STORE_UNCERTAIN"
  readonly operation: "write" | "delete"
  readonly cause: Error
}

/** Describes a committed mutation whose obsolete lease could not be released. */
export interface EtcdStoreCleanupError extends Error {
  readonly name: "EtcdStoreCleanupError"
  readonly code: "GO_LIKE_ETCD_STORE_CLEANUP"
  readonly operation: "write" | "delete"
  readonly committed: true
  readonly cause: Error
}

/** Documents the structural result of the public constructor. */
export interface EtcdStore extends Store {}
