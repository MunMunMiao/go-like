import process from "node:process"

import { afterStart, name, newApp, server } from "@likego/core"
import { signal } from "@likego/core/node"
import { hostname, newNodeServer, port } from "@likego/web/node"

import { newBankTransferHandler } from "./http"
import { newBankTransferMicroservice } from "./transport"

const host = process.env.HOST ?? "127.0.0.1"
const portNumber = Number(process.env.PORT ?? "3000")
if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65_535) {
  throw new TypeError("PORT must be an integer in 1..65535")
}

const service = newBankTransferMicroservice(["DE", "ES", "FR", "IT", "NL"])
const origin = `http://${host}:${portNumber}`
const httpServer = newNodeServer(
  newBankTransferHandler(service.client.quote),
  hostname(host),
  port(portNumber)
)
const app = newApp(
  signal(),
  name("bank-transfer-gateway"),
  server(service.server, httpServer),
  afterStart(async function announceReady(ctx): Promise<void> {
    await httpServer.endpoint(ctx)
    process.stdout.write(
      `LIKEGO_EXAMPLE_READY=${JSON.stringify({ example: "bank-transfer-gateway", origin })}\n`
    )
  })
)

await app.run()
