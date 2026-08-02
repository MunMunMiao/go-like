import { isAbsolute, relative } from "node:path"
import { fileURLToPath } from "node:url"

const stage = process.env.LIKEGO_E2E_FRAMEWORK_STAGE
if (typeof stage !== "string" || stage.length === 0) throw new Error("framework stage is missing")

function verify(condition, message) {
  if (!condition) throw new Error(message)
}

function assertStaged(specifier) {
  const resolved = fileURLToPath(import.meta.resolve(specifier))
  const child = relative(stage, resolved)
  verify(
    child.length > 0 &&
      child !== ".." &&
      !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
      !isAbsolute(child),
    `${specifier} resolved outside the framework stage`
  )
}

assertStaged("@likego/h3")
assertStaged("h3")
const bridge = await import("@likego/h3")
const { createApp, createRouter, defineEventHandler } = await import("h3")
verify(
  JSON.stringify(Object.keys(bridge).sort()) === JSON.stringify(["newH3Handler"]),
  "@likego/h3 exports changed"
)

const path = "/__likego_h3_bridge"
const router = createRouter().get(
  path,
  defineEventHandler(() => ({ bridge: "@likego/h3", framework: "h3" }))
)
const app = createApp().use(router.handler)
const handler = bridge.newH3Handler(app)
verify(typeof handler === "function", "@likego/h3 bridge did not return a handler")
const response = await handler(new Request(`http://likego.invalid${path}`))
verify(response instanceof Response, "@likego/h3 bridge did not return a Response")
verify(response.status === 200, `@likego/h3 bridge returned ${response.status}`)
verify(
  JSON.stringify(await response.json()) ===
    JSON.stringify({ bridge: "@likego/h3", framework: "h3" }),
  "@likego/h3 bridge payload changed"
)
