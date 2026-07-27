import type { Server } from "@likego/core"

/** A one-shot Server that accepts one application-owned Logger stop contract at successful start. */
export interface WinstonServer extends Server {}

export interface WinstonAlreadyStartedError extends Error {
  readonly name: "WinstonAlreadyStartedError"
  readonly code: "LIKEGO_WINSTON_ALREADY_STARTED"
  readonly status: "starting" | "running" | "stopping" | "stopped" | "failed"
}

export interface WinstonLoggerFinishedError extends Error {
  readonly name: "WinstonLoggerFinishedError"
  readonly code: "LIKEGO_WINSTON_LOGGER_FINISHED"
}

export interface WinstonLoggerClosedError extends Error {
  readonly name: "WinstonLoggerClosedError"
  readonly code: "LIKEGO_WINSTON_LOGGER_CLOSED"
}
