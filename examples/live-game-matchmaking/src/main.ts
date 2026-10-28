import process from "node:process"

import { afterStart, name, newApp, registrar, server } from "@go-like/core"
import { signal } from "@go-like/core/node"
import type { ServiceInstance } from "@go-like/registry"
import { hostname, newNodeServer, port } from "@go-like/web/node"

import { newHandler } from "./http"
import { gameRegistryFromEnvironment } from "./registry"

const host = process.env.HOST ?? "127.0.0.1"
const portNumber = Number(process.env.PORT ?? "3000")
if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65_535) {
  throw new TypeError("PORT must be an integer in 1..65535")
}

const gameServers: readonly ServiceInstance[] = Object.freeze([
  Object.freeze({
    id: "eu-west-a",
    name: "game-session",
    version: "v1",
    endpoints: Object.freeze(["https://game-eu-west-a.internal/"]),
    metadata: Object.freeze({ region: "eu-west" })
  }),
  Object.freeze({
    id: "eu-west-b",
    name: "game-session",
    version: "v1",
    endpoints: Object.freeze(["https://game-eu-west-b.internal/"]),
    metadata: Object.freeze({ region: "eu-west" })
  })
])
const origin = `http://${host}:${portNumber}`
const httpServer = newNodeServer(newHandler(gameServers, 100), hostname(host), port(portNumber))
const registry = gameRegistryFromEnvironment(process.env)
const registration = registry === null ? [] : [registrar(registry)]
const app = newApp(
  signal(),
  name("live-game-matchmaking"),
  ...registration,
  server(httpServer),
  afterStart(async function announceReady(ctx): Promise<void> {
    await httpServer.endpoint(ctx)
    process.stdout.write(
      `GO_LIKE_EXAMPLE_READY=${JSON.stringify({ example: "live-game-matchmaking", origin })}\n`
    )
  })
)

await app.run()
