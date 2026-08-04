import process from "node:process"

import { afterStart, name, newApp, server } from "@go-like/core"
import { signal } from "@go-like/core/node"
import { hostname, newNodeServer, port } from "@go-like/web/node"

import type { CampaignDefinition } from "./campaigns"
import { newAdCampaignService } from "./service"

const host = process.env.HOST ?? "127.0.0.1"
const portNumber = Number(process.env.PORT ?? "3000")
if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65_535) {
  throw new TypeError("PORT must be an integer in 1..65535")
}

const campaigns: readonly CampaignDefinition[] = Object.freeze([
  Object.freeze({
    id: "campaign-demo",
    placement: "home",
    audienceSegments: Object.freeze(["sports"]),
    creativeId: "creative-demo",
    bidMinor: 30,
    budgetMinor: 3_000,
    active: true
  })
])
const service = newAdCampaignService(
  campaigns,
  Object.freeze({ "creative-demo": "<ad>go-like Sports</ad>" })
)
const origin = `http://${host}:${portNumber}`
const httpServer = newNodeServer(service.handler, hostname(host), port(portNumber))
const app = newApp(
  signal(),
  name("ad-campaign-serving"),
  server(httpServer),
  afterStart(async function announceReady(ctx): Promise<void> {
    await httpServer.endpoint(ctx)
    process.stdout.write(
      `GO_LIKE_EXAMPLE_READY=${JSON.stringify({ example: "ad-campaign-serving", origin })}\n`
    )
  })
)

await app.run()
