import assert from "node:assert/strict"

import { newBullMqJobQueue } from "@go-like/bullmq/job"

assert.equal(typeof newBullMqJobQueue, "function")
assert.deepEqual(Object.keys(await import("@go-like/bullmq/job")), ["newBullMqJobQueue"])
console.log("bullmq-package-runtime ok")
