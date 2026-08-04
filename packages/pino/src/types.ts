import type { Server } from "@go-like/core"

/** Default Pino destination shutdown boundary. */
export const defaultPinoDrainTimeoutMs = 25_000

/** Package-private seam for the one borrowed logger operation consumed by the runtime. */
export interface LoggerFlushLifecycle {
  /** Flushes records already admitted by the logger. */
  flush(callback?: (error?: Error) => void): void
}

/** Package-private seam for native destination ownership and deterministic test doubles. */
export interface DestinationLifecycle {
  /** Signals that no further log records will be written. */
  end(): void

  /** Immediately closes destinations that expose an official force primitive. */
  destroy?(): void

  /** Registers a one-shot native lifecycle listener. */
  once(
    event: string,
    listener: (
      ...values: unknown[] /* go-like-typed-rest: preserves Pino DestinationStream's EventEmitter-compatible listener ABI. */
    ) => void
  ): this

  /** Registers a persistent native lifecycle listener. */
  on(
    event: string,
    listener: (
      ...values: unknown[] /* go-like-typed-rest: preserves Pino DestinationStream's EventEmitter-compatible listener ABI. */
    ) => void
  ): this

  /** Removes one previously registered native lifecycle listener. */
  removeListener(
    event: string,
    listener: (
      ...values: unknown[] /* go-like-typed-rest: preserves Pino DestinationStream's EventEmitter-compatible listener ABI. */
    ) => void
  ): this
}

/** One Go-style functional option for Pino destination lifecycle. */
export type PinoServerOption = (config: PinoServerConfig) => void

/** Mutable construction state used only by functional options. */
export interface PinoServerConfig {
  drainTimeoutMs: number
}

/** A one-shot structural Server that owns one transferred Pino destination. */
export interface PinoServer extends Server {}

export interface PinoAlreadyStartedError extends Error {
  readonly name: "PinoAlreadyStartedError"
  readonly code: "GO_LIKE_PINO_ALREADY_STARTED"
  readonly status: "starting" | "running" | "stopping" | "stopped" | "failed"
}

export interface PinoDrainTimeoutError extends Error {
  readonly name: "PinoDrainTimeoutError"
  readonly code: "GO_LIKE_PINO_DRAIN_TIMEOUT"
  readonly timeoutMs: number
  readonly forceSupported: boolean
}

export interface PinoDestinationClosedError extends Error {
  readonly name: "PinoDestinationClosedError"
  readonly code: "GO_LIKE_PINO_DESTINATION_CLOSED"
}
