import { Worker } from "bullmq"

const [host, portText, queueName, prefix] = process.argv.slice(2)
if (
  host === undefined ||
  portText === undefined ||
  queueName === undefined ||
  prefix === undefined
) {
  throw new Error("stalled child requires host, port, queue name, and prefix")
}
const port = Number(portText)
const worker = new Worker(
  queueName,
  async (job) => {
    console.log(`BULLMQ_STALLED_LOCKED=${job.id}`)
    setTimeout(() => {
      process.exit(17)
    }, 25)
    await new Promise<never>(() => {})
  },
  {
    connection: {
      host,
      port,
      maxRetriesPerRequest: null,
      retryStrategy: (attempt) => Math.min(attempt * 25, 250)
    },
    prefix,
    lockDuration: 500,
    stalledInterval: 5_000
  }
)
worker.on("error", (error) => {
  console.error(error.message)
})
await worker.waitUntilReady()
