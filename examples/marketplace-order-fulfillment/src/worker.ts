import type { Context } from "@likego/context"
import type { Server } from "@likego/core"

import type { FulfillmentCommand, FulfillmentOrder, FulfillmentRepository } from "./service"

export type FulfillmentWorkerStatus = "idle" | "running" | "stopped"

export interface FulfillmentWorkerDiagnostics {
  readonly status: FulfillmentWorkerStatus
  readonly appliedEvents: number
}

export interface FulfillmentWorker extends FulfillmentRepository, Server {
  diagnostics(): FulfillmentWorkerDiagnostics
}

/** Rejects work admitted through a terminal Context. */
function checkContext(ctx: Context): void {
  const failure = ctx.err()
  if (failure !== null) throw failure
}

/** Creates a structural worker whose lifecycle is owned by LikeGo Core. */
export function newFulfillmentWorker(repository: FulfillmentRepository): FulfillmentWorker {
  const controller = new AbortController()
  const terminal = new Promise<void>(function waitForStop(resolve): void {
    controller.signal.addEventListener(
      "abort",
      function stopped(): void {
        resolve()
      },
      { once: true }
    )
  })
  let status: FulfillmentWorkerStatus = "idle"
  let appliedEvents = 0

  /** Rejects commands outside the worker's running lifetime. */
  function admit(ctx: Context): void {
    checkContext(ctx)
    if (status !== "running") throw new Error("fulfillment worker is not running")
  }

  return Object.freeze({
    async start(ctx: Context): Promise<void> {
      checkContext(ctx)
      if (status !== "idle") throw new Error("fulfillment worker already started")
      status = "running"
      await terminal
    },
    async stop(ctx: Context): Promise<void> {
      checkContext(ctx)
      if (status === "stopped") return
      if (status !== "running") throw new Error("fulfillment worker is not running")
      status = "stopped"
      controller.abort()
    },
    apply(ctx: Context, command: FulfillmentCommand): FulfillmentOrder {
      admit(ctx)
      const result = repository.apply(ctx, command)
      appliedEvents += 1
      return result
    },
    get(ctx: Context, orderId: string): FulfillmentOrder | null {
      admit(ctx)
      return repository.get(ctx, orderId)
    },
    diagnostics(): FulfillmentWorkerDiagnostics {
      return Object.freeze({ status, appliedEvents })
    }
  })
}
