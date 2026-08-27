import process from "node:process"

import { afterStart, name, newApp, server } from "@go-like/core"
import { signal } from "@go-like/core/node"
import { hostname, newNodeServer, port } from "@go-like/web/node"

import { newHandler } from "./app"

const host = process.env.HOST ?? "127.0.0.1"
const portNumber = Number(process.env.PORT ?? "3000")
if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65_535) {
  throw new TypeError("PORT must be an integer in 1..65535")
}

const origin = `http://${host}:${portNumber}`
const httpServer = newNodeServer(newHandler(), hostname(host), port(portNumber))
const app = newApp(
  signal(),
  name("h3"),
  server(httpServer),
  afterStart(async function announceReady(ctx): Promise<void> {
    await httpServer.endpoint(ctx)
    process.stdout.write(`GO_LIKE_EXAMPLE_READY=${JSON.stringify({ example: "h3", origin })}\n`)
  })
)

await app.run()
