import process from "node:process"

import { afterStart, name, newApp, registrar, server } from "@likego/core"
import { signal } from "@likego/core/node"
import { hostname, newNodeServer, port } from "@likego/web/node"

import { newDisruptionHandler } from "./http"
import { airlineRegistryFromEnvironment } from "./registry"
import { newMemoryDisruptionRepository, newResolveDisruption } from "./service"

const host = process.env.HOST ?? "127.0.0.1"
const portNumber = Number(process.env.PORT ?? "3000")
if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65_535) {
  throw new TypeError("PORT must be an integer in 1..65535")
}

const handler = newDisruptionHandler(newResolveDisruption(newMemoryDisruptionRepository()))
const origin = `http://${host}:${portNumber}`
const httpServer = newNodeServer(handler, hostname(host), port(portNumber))
const registry = airlineRegistryFromEnvironment(process.env)
const registration = registry === null ? [] : [registrar(registry)]
const app = newApp(
  signal(),
  name("airline-irregular-operations"),
  ...registration,
  server(httpServer),
  afterStart(async function announceReady(ctx): Promise<void> {
    await httpServer.endpoint(ctx)
    process.stdout.write(
      `LIKEGO_EXAMPLE_READY=${JSON.stringify({ example: "airline-irregular-operations", origin })}\n`
    )
  })
)

await app.run()
