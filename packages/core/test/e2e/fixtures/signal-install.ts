import process from "node:process"

import { newApp } from "../../../src/index"
import { signal } from "../../../src/node"

const before = process.listenerCount("SIGUSR2")
let rejected = false
try {
  await newApp(signal("SIGUSR2", "SIGKILL")).run()
} catch {
  rejected = true
}
process.stdout.write(
  JSON.stringify({
    rejected,
    listenerDelta: process.listenerCount("SIGUSR2") - before
  })
)
