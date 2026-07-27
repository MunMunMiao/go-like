import process from "node:process"

import { afterStart, name, newApp, server } from "@likego/core"
import { signal } from "@likego/core/node"
import { hostname, newNodeServer, port } from "@likego/web/node"

import { newDigitalIdentityService } from "./http"
import { newMemoryIdentityProvider } from "./provider"

const host = process.env.HOST ?? "127.0.0.1"
const portNumber = Number(process.env.PORT ?? "3000")
if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65_535) {
  throw new TypeError("PORT must be an integer in 1..65535")
}

const verifiedDigest = "a".repeat(64)
const provider = newMemoryIdentityProvider({
  providerId: "trusted-demo",
  decisionsByDigest: { [verifiedDigest]: "verified" }
})
const service = newDigitalIdentityService({
  providers: [provider],
  allowedProviderIds: ["trusted-demo"],
  timeoutMs: 1_000
})
const origin = `http://${host}:${portNumber}`
const httpServer = newNodeServer(service.handler, hostname(host), port(portNumber))
const app = newApp(
  signal(),
  name("digital-identity-verification"),
  server(httpServer),
  afterStart(async function announceReady(ctx): Promise<void> {
    await httpServer.endpoint(ctx)
    process.stdout.write(
      `LIKEGO_EXAMPLE_READY=${JSON.stringify({ example: "digital-identity-verification", origin })}\n`
    )
  })
)

await app.run()
