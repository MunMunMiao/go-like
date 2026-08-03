import { background } from "@likego/context"
import type { Server } from "@likego/core"
import { Worker, type Processor } from "bullmq"

import {
  bullMqWorkerShutdownTimeout,
  newBullMqWorkerServer,
  type BullMqWorkerFactory
} from "../src/index"

interface MailJobData {
  readonly recipient: string
}

interface MailResult {
  readonly accepted: boolean
}

const processor: Processor<MailJobData, MailResult, "send"> = async (job, token, signal) => {
  signal?.throwIfAborted()
  return { accepted: job.data.recipient.length > 0 && (token?.length ?? 0) > 0 }
}
const worker = new Worker<MailJobData, MailResult, "send">("typed-mail", processor, {
  connection: { host: "127.0.0.1", port: 6379 },
  prefix: "typed",
  autorun: false,
  concurrency: 2,
  limiter: { max: 10, duration: 1_000 },
  removeOnComplete: { count: 100 },
  skipVersionCheck: true,
  settings: { backoffStrategy: () => 10 }
})
worker.on("error", (error) => {
  error.message
})

const direct: Server = newBullMqWorkerServer(worker, bullMqWorkerShutdownTimeout(25_000))
const factory: BullMqWorkerFactory<MailJobData, MailResult, "send"> = () =>
  new Worker("typed-mail-lazy", processor, {
    connection: { host: "127.0.0.1", port: 6379 },
    autorun: false
  })
const lazy: Server = newBullMqWorkerServer(factory)
void direct.start(background())
void lazy.start(background())
