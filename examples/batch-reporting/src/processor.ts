import type { Context } from "@likego/context"

import { commitCheckpoint, readCheckpoint, type CheckpointStore } from "./checkpoint"
import { reportWindow, type ReportJob } from "./report-window"

export type PublishReport = (
  job: ReportJob,
  attemptsMade: number,
  signal: AbortSignal | undefined
) => Promise<void>

export type ReportOutcome = "committed" | "skipped"

/** Publishes one report and advances its checkpoint only after durable success. */
export async function processReport(
  ctx: Context,
  store: CheckpointStore,
  job: ReportJob,
  attemptsMade: number,
  publish: PublishReport,
  signal?: AbortSignal
): Promise<ReportOutcome> {
  if (!Number.isSafeInteger(attemptsMade) || attemptsMade < 0) {
    throw new RangeError("attemptsMade must be a non-negative safe integer")
  }
  const window = reportWindow(job.window.startMs)
  if (window.endMs !== job.window.endMs || window.id !== job.window.id) {
    throw new Error("report job window is not canonical")
  }
  signal?.throwIfAborted()
  const checkpoint = await readCheckpoint(ctx, store)
  if (checkpoint !== null && checkpoint >= window.startMs) return "skipped"
  await publish(Object.freeze({ window }), attemptsMade, signal)
  signal?.throwIfAborted()
  await commitCheckpoint(ctx, store, window)
  return "committed"
}
