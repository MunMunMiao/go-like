import type { LogHandler } from "@go-like/core/log"
import type { TelemetryLifecycle } from "@go-like/core/telemetry"

/** Mutable construction state used only by functional options. */
export interface PinoHandlerConfig {
  drainTimeoutMs: number
}

/**
 * Functional option for `newPinoHandler`, produced by `pinoDrainTimeout`.
 * The option mutates construction state and performs no I/O.
 */
export type PinoHandlerOption = (config: PinoHandlerConfig) => void

/**
 * Core `LogHandler` backed by an application-owned Pino logger.
 * `lifecycle` owns the transferred destination: admission binds a child logger
 * carrying `service.*`, and stop flushes, ends, and waits for close.
 */
export interface PinoHandler extends LogHandler {
  readonly lifecycle: TelemetryLifecycle
}

/** Raised when `start` is called after the handler has left `idle`. */
export interface PinoAlreadyStartedError extends Error {
  readonly name: "PinoAlreadyStartedError"
  readonly code: "GO_LIKE_PINO_ALREADY_STARTED"
  readonly status: "starting" | "running" | "stopping" | "stopped" | "failed"
}

/**
 * Raised when the destination does not close within the owner drain budget.
 * `forceSupported` is true only for file destinations that expose `destroy()`.
 */
export interface PinoDrainTimeoutError extends Error {
  readonly name: "PinoDrainTimeoutError"
  readonly code: "GO_LIKE_PINO_DRAIN_TIMEOUT"
  readonly timeoutMs: number
  readonly forceSupported: boolean
}

/** Raised when the destination emits `error` or `close` before the owner stops it. */
export interface PinoDestinationClosedError extends Error {
  readonly name: "PinoDestinationClosedError"
  readonly code: "GO_LIKE_PINO_DESTINATION_CLOSED"
}
