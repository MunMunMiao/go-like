import type { Store } from "@likego/store"

/** Executes one borrowed standard Web Fetch request. */
export interface ConsulFetch {
  /** Performs one standard Fetch operation without transferring capability ownership. */
  (request: Request): Promise<Response>
}

/** Configures one portable Consul KV Store provider. */
export interface ConsulStoreOptions {
  readonly fetch: ConsulFetch
  readonly address: string
  /** Selects the isolated Consul KV root; defaults to `likego/store`. */
  readonly root?: string
  readonly token?: string
  readonly datacenter?: string
  readonly namespace?: string
}

/** Identifies one secret-safe Consul Store HTTP boundary. */
export type ConsulStoreOperation =
  | "read"
  | "write"
  | "delete"
  | "list"
  | "session-create"
  | "session-readback"
  | "session-destroy"

/** Describes one non-success Consul HTTP response. */
export interface ConsulStoreHttpError extends Error {
  readonly name: "ConsulStoreHttpError"
  readonly code: "LIKEGO_CONSUL_STORE_HTTP"
  readonly operation: ConsulStoreOperation
  readonly status: number
}

/** Describes one secret-safe borrowed Fetch rejection. */
export interface ConsulStoreTransportError extends Error {
  readonly name: "ConsulStoreTransportError"
  readonly code: "LIKEGO_CONSUL_STORE_TRANSPORT"
  readonly operation: ConsulStoreOperation
  readonly cause: Error
}

/** Describes malformed Consul protocol data without retaining response contents. */
export interface ConsulStoreProtocolError extends Error {
  readonly name: "ConsulStoreProtocolError"
  readonly code: "LIKEGO_CONSUL_STORE_PROTOCOL"
  readonly operation: ConsulStoreOperation
}

/** Describes a mutation whose exact readback could not prove its outcome. */
export interface ConsulStoreUncertainError extends Error {
  readonly name: "ConsulStoreUncertainError"
  readonly code: "LIKEGO_CONSUL_STORE_UNCERTAIN"
  readonly operation: "write" | "delete" | "session-create" | "session-destroy"
  readonly cause: Error
}

/** Identifies a Consul 2.0.2 flag combination that cannot be made atomic. */
export type ConsulStoreUnsupportedCombination = "ttl-cas" | "cas-existing-ttl"

/** Describes one fail-closed Consul-specific unsupported option combination. */
export interface ConsulStoreUnsupportedCombinationError extends Error {
  readonly name: "ConsulStoreUnsupportedCombinationError"
  readonly code: "LIKEGO_CONSUL_STORE_UNSUPPORTED_COMBINATION"
  readonly combination: ConsulStoreUnsupportedCombination
}

/** Documents the structural result of the sole public constructor. */
export interface ConsulStore extends Store {}
