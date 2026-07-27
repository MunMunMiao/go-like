import process from "node:process"

import { withoutCancel } from "@likego/context"
import { afterStart, afterStop, beforeStart, name, newApp, server } from "@likego/core"
import { signal } from "@likego/core/node"
import { hostname, newNodeServer, port } from "@likego/web/node"

import { newMemoryTemperatureLedger, newTemperatureConfig } from "./config"
import { newColdChainHandler } from "./http"
import { newMonitorTemperature } from "./service"

const host = process.env.HOST ?? "127.0.0.1"
const portNumber = Number(process.env.PORT ?? "3000")
if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65_535) {
  throw new TypeError("PORT must be an integer in 1..65535")
}

const config = newTemperatureConfig({ minimumC: 2, maximumC: 8 })
const handler = newColdChainHandler(newMonitorTemperature(config, newMemoryTemperatureLedger()))
const origin = `http://${host}:${portNumber}`
const httpServer = newNodeServer(handler, hostname(host), port(portNumber))
const app = newApp(
  signal(),
  name("cold-chain-monitoring"),
  beforeStart((ctx) => config.load(ctx)),
  server(httpServer),
  afterStart(async function announceReady(ctx): Promise<void> {
    await httpServer.endpoint(ctx)
    process.stdout.write(
      `LIKEGO_EXAMPLE_READY=${JSON.stringify({ example: "cold-chain-monitoring", origin })}\n`
    )
  }),
  afterStop((ctx) => config.close(withoutCancel(ctx)))
)

await app.run()
