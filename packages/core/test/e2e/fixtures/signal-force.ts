import process from "node:process"

import { newApp, server } from "../../../src/index"
import { signal } from "../../../src/node"

const blocked = Promise.withResolvers<void>()
const app = newApp(
  signal("SIGTERM"),
  server({
    async start() {
      process.stdout.write("ready\n")
      await blocked.promise
    },
    async stop() {
      process.stdout.write("stopping\n")
      await blocked.promise
    }
  })
)
void app.run().catch(() => {})
setInterval(() => {}, 1_000)
