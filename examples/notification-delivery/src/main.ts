import process from "node:process"

import { afterStart, name, newApp, server, telemetry } from "@go-like/core"
import { newTelemetry } from "@go-like/core/telemetry"
import { signal } from "@go-like/core/node"
import { hostname, newNodeServer, port } from "@go-like/core/web/node"
import { newWinstonHandler } from "@go-like/winston/log"
import winston from "winston"

import { newNotificationEvents } from "./events"
import { newNotificationHandler } from "./http"
import { newMemoryNotificationProvider } from "./provider"
import { newDeliverNotification } from "./service"

const host = process.env.HOST ?? "127.0.0.1"
const portNumber = Number(process.env.PORT ?? "3000")
if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65_535) {
  throw new TypeError("PORT must be an integer in 1..65535")
}

const origin = `http://${host}:${portNumber}`
const events = newNotificationEvents()
const deliver = newDeliverNotification(newMemoryNotificationProvider())
const logger = winston.createLogger({
  level: "info",
  format: winston.format.json(),
  transports: [new winston.transports.Console()]
})
const handler = newNotificationHandler(async function deliverAndPublish(ctx, command) {
  const receipt = await deliver(ctx, command)
  await events.publish(ctx, receipt)
  return receipt
})
const webServer = newNodeServer(handler, hostname(host), port(portNumber))
const app = newApp(
  signal(),
  name("notification-delivery"),
  telemetry(newTelemetry({ logHandlers: [newWinstonHandler(logger)], completionLogs: "all" })),
  server(events.server, webServer),
  afterStart(async function announceReady(ctx): Promise<void> {
    await webServer.endpoint(ctx)
    process.stdout.write(
      `GO_LIKE_EXAMPLE_READY=${JSON.stringify({ example: "notification-delivery", origin })}\n`
    )
  })
)

await app.run()
