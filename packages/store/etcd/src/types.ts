import type { Store } from "@go-like/store"

/** Executes one borrowed standard Web Fetch request. */
export interface EtcdStoreFetch {
  /** Performs one operation without transferring Fetch ownership to the Store. */
  (request: Request): Response | PromiseLike<Response>
}

/** Configures one portable etcd v3 JSON gateway Store. */
export interface EtcdStoreOptions {
  readonly fetch: EtcdStoreFetch
  readonly address: string
  /** Supplies the bearer token without the `Bearer` scheme. */
  readonly token?: string
}

/** Identifies one secret-safe etcd Store protocol boundary. */
export type EtcdStoreOperation =
  | "read"
  | "write"
  | "write-readback"
  | "delete"
  | "delete-readback"
  | "list"
  | "lease-grant"
  | "lease-revoke"

/** Describes one non-success etcd JSON gateway response. */
export interface EtcdStoreHttpError extends Error {
  readonly name: "EtcdStoreHttpError"
  readonly code: "GO_LIKE_ETCD_STORE_HTTP"
  readonly operation: EtcdStoreOperation
  readonly status: number
  readonly grpcCode: number | null
}

/** Describes one secret-safe borrowed Fetch rejection. */
export interface EtcdStoreTransportError extends Error {
  readonly name: "EtcdStoreTransportError"
  readonly code: "GO_LIKE_ETCD_STORE_TRANSPORT"
  readonly operation: EtcdStoreOperation
}

/** Describes malformed gateway data without retaining response contents. */
export interface EtcdStoreProtocolError extends Error {
  readonly name: "EtcdStoreProtocolError"
  readonly code: "GO_LIKE_ETCD_STORE_PROTOCOL"
  readonly operation: EtcdStoreOperation
}

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
