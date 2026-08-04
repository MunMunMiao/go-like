import type { Context } from "@go-like/context"
import type { Server } from "@go-like/core"

import {
  outputKey,
  sameTranscodeJob,
  type TranscodeJob,
  type TranscodeResult
} from "./transcode-jobs"

export type WorkerStatus = "idle" | "running" | "stopped"

export interface WorkerDiagnostics {
  readonly status: WorkerStatus
  readonly starts: number
  readonly stops: number
  readonly completedJobs: number
}

export interface TranscodeWorker extends Server {
  submit(ctx: Context, job: TranscodeJob): TranscodeResult
  diagnostics(): WorkerDiagnostics
}

/** Rejects work admitted through a terminal Context. */
function checkContext(ctx: Context): void {
  const failure = ctx.err()
  if (failure !== null) throw failure
}

/** Creates a structural transcoding worker with a one-shot owned lifecycle. */
export function newMemoryTranscodeWorker(): TranscodeWorker {
  let status: WorkerStatus = "idle"
  let starts = 0
  let stops = 0
  const results = new Map<string, TranscodeResult>()
  let resolveStop: (() => void) | null = null
  return Object.freeze({
    /** Runs one worker lifetime until stop is requested. */
    async start(ctx: Context): Promise<void> {
      checkContext(ctx)
      if (status !== "idle") throw new Error("transcode worker already started")
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
      if (status !== "running") throw new Error("transcode worker is not running")
      status = "stopped"
      stops += 1
      resolveStop?.()
    },
    /** Processes one admitted job or returns its exact idempotent result. */
    submit(ctx: Context, job: TranscodeJob): TranscodeResult {
      checkContext(ctx)
      if (status !== "running") throw new Error("transcode worker is not running")
      const existing = results.get(job.jobId)
      if (existing !== undefined) {
        if (!sameTranscodeJob(existing, job)) throw new Error("transcode job identity conflict")
        return existing
      }
      const result: TranscodeResult = Object.freeze({
        jobId: job.jobId,
        inputUrl: job.inputUrl,
        profile: job.profile,
        durationSeconds: job.durationSeconds,
        outputKey: outputKey(job),
        status: "completed"
      })
      results.set(job.jobId, result)
      return result
    },
    /** Returns a fresh immutable lifecycle and job-count snapshot. */
    diagnostics(): WorkerDiagnostics {
      return Object.freeze({ status, starts, stops, completedJobs: results.size })
    }
  })
}
