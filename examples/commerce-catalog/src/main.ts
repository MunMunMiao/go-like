import process from "node:process"

import { newRedisCache } from "@likego/cache-redis"
import { newClient, withDiscovery, withSelector, withTransport } from "@likego/client"
import {
  afterStart,
  id,
  metadata,
  name,
  newApp,
  registrar,
  server,
  stopTimeout,
  version
} from "@likego/core"
import { background } from "@likego/context"
import { signal } from "@likego/core/node"
import { newRoundRobinSelector } from "@likego/registry"
import { newConsulRegistry } from "@likego/registry-consul"
import {
  address,
  handler as serviceHandler,
  newServer,
  transport as serverTransport
} from "@likego/server"
import { newHTTPTransport } from "@likego/transport-http"
import { newNodeHTTPTransport } from "@likego/transport-http/node"
import { hostname, newNodeServer, port } from "@likego/web/node"

import { newCatalogHandler } from "./http"
import { newPricingHandler } from "./pricing"

const host = process.env.HOST ?? "127.0.0.1"
const portNumber = Number(process.env.PORT ?? "3000")
if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65_535) {
  throw new TypeError("PORT must be an integer in 1..65535")
}
const consulAddress = process.env.CONSUL_HTTP_ADDR ?? "http://127.0.0.1:18500"
const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:16379"
const instanceId = `pricing-${crypto.randomUUID()}`

const registry = newConsulRegistry({
  fetch,
  address: consulAddress,
  waitMs: 1_000,
  minimumQueryIntervalMs: 20,
  retryInitialMs: 50,
  retryMaximumMs: 500,
  deregisterCriticalServiceAfterMs: 60_000
})
const cache = newRedisCache({
  url: redisUrl,
  prefix: "likego:example:commerce:",
  connectTimeoutMs: 5_000,
  commandTimeoutMs: 5_000
})
const client = newClient(
  withDiscovery(registry),
  withSelector(newRoundRobinSelector()),
  withTransport(newHTTPTransport())
)
const pricingServer = newServer(
  serverTransport(newNodeHTTPTransport()),
  address("127.0.0.1:0"),
  serviceHandler("pricing", "Pricing.Get", newPricingHandler())
)
const pricingApp = newApp(
  signal(),
  id(instanceId),
  name("pricing"),
  version("v1"),
  metadata({ application: "commerce-catalog" }),
  registrar(registry),
  stopTimeout(5_000),
  server(pricingServer)
)

const handler = newCatalogHandler({ cache, client })
const origin = `http://${host}:${portNumber}`
const catalogServer = newNodeServer(handler, hostname(host), port(portNumber))
const catalogApp = newApp(
  signal(),
  name("commerce-catalog"),
  stopTimeout(5_000),
  server(cache, catalogServer),
  afterStart(async function announceReady(ctx): Promise<void> {
    await catalogServer.endpoint(ctx)
    process.stdout.write(
      `LIKEGO_EXAMPLE_READY=${JSON.stringify({ example: "commerce-catalog", origin })}\n`
    )
  })
)

const pricingRun = pricingApp.run()
const catalogRun = catalogApp.run()
try {
  await Promise.all([pricingRun, catalogRun])
} finally {
  await Promise.allSettled([catalogApp.stop(), pricingApp.stop(), client.close(background())])
  await Promise.allSettled([catalogRun, pricingRun])
}
