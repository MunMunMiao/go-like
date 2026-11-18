import process from "node:process"

import { newBullMqJobQueue } from "@go-like/bullmq/job"
import { afterStart, name, newApp, resources, server } from "@go-like/core"
import { background } from "@go-like/core/context"
import { newScheduleServer } from "@go-like/core/job"
import { signal } from "@go-like/core/node"
import { newCronerSchedule } from "@go-like/croner/job"
import { newFileStore } from "@go-like/file/store"
import { newNodeFileStoreHost } from "@go-like/file/store/node"
import { Queue } from "bullmq"

import { processReport, type ReportOutcome } from "./processor"
import { latestClosedWindow, type ReportJob } from "./report-window"
import { enqueueNextClosedWindow, submitReportJob } from "./scheduler"

const redisUrl = new URL(process.env.REDIS_URL ?? "redis://127.0.0.1:46379")
const schedule = process.env.CRON_SCHEDULE ?? "*/10 * * * * *"
const checkpointDirectory = process.env.CHECKPOINT_DIR ?? ".artifacts/checkpoints"
const queueName = process.env.QUEUE_NAME ?? "go-like-batch-reporting"
const prefix = process.env.QUEUE_PREFIX ?? "go-like-example"
const connection = Object.freeze({
  host: redisUrl.hostname,
  port: Number(redisUrl.port || "6379"),
  username: redisUrl.username === "" ? undefined : redisUrl.username,
  password: redisUrl.password === "" ? undefined : redisUrl.password,
  protocol: 2 as const,
  maxRetriesPerRequest: null
})

if (!Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65_535) {
  throw new TypeError("REDIS_URL port must be an integer in 1..65535")
}

const store = newFileStore(newNodeFileStoreHost(), checkpointDirectory)
const queue = new Queue<ReportJob, ReportOutcome, string>(queueName, { connection, prefix })
queue.on("error", (error) => {
  process.stderr.write(`batch queue error: ${error.message}\n`)
})
const jobs = newBullMqJobQueue(queue)
const worker = jobs.worker(
  {
    async "daily-report"(ctx, job) {
      return await processReport(ctx, store, job.payload, job.attempt - 1, async (report) => {
        process.stdout.write(
          `GO_LIKE_REPORT_PUBLISHED=${JSON.stringify({ window: report.window.id, attemptsMade: job.attempt - 1 })}\n`
        )
      })
    }
  },
  { concurrency: 1 }
)
const scheduler = newScheduleServer(newCronerSchedule(schedule), "daily-report", async (ctx) => {
  const initialStartMs = latestClosedWindow(Date.now()).startMs
  await enqueueNextClosedWindow(
    ctx,
    store,
    async (report, jobId) => {
      const existing = await queue.getJob(jobId)
      const nativeState =
        existing === undefined
          ? "absent"
          : (await existing.getState()) === "failed"
            ? "failed"
            : "open"
      await submitReportJob(
        async (body, id) => {
          await jobs.enqueue(ctx, "daily-report", body, {
            id,
            attempts: 3,
            backoff: { type: "fixed", delayMs: 250 }
          })
        },
        report,
        jobId,
        nativeState
      )
    },
    initialStartMs,
    Date.now()
  )
})
const app = newApp(
  signal(),
  name("batch-reporting"),
  resources(store, jobs),
  server(worker, scheduler),
  afterStart(async function announceReady(): Promise<void> {
    process.stdout.write(
      `GO_LIKE_EXAMPLE_READY=${JSON.stringify({ example: "batch-reporting", worker: queueName, schedule })}\n`
    )
    await scheduler.trigger(background())
  })
)

await app.run()
