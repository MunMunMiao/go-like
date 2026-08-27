import process from "node:process"

import { afterStart, name, newApp, registrar, server } from "@go-like/core"
import { signal } from "@go-like/core/node"
import { hostname, newNodeServer, port } from "@go-like/web/node"

import { newKitchenRoutingHandler } from "./http"
import { kitchenRegistryFromEnvironment } from "./registry"
import { newMemoryKitchenRoutingStore } from "./routing"
import { newRouteKitchenTicket } from "./service"

const host = process.env.HOST ?? "127.0.0.1"
const portNumber = Number(process.env.PORT ?? "3000")
if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65_535) {
  throw new TypeError("PORT must be an integer in 1..65535")
}

const origin = `http://${host}:${portNumber}`
const handler = newKitchenRoutingHandler(newRouteKitchenTicket(newMemoryKitchenRoutingStore()))
const webServer = newNodeServer(handler, hostname(host), port(portNumber))
const registry = kitchenRegistryFromEnvironment(process.env)
const registration = registry === null ? [] : [registrar(registry)]
const app = newApp(
  signal(),
  name("restaurant-kitchen-routing"),
  ...registration,
  server(webServer),
  afterStart(async function announceReady(ctx): Promise<void> {
    await webServer.endpoint(ctx)
    process.stdout.write(
      `GO_LIKE_EXAMPLE_READY=${JSON.stringify({ example: "restaurant-kitchen-routing", origin })}\n`
    )
  })
)

await app.run()
