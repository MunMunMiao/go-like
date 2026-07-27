import process from "node:process"

import { newBullMqWorkerServer } from "@likego/bullmq"
import { background, type Context } from "@likego/context"
import { afterStart, name, newApp, server, type Server } from "@likego/core"
import { signal } from "@likego/core/node"
import { newCronerServer } from "@likego/croner"
import { newFileStore } from "@likego/store-file"
import { newNodeFileStoreHost } from "@likego/store-file/node"
import { Queue, Worker } from "bullmq"
import { Cron } from "croner"

import { processReport } from "./processor"
import { latestClosedWindow, type ReportJob } from "./report-window"
import { enqueueNextClosedWindow } from "./scheduler"
import type { ReportOutcome } from "./processor"

const redisUrl = new URL(process.env.REDIS_URL ?? "redis://127.0.0.1:46379")
const schedule = process.env.CRON_SCHEDULE ?? "*/10 * * * * *"
const checkpointDirectory = process.env.CHECKPOINT_DIR ?? ".artifacts/checkpoints"
const queueName = process.env.QUEUE_NAME ?? "likego-batch-reporting"
const prefix = process.env.QUEUE_PREFIX ?? "likego-example"
const connection = Object.freeze({
  host: redisUrl.hostname,
  port: Number(redisUrl.port || "6379"),
  username: redisUrl.username === "" ? undefined : redisUrl.username,
  password: redisUrl.password === "" ? undefined : redisUrl.password,
  maxRetriesPerRequest: null
})

if (!Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65_535) {
  throw new TypeError("REDIS_URL port must be an integer in 1..65535")
}

/** Gives Core ownership of the application-created BullMQ Queue. */
function queueServer(queue: Queue<ReportJob, ReportOutcome, string>): Server {
  let resolveDone: (() => void) | null = null
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  return Object.freeze({
    async start(ctx: Context): Promise<void> {
      const failure = ctx.err()
      if (failure !== null) throw failure
      await queue.waitUntilReady()
      await done
    },
    async stop(): Promise<void> {
      await queue.close()
      resolveDone?.()
    }
  })
}

const store = newFileStore(newNodeFileStoreHost(), checkpointDirectory)
const queue = new Queue<ReportJob, ReportOutcome, string>(queueName, { connection, prefix })
queue.on("error", (error) => {
  process.stderr.write(`batch queue error: ${error.message}\n`)
})
const worker = newBullMqWorkerServer(() => {
  const native = new Worker<ReportJob, ReportOutcome, string>(
    queueName,
    async (job, _token, signal) => {
      return await processReport(
        background(),
        store,
        job.data,
        job.attemptsMade,
        async (report) => {
          process.stdout.write(
            `LIKEGO_REPORT_PUBLISHED=${JSON.stringify({ window: report.window.id, attemptsMade: job.attemptsMade })}\n`
          )
        },
        signal
      )
    },
    { connection, prefix, autorun: false, concurrency: 1 }
  )
  native.on("error", (error) => {
    process.stderr.write(`batch worker error: ${error.message}\n`)
  })
  return native
})
let cron: Cron<Context> | null = null
const scheduler = newCronerServer<Context>((ctx) => {
  cron = new Cron<Context>(
    schedule,
    { context: ctx, catch: true, paused: true },
    async (_job, callbackCtx) => {
      const initialStartMs = latestClosedWindow(Date.now()).startMs
      await enqueueNextClosedWindow(
        callbackCtx,
        store,
        async (report, jobId) => {
          await queue.add("daily-report", report, {
            jobId,
            attempts: 3,
            backoff: { type: "fixed", delay: 250 },
            removeOnComplete: false,
            removeOnFail: false
          })
        },
        initialStartMs,
        Date.now()
      )
    }
  )
  return cron
})
const app = newApp(
  signal(),
  name("batch-reporting"),
  server(store, queueServer(queue), worker, scheduler),
  afterStart(async function announceReady(): Promise<void> {
    process.stdout.write(
      `LIKEGO_EXAMPLE_READY=${JSON.stringify({ example: "batch-reporting", worker: queueName, schedule })}\n`
    )
    await cron?.trigger()
  })
)

await app.run()
