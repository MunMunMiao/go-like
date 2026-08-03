import type { Context } from "@likego/context"
import type { Server } from "@likego/core"

export type ClaimsWorkerStatus = "idle" | "running" | "stopped"

export interface ClaimsWorkerDiagnostics {
  readonly status: ClaimsWorkerStatus
  readonly starts: number
  readonly stops: number
}

export interface ClaimsWorker {
  readonly server: Server
  readonly diagnostics: () => ClaimsWorkerDiagnostics
}

function checkContext(ctx: Context): void {
  const failure = ctx.err()
  if (failure !== null) throw failure
}

/** Creates a structural background claims-review Server with an observable one-shot lifetime. */
export function newClaimsReviewWorker(): ClaimsWorker {
  let status: ClaimsWorkerStatus = "idle"
  let starts = 0
  let stops = 0
  let resolveStop: (() => void) | null = null
  const worker: Server = Object.freeze({
    async start(ctx: Context): Promise<void> {
      if (status !== "idle") throw new Error("claims review worker already started")
      checkContext(ctx)
      const terminal = new Promise<void>(function waitForStop(resolve): void {
        resolveStop = resolve
      })
      status = "running"
      starts += 1
      await terminal
    },
    async stop(ctx: Context): Promise<void> {
      checkContext(ctx)
      if (status === "stopped") return
      if (status !== "running") throw new Error("claims review worker is not running")
      status = "stopped"
      stops += 1
      resolveStop?.()
    }
  })
  return Object.freeze({
    server: worker,
    diagnostics(): ClaimsWorkerDiagnostics {
      return Object.freeze({ status, starts, stops })
    }
  })
}
