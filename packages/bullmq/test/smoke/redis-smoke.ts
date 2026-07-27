import { background } from "@likego/context"
import { Queue, Worker } from "bullmq"

import { newBullMqWorkerServer } from "@likego/bullmq"

const host = process.env.REDIS_HOST ?? "127.0.0.1"
const port = Number(process.env.REDIS_PORT ?? "6379")
const queueName = `node-smoke-${crypto.randomUUID()}`
const prefix = `node-smoke-${crypto.randomUUID()}`
const connection = {
  host,
  port,
  maxRetriesPerRequest: null,
  retryStrategy: (attempt: number) => Math.min(attempt * 25, 250)
}
const queue = new Queue(queueName, { connection, prefix })
queue.on("error", () => {})
try {
  const received: string[] = []
  const native = new Worker(
    queueName,
    async (job, token, signal) => {
      signal?.throwIfAborted()
      if (typeof token !== "string" || token.length === 0)
        throw new Error("BullMQ native token is empty")
      received.push(job.id ?? "")
      return "ok"
    },
    { connection, prefix, autorun: false }
  )
  native.on("error", () => {})
  const subject = newBullMqWorkerServer(native)
  const running = subject.start(background())
  void running.catch(() => {})
  const job = await queue.add("smoke", { native: true }, { jobId: "node-runtime" })
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if ((await job.getState()) === "completed") break
    await new Promise((resolve) => {
      setTimeout(resolve, 25)
    })
  }
  if ((await job.getState()) !== "completed") throw new Error("Node smoke job did not complete")
  if (received[0] !== "node-runtime") throw new Error("Node smoke did not receive the raw Job")
  await subject.stop(background())
  await running
  const afterStop = await queue.add(
    "after-stop",
    { owned: "application" },
    { jobId: "queue-still-open" }
  )
  if ((await queue.getJob(afterStop.id ?? ""))?.data.owned !== "application") {
    throw new Error("adapter closed the application Queue")
  }
  await queue.obliterate({ force: true })
  console.log("bullmq-redis-smoke ok bullmq=5.81.2")
} finally {
  await queue.close()
}
