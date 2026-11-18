import type { LogHandler } from "@go-like/core/log"
import type { TelemetryLifecycle } from "@go-like/core/telemetry"

/**
 * Core `LogHandler` backed by an application-owned Winston logger.
 * Admission binds a child logger carrying `service.*`. Stop calls `logger.end()`
 * and waits for `finish` or `close`.
 */
export interface WinstonHandler extends LogHandler {
  readonly lifecycle: TelemetryLifecycle
}

/** Raised when `start` is called after the handler has left `idle`. */
export interface WinstonAlreadyStartedError extends Error {
  readonly name: "WinstonAlreadyStartedError"
  readonly code: "GO_LIKE_WINSTON_ALREADY_STARTED"
  readonly status: "starting" | "running" | "stopping" | "stopped" | "failed"
}

/** Raised when admission finds a logger whose writable side has already finished. */
export interface WinstonLoggerFinishedError extends Error {
  readonly name: "WinstonLoggerFinishedError"
  readonly code: "GO_LIKE_WINSTON_LOGGER_FINISHED"
}

/** Raised when admission finds a logger that has already closed. */
export interface WinstonLoggerClosedError extends Error {
  readonly name: "WinstonLoggerClosedError"
  readonly code: "GO_LIKE_WINSTON_LOGGER_CLOSED"
}
