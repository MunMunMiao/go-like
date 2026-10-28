import process from "node:process"

import { afterStart, name, newApp, server } from "@go-like/core"
import { signal } from "@go-like/core/node"
import { hostname, newNodeServer, port } from "@go-like/web/node"

import { newAppointmentHandler } from "./http"
import { newBookAppointment, newCancelAppointment, newMemoryAppointmentRepository } from "./service"
import { newAppointmentPolicyService, newValidatedBookAppointment } from "./transport"

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

const repository = newMemoryAppointmentRepository()
const policy = newAppointmentPolicyService()
const handler = newAppointmentHandler(
  newValidatedBookAppointment(newBookAppointment(repository), policy.validate),
  newCancelAppointment(repository)
)
const originHost = host.includes(":") ? `[${host}]` : host
const origin = `http://${originHost}:${portNumber}`
const httpServer = newNodeServer(handler, hostname(host), port(portNumber))
const app = newApp(
  signal(),
  name("healthcare-appointments"),
  server(policy.server, httpServer),
  afterStart(async function announceReady(ctx): Promise<void> {
    await httpServer.endpoint(ctx)
    process.stdout.write(
      `GO_LIKE_EXAMPLE_READY=${JSON.stringify({ example: "healthcare-appointments", origin })}\n`
    )
  })
)

await app.run()
