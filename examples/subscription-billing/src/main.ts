import process from "node:process"

import { withoutCancel } from "@go-like/context"
import { afterStart, afterStop, beforeStart, name, newApp, server } from "@go-like/core"
import { signal } from "@go-like/core/node"
import { hostname, newNodeServer, port } from "@go-like/web/node"

import { newSubscriptionBillingService } from "./config"
import { newSubscriptionBillingHandler } from "./http"

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

const service = newSubscriptionBillingService({
  maximumAdjustmentCents: 1_000_000
})
const originHost = host.includes(":") ? `[${host}]` : host
const origin = `http://${originHost}:${portNumber}`
const webServer = newNodeServer(
  newSubscriptionBillingHandler(service.change),
  hostname(host),
  port(portNumber)
)
const app = newApp(
  signal(),
  name("subscription-billing"),
  beforeStart((ctx) => service.config.load(ctx)),
  server(webServer),
  afterStart(async function announceReady(ctx): Promise<void> {
    await webServer.endpoint(ctx)
    process.stdout.write(
      `GO_LIKE_EXAMPLE_READY=${JSON.stringify({ example: "subscription-billing", origin })}\n`
    )
  }),
  afterStop((ctx) => service.config.close(withoutCancel(ctx)))
)

await app.run()
