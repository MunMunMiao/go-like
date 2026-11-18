import type { Context } from "@go-like/core/context"

import { readCheckpoint, type CheckpointStore } from "./checkpoint"
import { nextClosedWindow, type ReportJob } from "./report-window"

export type EnqueueReportJob = (job: ReportJob, jobId: string) => Promise<void>

/** Native state of one report id. `failed` means its finite attempts are exhausted. */
export type ReportJobState = "absent" | "failed" | "open"

/**
 * Enqueues only absent report ids. An observed job may finish before this call,
 * so both open and failed ids must retain their existing finite attempt budget.
 */
export async function submitReportJob(
  enqueue: EnqueueReportJob,
  report: ReportJob,
  jobId: string,
  state: ReportJobState
): Promise<boolean> {
  if (state !== "absent") return false
  await enqueue(report, jobId)
  return true
}

/** Enqueues only the next missing window under one deterministic BullMQ identity. */
export async function enqueueNextClosedWindow(
  ctx: Context,
  store: CheckpointStore,
  enqueue: EnqueueReportJob,
  initialStartMs: number,
  nowMs: number
): Promise<string | null> {
  const window = nextClosedWindow(await readCheckpoint(ctx, store), initialStartMs, nowMs)
  if (window === null) return null
  const jobId = `report-${window.id}`
  await enqueue(Object.freeze({ window }), jobId)
  return jobId
}
