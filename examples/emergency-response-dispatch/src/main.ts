import process from "node:process"

import { afterStart, name, newApp, server } from "@likego/core"
import { signal } from "@likego/core/node"
import type { ServiceInstance } from "@likego/registry"
import { hostname, newNodeServer, port } from "@likego/web/node"

import { newEmergencyResponseService } from "./http"

const host = process.env.HOST ?? "127.0.0.1"
const portNumber = Number(process.env.PORT ?? "3000")
if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65_535) {
  throw new TypeError("PORT must be an integer in 1..65535")
}

const responders: readonly ServiceInstance[] = Object.freeze([
  Object.freeze({
    id: "medical-north-demo",
    name: "emergency-responder",
    version: "v1",
    endpoints: Object.freeze(["https://medical-north.example.test/dispatch"]),
    metadata: Object.freeze({
      zone: "north",
      service: "medical",
      readiness: "ready"
    })
  })
])
const service = newEmergencyResponseService(responders)
const origin = `http://${host}:${portNumber}`
const httpServer = newNodeServer(service.handler, hostname(host), port(portNumber))
const app = newApp(
  signal(),
  name("emergency-response-dispatch"),
  server(httpServer),
  afterStart(async function announceReady(ctx): Promise<void> {
    await httpServer.endpoint(ctx)
    process.stdout.write(
      `LIKEGO_EXAMPLE_READY=${JSON.stringify({ example: "emergency-response-dispatch", origin })}\n`
    )
  })
)

await app.run()
