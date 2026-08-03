import type { Context } from "@likego/context"
import type { Server } from "@likego/core"
import {
  newAcquirePickLease,
  type AcquirePickLeaseCommand,
  type PickLease,
  type PickTaskRepository
} from "./service"

type WorkerState = "idle" | "running" | "stopped"

export interface PickWorkerServer extends Server {
  /** Returns the currently owned lease, or null outside the running lifetime. */
  lease(): PickLease | null
}

interface DoneSignal {
  readonly promise: Promise<void>
  resolve(): void
}

/** Creates one native Promise signal for a worker's terminal lifecycle. */
function doneSignal(): DoneSignal {
  let resolvePromise: (() => void) | null = null
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve
  })
  return Object.freeze({
    promise,
    resolve(): void {
      resolvePromise?.()
    }
  })
}

/** Creates a structural Core Server that owns one pick-task lease while running. */
export function newPickWorkerServer(
  repository: PickTaskRepository,
  command: AcquirePickLeaseCommand,
  now: () => number = Date.now
): PickWorkerServer {
  const acquire = newAcquirePickLease(repository, now)
  const terminal = doneSignal()
  let state: WorkerState = "idle"
  let ownedLease: PickLease | null = null

  return Object.freeze({
    async start(ctx: Context): Promise<void> {
      if (state !== "idle") throw new Error("pick worker has already started")
      const lease = acquire(ctx, command)
      ownedLease = lease
      state = "running"
      await terminal.promise
    },
    async stop(ctx: Context): Promise<void> {
      if (state === "stopped") return terminal.promise
      const current = ownedLease
      if (current === null) throw new Error("pick worker lease is missing")
      try {
        repository.release(ctx, {
          taskId: current.taskId,
          workerId: current.workerId,
          fencingToken: current.fencingToken
        })
      } finally {
        ownedLease = null
        state = "stopped"
        terminal.resolve()
      }
    },
    lease(): PickLease | null {
      return ownedLease
    }
  })
}
