import type { JobQueue } from "@go-like/core/job"
import type { Server } from "@go-like/core/lifecycle"
import type { Queue } from "bullmq"

import {
  newBullMqJobQueue,
  type BullMqJobQueue,
  type BullMqUnexpectedExitError,
  type BullMqWorkerOptions
} from "../src/job/index"

const queue = null as unknown as Queue<unknown, unknown, string, unknown, unknown, string>
const jobs: BullMqJobQueue<unknown> = newBullMqJobQueue(queue)
const worker: Server = jobs.worker({ work() {} })
const socket: JobQueue<unknown> = jobs
const options: BullMqWorkerOptions = { lockDuration: 1_000 }
const configured: BullMqJobQueue<unknown> = newBullMqJobQueue(queue, { worker: options })
const failure = null as BullMqUnexpectedExitError | null

void [worker, socket.string(), configured.name, failure?.code, failure?.queueName, jobs.string()]

// @ts-expect-error telemetry is owned by go-like
newBullMqJobQueue(queue, { telemetry: {} })

// @ts-expect-error connection comes from the adopted Queue
newBullMqJobQueue(queue, { worker: { connection: {} } })
