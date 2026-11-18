import { describe, expect, test } from "bun:test"

import { background, canceled } from "@go-like/core/context"
import type { Context } from "@go-like/core/context"
import { newScheduleServer, type JobQueue } from "@go-like/core/job"
import type { StoreRecord, StoreRecordInput } from "@go-like/core/store"

import { commitCheckpoint, readCheckpoint, type CheckpointStore } from "../../src/checkpoint"
import { processReport } from "../../src/processor"
import {
  latestClosedWindow,
  nextClosedWindow,
  reportWindow,
  type ReportJob
} from "../../src/report-window"
import { enqueueNextClosedWindow, submitReportJob } from "../../src/scheduler"

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

  test("an existing report is not resubmitted from a stale active-state observation", async () => {
    const report = Object.freeze({ window: reportWindow(FirstStart) })
    const queued: string[] = []
    // The job may finish its last attempt after the scheduler observes it as open.
    const submitted = await submitReportJob(
      async (_job, id) => {
        queued.push(id)
      },
      report,
      "report-final-failure",
      "open"
    )
    expect(submitted).toBe(false)
    expect(queued).toEqual([])
  })

  test("a failed report id is not enqueued again", async () => {
    const calls: string[] = []
    const report = Object.freeze({ window: reportWindow(FirstStart) })
    const first = await submitReportJob(
      async (_job, jobId) => {
        calls.push(jobId)
      },
      report,
      "report-failed",
      "failed"
    )
    const second = await submitReportJob(
      async (_job, jobId) => {
        calls.push(jobId)
      },
      report,
      "report-failed",
      "failed"
    )
    expect(first).toBe(false)
    expect(second).toBe(false)
    expect(calls).toEqual([])
    const opened = await submitReportJob(
      async (_job, jobId) => {
        calls.push(jobId)
      },
      report,
      "report-new",
      "absent"
    )
    expect(opened).toBe(true)
    expect(calls).toEqual(["report-new"])
  })
})

/** Polls until the predicate holds. */
async function until(label: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await Bun.sleep(5)
  }
}

describe("schedule and queue worker", () => {
  test("scheduled report runs do not overlap", async () => {
    let runs = 0
    let inFlight = 0
    let maxInFlight = 0
    let nextCalls = 0
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const enqueued: string[] = []
    const server = newScheduleServer(
      {
        next(afterMs: number): number {
          nextCalls += 1
          return afterMs + 15
        },
        string(): string {
          return "interval"
        }
      },
      "daily-report",
      async (ctx) => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        runs += 1
        try {
          if (runs === 1) await gate
          await enqueueNextClosedWindow(
            ctx,
            fakeStore(),
            async (_job, id) => {
              enqueued.push(id)
            },
            FirstStart,
            Date.UTC(2026, 6, 22, 1)
          )
        } finally {
          inFlight -= 1
        }
      },
      { drainTimeoutMs: 1_000 }
    )
    const running = server.start(background())
    void running.catch(() => {})
    try {
      await until("a due time during the first run", () => runs === 1 && nextCalls >= 4)
      expect(runs).toBe(1)
      expect(maxInFlight).toBe(1)
      expect(enqueued).toEqual([])
      release()
      await until("the next run after the first finishes", () => runs >= 2 && enqueued.length >= 1)
      expect(maxInFlight).toBe(1)
    } finally {
      release()
      await server.stop(background())
      await running
    }
  })

  test("the JobQueue worker processes one report job", async () => {
    const store = fakeStore()
    const report = Object.freeze({ window: reportWindow(FirstStart) })
    const processed: number[] = []
    const queue: JobQueue<ReportJob> = {
      name: "reports",
      string: () => "memory",
      async enqueue() {
        return { id: "report-20260721T000000Z" }
      },
      worker(handlers) {
        const handler = handlers["daily-report"]
        if (handler === undefined) throw new Error("daily-report handler is required")
        return {
          async start(ctx) {
            await handler(ctx, {
              queue: "reports",
              name: "daily-report",
              id: "report-20260721T000000Z",
              attempt: 1,
              payload: report
            })
          },
          async stop() {}
        }
      }
    }
    const worker = queue.worker(
      {
        async "daily-report"(ctx, job) {
          return await processReport(
            ctx,
            store,
            job.payload,
            job.attempt - 1,
            async (_queued, attempt) => {
              processed.push(attempt)
            }
          )
        }
      },
      { concurrency: 1 }
    )

    await worker.start(background())
    await worker.stop(background())

    expect(processed).toEqual([0])
    expect(await readCheckpoint(background(), store)).toBe(FirstStart)
  })
})
