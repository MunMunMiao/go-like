import process from "node:process"

import { afterStart, name, newApp, server } from "@go-like/core"
import { signal } from "@go-like/core/node"
import { hostname, newNodeServer, port } from "@go-like/web/node"

import { newFraudRiskMicroservice } from "./cache"
import { newFraudRiskHandler } from "./http"

const host = process.env.HOST ?? "127.0.0.1"
const portText = process.env.PORT ?? "3000"
if (host === "" || host.trim() !== host || /[/?#@\s]/u.test(host)) {
  throw new TypeError("HOST must be a non-empty hostname or IP address")
}
if (!/^[1-9]\d{0,4}$/u.test(portText)) {
  throw new TypeError("PORT must be a decimal integer in 1..65535")
}
const portNumber = Number(portText)
if (portNumber > 65_535) throw new TypeError("PORT must be a decimal integer in 1..65535")

const service = newFraudRiskMicroservice({
  "account-1": Object.freeze({ transactionsLastFiveMinutes: 4, declinedLastHour: 1 })
})
const handler = newFraudRiskHandler(service.assess)
const originHost = host.includes(":") ? `[${host}]` : host
const origin = `http://${originHost}:${portNumber}`
const httpServer = newNodeServer(handler, hostname(host), port(portNumber))
const app = newApp(
  signal(),
  name("fraud-risk-scoring"),
  server(httpServer),
  afterStart(async function announceReady(ctx): Promise<void> {
    await httpServer.endpoint(ctx)
    process.stdout.write(
      `GO_LIKE_EXAMPLE_READY=${JSON.stringify({ example: "fraud-risk-scoring", origin })}\n`
    )
  })
)

await app.run()
