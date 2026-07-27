import process from "node:process"

import { newApp, server } from "../../../src/index"
import { signal } from "../../../src/node"

const selected = process.argv[2]
if (selected !== "SIGINT" && selected !== "SIGQUIT" && selected !== "SIGTERM") {
  throw new Error("invalid signal")
}
const beforeInterrupt = process.listenerCount("SIGINT")
const beforeQuit = process.listenerCount("SIGQUIT")
const beforeTerminate = process.listenerCount("SIGTERM")
let stops = 0
let resolveDone: () => void = () => {}
const done = new Promise<void>((resolve) => {
  resolveDone = resolve
})
const keepalive = setTimeout(() => {}, 2_000)
const app = newApp(
  signal(),
  server({
    async start() {
      setTimeout(() => process.kill(process.pid, selected), 50)
      await done
    },
    async stop() {
      stops += 1
      resolveDone()
    }
  })
)
await app.run()
clearTimeout(keepalive)
process.stdout.write(
  `${JSON.stringify({
    stops,
    interruptListenerDelta: process.listenerCount("SIGINT") - beforeInterrupt,
    quitListenerDelta: process.listenerCount("SIGQUIT") - beforeQuit,
    terminateListenerDelta: process.listenerCount("SIGTERM") - beforeTerminate
  })}\n`
)
