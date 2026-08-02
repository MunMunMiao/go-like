import { once } from "node:events"
import { createServer } from "node:http"
import { isAbsolute, relative } from "node:path"
import { fileURLToPath } from "node:url"

const Contracts = Object.freeze({
  vanilla: Object.freeze({ path: "/live", expectedFramework: null }),
  hono: Object.freeze({ path: "/users/99", expectedFramework: "hono" }),
  h3: Object.freeze({ path: "/status", expectedFramework: "h3" }),
  elysia: Object.freeze({ path: "/users/99", expectedFramework: "elysia" })
})

const kind = process.argv[2] ?? ""
const contract = Contracts[kind]
if (contract === undefined) throw new Error(`unknown web framework evidence target ${kind}`)
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

async function frameworkHandler(selectedKind) {
  if (selectedKind === "vanilla") {
    return (request) =>
      Response.json({ method: request.method, path: new URL(request.url).pathname })
  }
  assertStaged(selectedKind)
  assertStaged(`@likego/${selectedKind}`)
  if (selectedKind === "hono") {
    const [{ Hono }, { newHonoHandler }] = await Promise.all([
      import("hono"),
      import("@likego/hono")
    ])
    return newHonoHandler(
      new Hono().get("/users/:id", (context) =>
        context.json({ framework: "hono", id: context.req.param("id") })
      )
    )
  }
  if (selectedKind === "h3") {
    const [{ createApp, createRouter, defineEventHandler }, { newH3Handler }] = await Promise.all([
      import("h3"),
      import("@likego/h3")
    ])
    const router = createRouter().get(
      "/status",
      defineEventHandler(() => ({ framework: "h3", ok: true }))
    )
    return newH3Handler(createApp().use(router.handler))
  }
  const [{ Elysia }, { newElysiaHandler }] = await Promise.all([
    import("elysia"),
    import("@likego/elysia")
  ])
  return newElysiaHandler(
    new Elysia().get("/users/:id", ({ params }) => ({ framework: "elysia", id: params.id }))
  )
}

for (const specifier of ["@likego/context", "@likego/web/node", "@hono/node-server"]) {
  assertStaged(specifier)
}
const [{ background }, { newNodeServer }] = await Promise.all([
  import("@likego/context"),
  import("@likego/web/node")
])
const server = newNodeServer(await frameworkHandler(kind))
const running = server.start(background())
void running.catch(() => {})
let endpoint
try {
  endpoint = new URL(await server.endpoint(background()))
  const response = await fetch(new URL(contract.path, endpoint))
  verify(response.status === 200, `${kind} live listener returned ${response.status}`)
  const body = await response.json()
  verify(
    typeof body === "object" && body !== null && !Array.isArray(body),
    `${kind} live listener returned a non-object payload`
  )
  if (kind === "vanilla") {
    verify(
      body.method === "GET" && body.path === "/live",
      "vanilla Web listener changed method or path"
    )
  } else {
    verify(body.framework === contract.expectedFramework, `${kind} framework identity changed`)
  }
  if (kind === "hono" || kind === "elysia")
    verify(body.id === "99", `${kind} route parameter changed`)
  if (kind === "h3") verify(body.ok === true, "H3 status payload changed")
} finally {
  await server.stop(background())
  await running
}

const listener = createServer((_request, response) => response.end("rebound"))
listener.listen(Number(endpoint.port), "127.0.0.1")
await once(listener, "listening")
await new Promise((resolveClose, rejectClose) => {
  listener.close((error) => (error === undefined ? resolveClose() : rejectClose(error)))
})
