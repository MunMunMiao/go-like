import process from "node:process"

import { afterStart, name, newApp, server } from "@likego/core"
import { signal } from "@likego/core/node"
import { hostname, newNodeServer, port } from "@likego/web/node"

import { newSecuritiesMarketDataHTTP } from "./http"
import { newSecuritiesMarketDataService } from "./service"

const host = process.env.HOST ?? "127.0.0.1"
const portNumber = Number(process.env.PORT ?? "3000")
if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65_535) {
  throw new TypeError("PORT must be an integer in 1..65535")
}

const service = newSecuritiesMarketDataService(5, "LIKE")
const origin = `http://${host}:${portNumber}`
const webServer = newNodeServer(
  newSecuritiesMarketDataHTTP(service),
  hostname(host),
  port(portNumber)
)
const app = newApp(
  signal(),
  name("securities-market-data"),
  server(webServer),
  afterStart(async function announceReady(ctx): Promise<void> {
    await webServer.endpoint(ctx)
    process.stdout.write(
      `LIKEGO_EXAMPLE_READY=${JSON.stringify({ example: "securities-market-data", origin })}\n`
    )
  })
)

await app.run()
