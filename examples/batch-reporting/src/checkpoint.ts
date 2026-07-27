import type { Context } from "@likego/context"
import type { StoreRecord, StoreRecordInput } from "@likego/store"

import { reportWindow, type ReportWindow } from "./report-window"

const CheckpointKey = "reports/last-committed-window"
const Encoder = new TextEncoder()
const Decoder = new TextDecoder("utf-8", { fatal: true })

export interface CheckpointStore {
  read(ctx: Context, key: string): Promise<StoreRecord | null>
  write(ctx: Context, record: StoreRecordInput): Promise<StoreRecord>
}

/** Reads and validates the single-owner durable checkpoint. */
export async function readCheckpoint(ctx: Context, store: CheckpointStore): Promise<number | null> {
  const record = await store.read(ctx, CheckpointKey)
  if (record === null) return null
  const text = Decoder.decode(record.value)
  const value = Number(text)
  if (!Number.isSafeInteger(value) || value < 0 || String(value) !== text) {
    throw new Error("report checkpoint is invalid")
  }
  reportWindow(value)
  return value
}

/** Commits one completed window after its report output is durable. */
export async function commitCheckpoint(
  ctx: Context,
  store: CheckpointStore,
  window: ReportWindow
): Promise<void> {
  const canonical = reportWindow(window.startMs)
  if (canonical.endMs !== window.endMs || canonical.id !== window.id) {
    throw new Error("report window is not canonical")
  }
  await store.write(ctx, {
    key: CheckpointKey,
    value: Encoder.encode(String(window.startMs))
  })
}
