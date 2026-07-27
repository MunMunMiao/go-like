import { describe, expect, test } from "bun:test"

import { background, canceled } from "@likego/context"
import type { Context } from "@likego/context"
import type { StoreRecord, StoreRecordInput } from "@likego/store"

import { commitCheckpoint, readCheckpoint, type CheckpointStore } from "../../src/checkpoint"
import { processReport } from "../../src/processor"
import {
  latestClosedWindow,
  nextClosedWindow,
  reportWindow,
  type ReportJob
} from "../../src/report-window"
import { enqueueNextClosedWindow } from "../../src/scheduler"

const FirstStart = Date.UTC(2026, 6, 21)
const SecondStart = Date.UTC(2026, 6, 22)

/** Creates one deterministic in-memory checkpoint seam for business tests. */
function fakeStore(value: string | null = null): CheckpointStore {
  let current = value
  return Object.freeze({
    async read(): Promise<StoreRecord | null> {
      if (current === null) return null
      return Object.freeze({
        key: "reports/last-committed-window",
        value: new TextEncoder().encode(current),
        metadata: Object.freeze({}),
        revision: "1",
        expiresAt: null
      })
    },
    async write(_ctx: Context, record: StoreRecordInput): Promise<StoreRecord> {
      current = new TextDecoder().decode(record.value)
      return Object.freeze({
        key: record.key,
        value: new Uint8Array(record.value),
        metadata: Object.freeze({}),
        revision: "2",
        expiresAt: null
      })
    }
  })
}

describe("UTC report windows", () => {
  test("creates deterministic identities and selects only closed sequential days", () => {
    expect(reportWindow(FirstStart)).toEqual({
      startMs: FirstStart,
      endMs: SecondStart,
      id: "20260721T000000Z"
    })
    expect(latestClosedWindow(Date.UTC(2026, 6, 23, 12))).toEqual(reportWindow(SecondStart))
    expect(nextClosedWindow(null, FirstStart, Date.UTC(2026, 6, 23))).toEqual(
      reportWindow(FirstStart)
    )
    expect(nextClosedWindow(FirstStart, FirstStart, Date.UTC(2026, 6, 23))).toEqual(
      reportWindow(SecondStart)
    )
    expect(nextClosedWindow(SecondStart, FirstStart, Date.UTC(2026, 6, 23))).toBeNull()
  })

  test("rejects malformed time boundaries", () => {
    expect(() => reportWindow(-1)).toThrow(RangeError)
    expect(() => reportWindow(1)).toThrow(RangeError)
    expect(() => latestClosedWindow(Number.NaN)).toThrow(RangeError)
    expect(() => latestClosedWindow(1)).toThrow(RangeError)
  })
})

describe("checkpoint and enqueue", () => {
  test("reads null, commits canonical values, and rejects corrupt data", async () => {
    const empty = fakeStore()
    expect(await readCheckpoint(background(), empty)).toBeNull()
    await commitCheckpoint(background(), empty, reportWindow(FirstStart))
    expect(await readCheckpoint(background(), empty)).toBe(FirstStart)

    await expect(readCheckpoint(background(), fakeStore("01"))).rejects.toThrow(
      "checkpoint is invalid"
    )
    await expect(readCheckpoint(background(), fakeStore("1"))).rejects.toThrow(RangeError)
    await expect(
      commitCheckpoint(background(), empty, {
        startMs: FirstStart,
        endMs: SecondStart + 1,
        id: "wrong"
      })
    ).rejects.toThrow("window is not canonical")
  })

  test("uses one deterministic job id and stops when caught up", async () => {
    const store = fakeStore()
    const enqueued: Array<{ readonly job: ReportJob; readonly id: string }> = []
    const first = await enqueueNextClosedWindow(
      background(),
      store,
      async (job, id) => {
        enqueued.push({ job, id })
      },
      FirstStart,
      Date.UTC(2026, 6, 22, 1)
    )
    expect(first).toBe("report-20260721T000000Z")
    expect(enqueued).toEqual([
      { job: { window: reportWindow(FirstStart) }, id: "report-20260721T000000Z" }
    ])

    await commitCheckpoint(background(), store, reportWindow(FirstStart))
    expect(
      await enqueueNextClosedWindow(
        background(),
        store,
        async () => {
          throw new Error("must not enqueue")
        },
        FirstStart,
        Date.UTC(2026, 6, 22, 1)
      )
    ).toBeNull()
  })
})

describe("report processing", () => {
  test("commits after publish and skips an already committed window", async () => {
    const store = fakeStore()
    const attempts: number[] = []
    const job = Object.freeze({ window: reportWindow(FirstStart) })
    expect(
      await processReport(background(), store, job, 2, async (_job, attempt) => {
        attempts.push(attempt)
      })
    ).toBe("committed")
    expect(attempts).toEqual([2])
    expect(await readCheckpoint(background(), store)).toBe(FirstStart)
    expect(
      await processReport(background(), store, job, 3, async () => {
        throw new Error("must not republish")
      })
    ).toBe("skipped")
  })

  test("does not checkpoint a failed or canceled publish", async () => {
    const failed = fakeStore()
    await expect(
      processReport(background(), failed, { window: reportWindow(FirstStart) }, 0, async () => {
        throw new Error("publish failed")
      })
    ).rejects.toThrow("publish failed")
    expect(await readCheckpoint(background(), failed)).toBeNull()

    const controller = new AbortController()
    controller.abort(canceled)
    await expect(
      processReport(
        background(),
        failed,
        { window: reportWindow(FirstStart) },
        0,
        async () => {},
        controller.signal
      )
    ).rejects.toBe(canceled)
    expect(await readCheckpoint(background(), failed)).toBeNull()
  })

  test("validates native attempt and job boundaries", async () => {
    const store = fakeStore()
    const job = reportWindow(FirstStart)
    await expect(
      processReport(background(), store, { window: job }, -1, async () => {})
    ).rejects.toThrow(RangeError)
    await expect(
      processReport(
        background(),
        store,
        { window: { startMs: job.startMs, endMs: job.endMs, id: "wrong" } },
        0,
        async () => {}
      )
    ).rejects.toThrow("job window is not canonical")
  })
})
