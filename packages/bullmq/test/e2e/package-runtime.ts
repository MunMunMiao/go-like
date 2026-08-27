import * as api from "@go-like/bullmq"

const exports = Object.keys(api).sort()
const expected = ["bullMqWorkerShutdownTimeout", "newBullMqWorkerServer"]
if (JSON.stringify(exports) !== JSON.stringify(expected)) {
  throw new Error(`unexpected bullmq exports: ${exports.join(",")}`)
}
console.log("bullmq-package-runtime ok bullmq=6.0.6")
