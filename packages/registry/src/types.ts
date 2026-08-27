import type { Context } from "@go-like/context"
import type { Metadata } from "@go-like/metadata"

/** Describes one service instance registered with or returned by discovery. */
export interface ServiceInstance {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly metadata: Readonly<Record<string, string>>
  readonly endpoints: readonly string[]
}

/** Identifies one portable provider diagnostic level. */
export type ProviderLogLevel = "debug" | "info" | "warn" | "error"

/** Receives secret-safe provider diagnostics without controlling protocol outcomes. */
export interface ProviderLogger {
  /** Records one diagnostic snapshot; implementations may throw without changing protocol results. */
  log(level: ProviderLogLevel, message: string, fields?: Readonly<Record<string, unknown>>): void
}

/** Observes permanent loss of one resident registration generation. */
export type RegistrationErrorHandler = (
  error: Error,
  service: ServiceInstance
) => void | PromiseLike<void>

/** Supplies shared implementation controls from one provider constructor. */
export interface ProviderOptionInput {
  readonly logger?: ProviderLogger | null
  readonly onRegistrationError?: RegistrationErrorHandler | null
  readonly timeoutMs?: number
}

/** Captures shared provider controls as one immutable implementation snapshot. */
export interface ProviderOptions {
  readonly logger: ProviderLogger | null
  readonly onRegistrationError: RegistrationErrorHandler | null
  readonly timeoutMs: number
}

/** Registers and deregisters service instances. */
export interface Registrar {
  /** Registers one immutable service instance. */
  register(ctx: Context, service: ServiceInstance): Promise<void>
  /** Deregisters the exact service instance previously registered. */
  deregister(ctx: Context, service: ServiceInstance): Promise<void>
}

/** Reads and watches complete service-instance snapshots. */
export interface Discovery {
  /** Reads the current immutable snapshot for one service name. */
  getService(ctx: Context, name: string): Promise<readonly ServiceInstance[]>
  /** Opens one watcher whose first next returns the current non-empty snapshot. */
  watch(ctx: Context, name: string): Promise<Watcher>
}

/** Waits for complete replacement snapshots and owns its stop operation. */
export interface Watcher {
  /** Waits for the next complete immutable snapshot. */
  next(ctx: Context): Promise<readonly ServiceInstance[]>
  /** Stops the watcher. */
  stop(ctx: Context): Promise<void>
}

/** Defines the complete provider-neutral Registry contract. */
export interface Registry extends Registrar, Discovery {
  /** Registers one service instance. */
  register(ctx: Context, service: ServiceInstance): Promise<void>
  /** Deregisters one service instance. */
  deregister(ctx: Context, service: ServiceInstance): Promise<void>
  /** Reads complete service-instance snapshots for one name. */
  getService(ctx: Context, name: string): Promise<readonly ServiceInstance[]>
  /** Opens one complete replacement-snapshot watcher. */
  watch(ctx: Context, name: string): Promise<Watcher>
}

/** Identifies one selected endpoint together with its immutable ServiceInstance. */
export interface ServiceEndpoint {
  readonly instance: ServiceInstance
  readonly url: string
}

/** Reports one completed request outcome for future selection policies. */
export interface SelectionOutcome {
  readonly error: Error | null
  readonly replyMetadata?: Metadata
  readonly bytesSent?: boolean
  readonly bytesReceived?: boolean
}

/** Completes one selection observation without transferring resource ownership. */
export type SelectionDone = (
  /** Bounds this explicit feedback call. */
  ctx: Context,
  /** Reports the outcome associated with the exact selection. */
  outcome: SelectionOutcome
) => void

/** Filters one ServiceInstance snapshot before endpoint selection. */
export type Filter = (instances: readonly ServiceInstance[]) => readonly ServiceInstance[]

/** Selects one endpoint from a complete ServiceInstance snapshot. */
export interface Selector {
  /** Returns one immutable endpoint and its future-policy feedback callback. */
  select(
    ctx: Context,
    instances: readonly ServiceInstance[]
  ): readonly [ServiceEndpoint, SelectionDone]
}

/** Configures one power-of-two-choices selector with deterministic injectable sources. */
export interface P2CSelectorOptions {
  /** Supplies one random number from zero inclusive to one exclusive. */
  readonly random?: () => number
  /** Supplies one finite non-negative monotonic time in milliseconds. */
  readonly now?: () => number
  /** Sets consecutive failures required before one endpoint enters cooldown. */
  readonly failureThreshold?: number
  /** Sets the bounded endpoint cooldown duration in integer milliseconds. */
  readonly cooldownMs?: number
}

/** Configures one latency-and-health EWMA selector with deterministic injectable sources. */
export interface EWMASelectorOptions {
  /** Supplies one random number from zero inclusive to one exclusive. */
  readonly random?: () => number
  /** Supplies one finite non-negative monotonic time in milliseconds. */
  readonly now?: () => number
  /** Classifies additional endpoint-health failures after built-in portable transport failures. */
  readonly isFailure?: (error: Error) => boolean
}

/** Describes a stable failure for an invalid Registry operation state. */
export interface RegistryStateError extends Error {
  readonly name: "RegistryStateError"
  readonly code: "GO_LIKE_REGISTRY_STATE"
  readonly operation: string
  readonly state: string
}

/** Describes an operation attempted through a stopped Watcher. */
export interface WatcherStoppedError extends Error {
  readonly name: "WatcherStoppedError"
  readonly code: "GO_LIKE_WATCHER_STOPPED"
}

/** Describes terminal loss of raw watch events caused by a full buffer. */
export interface WatcherOverflowError extends Error {
  readonly name: "WatcherOverflowError"
  readonly code: "GO_LIKE_WATCHER_OVERFLOW"
  readonly bufferSize: number
}

/** Describes a fail-closed conflict or malformed provider wire payload. */
export interface RegistryProtocolError extends Error {
  readonly name: "RegistryProtocolError"
  readonly code: "GO_LIKE_REGISTRY_PROTOCOL"
}

/** Describes a request outside a provider's honest capability snapshot. */
export interface UnsupportedRegistryCapabilityError extends Error {
  readonly name: "UnsupportedRegistryCapabilityError"
  readonly code: "GO_LIKE_UNSUPPORTED_REGISTRY_CAPABILITY"
  readonly capability: string
}

/** Describes a selector call with no available endpoint. */
export interface NoAvailableEndpointError extends Error {
  readonly name: "NoAvailableEndpointError"
  readonly code: "GO_LIKE_NO_AVAILABLE_ENDPOINT"
}
