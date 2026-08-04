import type { Context } from "@go-like/context"
import type { Server } from "@go-like/core"

import { reviewPermit, type PermitRecord, type PermitRepository } from "./permits"

export type PermitWorkerStatus = "idle" | "running" | "stopped"

export interface PermitWorkerDiagnostics {
  readonly status: PermitWorkerStatus
  readonly reviewed: number
}

export interface PermitReviewWorker extends Server {
  readonly processNext: (ctx: Context) => PermitRecord | null
  readonly diagnostics: () => PermitWorkerDiagnostics
}

/** Rejects work admitted from an already terminal Context. */
function checkContext(ctx: Context): void {
  const failure = ctx.err()
  if (failure !== null) throw failure
}

/** Creates a lifecycle-bound worker that reviews one queued permit per explicit tick. */
export function newPermitReviewWorker(repository: PermitRepository): PermitReviewWorker {
  let status: PermitWorkerStatus = "idle"
  let reviewed = 0
  let resolveStop: (() => void) | null = null
  return Object.freeze({
    async start(ctx: Context): Promise<void> {
      if (status !== "idle") throw new Error("permit review worker already started")
      checkContext(ctx)
      const terminal = new Promise<void>(function waitForStop(resolve): void {
        resolveStop = resolve
      })
      status = "running"
      await terminal
    },
    async stop(ctx: Context): Promise<void> {
      checkContext(ctx)
      if (status === "stopped") return
      if (status !== "running") throw new Error("permit review worker is not running")
      status = "stopped"
      resolveStop?.()
    },
    processNext(ctx: Context): PermitRecord | null {
      checkContext(ctx)
      if (status !== "running") throw new Error("permit review worker is not running")
      const pending = repository.nextPending(ctx)
      if (pending === null) return null
      const completed = repository.complete(ctx, pending.applicationId, reviewPermit(pending))
      reviewed += 1
      return completed
    },
    diagnostics(): PermitWorkerDiagnostics {
      return Object.freeze({ status, reviewed })
    }
  })
}
