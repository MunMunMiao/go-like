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

assertStaged("@likego/elysia")
assertStaged("elysia")
const bridge = await import("@likego/elysia")
const { Elysia } = await import("elysia")
verify(
  JSON.stringify(Object.keys(bridge).sort()) === JSON.stringify(["newElysiaHandler"]),
  "@likego/elysia exports changed"
)

const path = "/__likego_elysia_bridge"
const app = new Elysia().get(path, () => ({ bridge: "@likego/elysia", framework: "elysia" }))
const handler = bridge.newElysiaHandler(app)
verify(handler.length === 1, "@likego/elysia bridge changed its standard Web ABI")
const response = await handler(new Request(`http://likego.invalid${path}`))
verify(response instanceof Response, "@likego/elysia bridge did not return a Response")
verify(response.status === 200, `@likego/elysia bridge returned ${response.status}`)
verify(
  JSON.stringify(await response.json()) ===
    JSON.stringify({ bridge: "@likego/elysia", framework: "elysia" }),
  "@likego/elysia bridge payload changed"
)
