import process from "node:process"

import { afterStart, name, newApp, server } from "@likego/core"
import { signal } from "@likego/core/node"
import { hostname, newNodeServer, port } from "@likego/web/node"

import { newReservationHandler } from "./http"
import { newRetailInventoryService } from "./service"

const host = process.env.HOST ?? "127.0.0.1"
const portNumber = Number(process.env.PORT ?? "3000")
if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65_535) {
  throw new TypeError("PORT must be an integer in 1..65535")
}

const service = newRetailInventoryService({ mug: 100 })
const origin = `http://${host}:${portNumber}`
const webServer = newNodeServer(
  newReservationHandler(service.reserve, service.available),
  hostname(host),
  port(portNumber)
)
const app = newApp(
  signal(),
  name("retail-inventory-reservation"),
  server(webServer),
  afterStart(async function announceReady(ctx): Promise<void> {
    await webServer.endpoint(ctx)
    process.stdout.write(
      `LIKEGO_EXAMPLE_READY=${JSON.stringify({ example: "retail-inventory-reservation", origin })}\n`
    )
  })
)

await app.run()
