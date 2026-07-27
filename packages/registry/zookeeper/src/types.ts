import type { Registry } from "@likego/registry"
import type { ProviderLogger, RegistrationErrorHandler } from "@likego/registry/provider"

/** Identifies the ACL applied to every provider-managed znode. */
export type ZookeeperAcl = "open" | "creator"

/** Captures one ZooKeeper authentication credential without exposing it through Registry options. */
export interface ZookeeperAuth {
  readonly scheme: string
  readonly credential: string | Uint8Array
}

/** Reports the connection transitions relevant to an owned ZooKeeper session. */
export type ZookeeperClientState =
  | "connected"
  | "disconnected"
  | "expired"
  | "authentication-failed"

/** Describes one child-list result together with its parent stat version. */
export interface ZookeeperChildren {
  readonly names: readonly string[]
}

/** Describes one provider mutation committed by a ZooKeeper multi operation. */
export type ZookeeperMutation =
  | {
      readonly kind: "create-ephemeral"
      readonly path: string
      readonly data: Uint8Array
    }
  | {
      readonly kind: "delete"
      readonly path: string
    }

/** Defines the promise-oriented native boundary used by the Registry implementation. */
export interface ZookeeperClient {
  /** Opens the underlying session. */
  connect(signal: AbortSignal): Promise<void>
  /** Closes the session and releases its ephemeral znodes. */
  close(signal: AbortSignal): Promise<void>
  /** Subscribes to session state transitions and returns an unsubscribe function. */
  onState(listener: (state: ZookeeperClientState) => void): () => void
  /** Ensures one persistent path exists with the configured ACL. */
  mkdirp(path: string, signal: AbortSignal): Promise<void>
  /** Reads one znode's children without installing a watch. */
  children(path: string, signal: AbortSignal): Promise<ZookeeperChildren>
  /** Reads children and installs one one-shot watch. */
  watchChildren(path: string, listener: () => void, signal: AbortSignal): Promise<ZookeeperChildren>
  /** Reads one exact znode payload. */
  data(path: string, signal: AbortSignal): Promise<Uint8Array>
  /** Atomically applies exact ephemeral creates and deletes; cancellation only gates submission. */
  mutate(mutations: readonly ZookeeperMutation[], signal: AbortSignal): Promise<void>
  /** Removes one exact znode, reporting false when it is already absent. */
  remove(path: string, signal: AbortSignal): Promise<boolean>
}

/** Supplies one owned native client for each registration or watcher session. */
export interface ZookeeperClientFactory {
  /** Creates one disconnected client from an immutable secret-bearing snapshot. */
  (options: ZookeeperClientFactoryOptions): ZookeeperClient
}

/** Captures the exact native client controls supplied to a factory. */
export interface ZookeeperClientFactoryOptions {
  readonly connectionString: string
  readonly sessionTimeoutMs: number
  readonly spinDelayMs: number
  readonly retries: number
  readonly auth: {
    readonly scheme: string
    readonly credential: Uint8Array
  } | null
  readonly acl: ZookeeperAcl
}

/** Configures one Node/Bun ZooKeeper Registry. */
export interface ZookeeperRegistryOptions {
  readonly address: string
  readonly root?: string
  readonly auth?: ZookeeperAuth
  readonly acl?: ZookeeperAcl
  readonly sessionTimeoutMs?: number
  readonly spinDelayMs?: number
  readonly retries?: number
  readonly retryInitialMs?: number
  readonly retryMaximumMs?: number
  readonly reconcileIntervalMs?: number
  readonly watchBufferSize?: number
  readonly timeoutMs?: number
  readonly logger?: ProviderLogger | null
  readonly onRegistrationError?: RegistrationErrorHandler | null
  readonly clientFactory?: ZookeeperClientFactory
}

/** Identifies one promise-oriented ZooKeeper boundary operation. */
export type ZookeeperOperation =
  | "connect"
  | "close"
  | "mkdirp"
  | "children"
  | "watch-children"
  | "data"
  | "mutate"
  | "remove"

/** Describes one secret-safe native ZooKeeper operation failure. */
export interface ZookeeperOperationError extends Error {
  readonly name: "ZookeeperOperationError"
  readonly code: "LIKEGO_ZOOKEEPER_OPERATION"
  readonly operation: ZookeeperOperation
  readonly nativeCode: number | null
  readonly retryable: boolean
}

/** Describes one secret-safe authentication terminal. */
export interface ZookeeperAuthenticationError extends Error {
  readonly name: "ZookeeperAuthenticationError"
  readonly code: "LIKEGO_ZOOKEEPER_AUTHENTICATION"
}

/** Documents the structural result of the sole public constructor. */
export interface ZookeeperRegistry extends Registry {}
