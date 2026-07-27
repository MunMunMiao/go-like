import * as api from "@likego/bullmq"

const exports = Object.keys(api).sort()
const expected = ["bullMqWorkerShutdownTimeout", "newBullMqWorkerServer"]
if (JSON.stringify(exports) !== JSON.stringify(expected)) {
  throw new Error(`unexpected bullmq exports: ${exports.join(",")}`)
}
console.log("bullmq-package-smoke ok bullmq=5.81.2")
