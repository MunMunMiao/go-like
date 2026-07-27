import type { Server } from "@likego/core"
import type { Worker } from "bullmq"

/** Creates one application-configured official Worker at the Server startup boundary. */
export type BullMqWorkerFactory<
  DataType = unknown,
  ResultType = unknown,
  NameType extends string = string
> = () => Worker<DataType, ResultType, NameType>

export interface BullMqAlreadyStartedError extends Error {
  readonly name: "BullMqAlreadyStartedError"
  readonly code: "LIKEGO_BULLMQ_ALREADY_STARTED"
  readonly queueName: string
  readonly status: "starting" | "running" | "stopping" | "stopped" | "failed"
}

export interface BullMqUnexpectedExitError extends Error {
  readonly name: "BullMqUnexpectedExitError"
  readonly code: "LIKEGO_BULLMQ_UNEXPECTED_EXIT"
  readonly queueName: string
  readonly cause: Error | null
}

export interface BullMqWorkerShutdownTimeoutError extends Error {
  readonly name: "BullMqWorkerShutdownTimeoutError"
  readonly code: "LIKEGO_BULLMQ_WORKER_SHUTDOWN_TIMEOUT"
  readonly queueName: string
  readonly timeoutMs: number
}

/** A one-shot Server that owns only one official BullMQ Worker's lifecycle. */
export interface BullMqWorkerServer extends Server {}
