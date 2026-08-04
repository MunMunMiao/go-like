import process from "node:process"

import { withoutCancel } from "@go-like/context"
import { afterStart, afterStop, beforeStart, name, newApp, server } from "@go-like/core"
import { signal } from "@go-like/core/node"
import { hostname, newNodeServer, port } from "@go-like/web/node"

import { newIrrigationConfig } from "./irrigation-config"
import { newIrrigationHandler } from "./http"
import { newScheduleIrrigation } from "./service"

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

const config = newIrrigationConfig({
  triggerBelowPercent: 35,
  maxReadingAgeMs: 300_000,
  maxLiters: 1_000
})
const handler = newIrrigationHandler(newScheduleIrrigation(config))
const originHost = host.includes(":") ? `[${host}]` : host
const origin = `http://${originHost}:${portNumber}`
const webServer = newNodeServer(handler, hostname(host), port(portNumber))
const app = newApp(
  signal(),
  name("smart-agriculture-irrigation"),
  beforeStart((ctx) => config.load(ctx)),
  server(webServer),
  afterStart(async function announceReady(ctx): Promise<void> {
    await webServer.endpoint(ctx)
    process.stdout.write(
      `GO_LIKE_EXAMPLE_READY=${JSON.stringify({ example: "smart-agriculture-irrigation", origin })}\n`
    )
  }),
  afterStop((ctx) => config.close(withoutCancel(ctx)))
)

await app.run()
