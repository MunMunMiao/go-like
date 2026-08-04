import { once } from "node:events"
import { createServer } from "node:http"
import { isAbsolute, relative } from "node:path"
import { fileURLToPath } from "node:url"

const stage = process.env.GO_LIKE_E2E_FRAMEWORK_STAGE
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

for (const specifier of [
  "@go-like/context",
  "@go-like/web",
  "@go-like/web/node",
  "@hono/node-server"
]) {
  assertStaged(specifier)
}

const context = await import("@go-like/context")
const web = await import("@go-like/web")
const webNode = await import("@go-like/web/node")
verify(
  JSON.stringify(Object.keys(web).sort()) === JSON.stringify(["contextHandler"]),
  "@go-like/web exports changed"
)
verify(
  JSON.stringify(Object.keys(webNode).sort()) ===
    JSON.stringify(["hostname", "newNodeServer", "nodeShutdownTimeout", "port"]),
  "@go-like/web/node exports changed"
)

const path = "/__go-like_web_bridge"
const handler = web.contextHandler((_ctx, request) => {
  const url = new URL(request.url)
  if (request.method !== "GET" || url.pathname !== path)
    return new Response("not found", { status: 404 })
  return Response.json({ bridge: "@go-like/web", method: request.method, path: url.pathname })
})
verify(handler.length === 1, "@go-like/web bridge changed its standard Web ABI")

const server = webNode.newNodeServer(handler, webNode.hostname("127.0.0.1"), webNode.port(0))
const running = server.start(context.background())
void running.catch(() => {})
let endpoint
try {
  endpoint = new URL(await server.endpoint(context.background()))
  const response = await fetch(new URL(path, endpoint))
  verify(response.status === 200, `@go-like/web bridge returned ${response.status}`)
  verify(
    response.headers.get("content-type")?.startsWith("application/json") === true,
    "@go-like/web bridge did not return JSON"
  )
  verify(
    JSON.stringify(await response.json()) ===
      JSON.stringify({ bridge: "@go-like/web", method: "GET", path }),
    "@go-like/web bridge payload changed"
  )
} finally {
  await server.stop(context.background())
  await running
}

const rebound = createServer((_request, response) => response.end("released"))
rebound.listen(Number(endpoint.port), "127.0.0.1")
await once(rebound, "listening")
await new Promise((resolveClose, rejectClose) => {
  rebound.close((error) => (error === undefined ? resolveClose() : rejectClose(error)))
})
