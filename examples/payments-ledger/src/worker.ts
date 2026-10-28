import { withCancel, withoutCancel, type Context } from "@go-like/context"
import type { Server } from "@go-like/core"

import { requireActiveContext, type OutboxPublishResult } from "./payment"

export type OutboxPublishAttempt = (ctx: Context) => Promise<OutboxPublishResult>
export type OutboxPublisherStatus = "idle" | "running" | "stopping" | "stopped" | "failed"

export interface OutboxPublisherDiagnostics {
  readonly status: OutboxPublisherStatus
  readonly attempts: number
  readonly published: number
}

export interface OutboxPublisherServer extends Server {
  diagnostics(): OutboxPublisherDiagnostics
}

/** Waits for the next polling turn while allowing shutdown to clear the timer immediately. */
function pollDelay(ctx: Context, delayMs: number): Promise<void> {
  const signal = ctx.done()
  if (signal?.aborted === true) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const timer = setTimeout(finish, delayMs)

    /** Settles the delay once and releases both timer and cancellation listener. */
    function finish(): void {
      clearTimeout(timer)
      signal?.removeEventListener("abort", finish)
      resolve()
    }

    signal?.addEventListener("abort", finish, { once: true })
    if (signal?.aborted === true) finish()
  })
}

/** Creates a structural Server around one existing outbox publish attempt. */
export function newOutboxPublisherServer(
  publish: OutboxPublishAttempt,
  pollIntervalMs = 250
): OutboxPublisherServer {
  if (typeof publish !== "function")
    throw new TypeError("outbox publish attempt must be a function")
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 0 || pollIntervalMs > 2_147_483_647) {
    throw new RangeError("outbox poll interval must be an integer from 0 to 2147483647")
  }

  let status: OutboxPublisherStatus = "idle"
  let attempts = 0
  let published = 0
  let cancelWorker: (() => void) | null = null
  let terminal: Promise<void> | null = null

  return Object.freeze({
    async start(ctx: Context): Promise<void> {
      requireActiveContext(ctx)
      if (status !== "idle") throw new Error("outbox publisher server already started")

      const worker = withCancel(withoutCancel(ctx))
      const workerContext = worker[0]
      cancelWorker = worker[1]
      status = "running"

      /** Runs publish attempts until the structural Server owner requests cancellation. */
      async function run(): Promise<void> {
        try {
          while (workerContext.err() === null) {
            attempts += 1
            let result: OutboxPublishResult
            try {
              result = await publish(workerContext)
            } catch (error) {
              if (workerContext.err() !== null) break
              status = "failed"
              throw error
            }
            if (result.kind === "published") published += 1
            await pollDelay(workerContext, result.kind === "idle" ? pollIntervalMs : 0)
          }
          status = "stopped"
        } catch (error) {
          status = "failed"
          throw error
        }
      }

      terminal = run()
      await terminal
    },
    async stop(ctx: Context): Promise<void> {
      requireActiveContext(ctx)
      if (status === "running") status = "stopping"
      cancelWorker?.()
      if (terminal !== null) await terminal
    },
    diagnostics(): OutboxPublisherDiagnostics {
      return Object.freeze({ status, attempts, published })
    }
  })
}
