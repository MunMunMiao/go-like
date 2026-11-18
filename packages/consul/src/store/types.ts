import type { Store } from "@go-like/core/store"

/** Configures one Consul KV Store. Connection fields live on ConsulClientOptions. */
export interface ConsulStoreOptions {
  /** Key root that isolates the store, default "go-like/store". */
  readonly root?: string
}

/** Store wire operations before the shared error family adds the store prefix. */
export type ConsulStoreWireOperation =
  | "read"
  | "write"
  | "delete"
  | "list"
  | "session-create"
  | "session-readback"
  | "session-destroy"

/** Describes a mutation whose exact readback could not prove its outcome. */
export interface ConsulStoreUncertainError extends Error {
  readonly name: "ConsulStoreUncertainError"
  readonly code: "GO_LIKE_CONSUL_STORE_UNCERTAIN"
  readonly operation: "write" | "delete" | "session-create" | "session-destroy"
  readonly cause: Error
}

/** Identifies a Consul flag combination that cannot be made atomic. */
export type ConsulStoreUnsupportedCombination = "ttl-cas" | "cas-existing-ttl"

/** Describes one fail-closed Consul-specific unsupported option combination. */
export interface ConsulStoreUnsupportedCombinationError extends Error {
  readonly name: "ConsulStoreUnsupportedCombinationError"
  readonly code: "GO_LIKE_CONSUL_STORE_UNSUPPORTED_COMBINATION"
  readonly combination: ConsulStoreUnsupportedCombination
}

/** Documents the structural result of the sole public constructor. */
export interface ConsulStore extends Store {}
