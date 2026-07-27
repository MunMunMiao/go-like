import * as core from "@likego/core"
import * as lifecycle from "@likego/core/lifecycle"

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
  throw new Error(`unexpected @likego/core exports: ${actualRootExports.join(",")}`)
}
if (JSON.stringify(Object.keys(lifecycle)) !== JSON.stringify(["waitForContext"])) {
  throw new Error(`unexpected @likego/core/lifecycle exports: ${Object.keys(lifecycle).join(",")}`)
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
const app = core.newApp(core.name("package-smoke"), core.server(subject))
const running = app.run()
await Promise.resolve()
await app.stop()
await running
if (app.name() !== "package-smoke") throw new Error("built @likego/core lifecycle smoke failed")
