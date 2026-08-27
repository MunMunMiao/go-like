import * as core from "@go-like/core"
import * as lifecycle from "@go-like/core/lifecycle"

const expectedRootExports = [
  "afterStart",
  "afterStop",
  "fromContext",
  "beforeStart",
  "beforeStop",
  "context",
  "endpoint",
  "id",
  "metadata",
  "name",
  "newApp",
  "registrar",
  "registrarTimeout",
  "server",
  "startTimeout",
  "stopTimeout",
  "version",
  "newContext"
].sort()
const actualRootExports = Object.keys(core).sort()
if (JSON.stringify(actualRootExports) !== JSON.stringify(expectedRootExports)) {
  throw new Error(`unexpected @go-like/core exports: ${actualRootExports.join(",")}`)
}
if (JSON.stringify(Object.keys(lifecycle)) !== JSON.stringify(["waitForContext"])) {
  throw new Error(`unexpected @go-like/core/lifecycle exports: ${Object.keys(lifecycle).join(",")}`)
}

let resolveDone: () => void = () => undefined
const done = new Promise<void>((resolve) => {
  resolveDone = resolve
})
const subject = {
  async start() {
    await done
  },
  async stop() {
    resolveDone()
  }
}
const app = core.newApp(core.name("package-runtime"), core.server(subject))
const running = app.run()
await Promise.resolve()
await app.stop()
await running
if (app.name() !== "package-runtime") {
  throw new Error("built @go-like/core lifecycle runtime failed")
}
