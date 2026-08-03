import type { Context } from "@likego/context"

import { readCheckpoint, type CheckpointStore } from "./checkpoint"
import { nextClosedWindow, type ReportJob } from "./report-window"

export type EnqueueReportJob = (job: ReportJob, jobId: string) => Promise<void>

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
