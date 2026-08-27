import process from "node:process"

import { afterStart, name, newApp, server } from "@go-like/core"
import { signal } from "@go-like/core/node"
import type { Handler } from "@go-like/web"
import { createHealthHandler } from "@go-like/web/health"
import { hostname, newNodeServer, port } from "@go-like/web/node"

import { newRuntime } from "./service"

const host = process.env.HOST ?? "127.0.0.1"
const portNumber = Number(process.env.PORT ?? "3000")
if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65_535) {
  throw new TypeError("PORT must be an integer in 1..65535")
}

const runtime = newRuntime()
const health = createHealthHandler(runtime.probes)
/** Routes health endpoints without replacing the maintenance business handler. */
const handler: Handler = function route(request: Request): Response | Promise<Response> {
  const pathname = new URL(request.url).pathname
  return pathname === "/livez" || pathname === "/readyz"
    ? health(request)
    : runtime.handler(request)
}
const origin = `http://${host}:${portNumber}`
const webServer = newNodeServer(handler, hostname(host), port(portNumber))
const app = newApp(
  signal(),
  name("manufacturing-maintenance"),
  server(webServer),
  afterStart(async function announceReady(ctx): Promise<void> {
    await webServer.endpoint(ctx)
    process.stdout.write(
      `GO_LIKE_EXAMPLE_READY=${JSON.stringify({ example: "manufacturing-maintenance", origin })}\n`
    )
  })
)

await app.run()
