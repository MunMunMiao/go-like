import process from "node:process"

import { withoutCancel } from "@likego/context"
import { afterStart, afterStop, beforeStart, name, newApp, server } from "@likego/core"
import { signal } from "@likego/core/node"
import { hostname, newNodeServer, port } from "@likego/web/node"

import { newEnergySettlementHandler } from "./http"
import { newSettleMeter } from "./service"
import { newTariffConfig } from "./tariff-config"

const host = process.env.HOST ?? "127.0.0.1"
const portNumber = Number(process.env.PORT ?? "3000")
if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65_535) {
  throw new TypeError("PORT must be an integer in 1..65535")
}

const config = newTariffConfig({
  offPeakMinorPerKwh: 18,
  peakMinorPerKwh: 41
})
const handler = newEnergySettlementHandler(newSettleMeter(config))
const origin = `http://${host}:${portNumber}`
const httpServer = newNodeServer(handler, hostname(host), port(portNumber))
const app = newApp(
  signal(),
  name("energy-meter-settlement"),
  beforeStart((ctx) => config.load(ctx)),
  server(httpServer),
  afterStart(async function announceReady(ctx): Promise<void> {
    await httpServer.endpoint(ctx)
    process.stdout.write(
      `LIKEGO_EXAMPLE_READY=${JSON.stringify({ example: "energy-meter-settlement", origin })}\n`
    )
  }),
  afterStop((ctx) => config.close(withoutCancel(ctx)))
)

await app.run()
