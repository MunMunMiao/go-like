import process from "node:process"

import { newRedisCache } from "@likego/cache-redis"
import { newConfig, schema, source } from "@likego/config"
import { consulSource } from "@likego/config-consul"
import { withoutCancel } from "@likego/context"
import { afterStart, afterStop, beforeStart, name, newApp, server } from "@likego/core"
import { signal } from "@likego/core/node"
import { newPinoServer } from "@likego/pino"
import { hostname, newNodeServer, port } from "@likego/web/node"
import pino from "pino"

import { tenantDocumentSchema } from "./config"
import { newTenantHandler } from "./http"
import { newTenantRuntimeState } from "./runtime-state"

const host = process.env.HOST ?? "127.0.0.1"
const portNumber = Number(process.env.PORT ?? "3000")
if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65_535) {
  throw new TypeError("PORT must be an integer in 1..65535")
}
const consulAddress = process.env.CONSUL_HTTP_ADDR ?? "http://127.0.0.1:28500"
const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:26379"
const configKey = process.env.CONFIG_KEY ?? "likego/examples/saas-tenant-api/config"
const runtimeState = newTenantRuntimeState(consulAddress, crypto.randomUUID())

const config = newConfig(
  source(
    consulSource({
      fetch,
      address: consulAddress,
      key: configKey,
      waitMs: 1_000,
      retryInitialMs: 50,
      retryMaximumMs: 500
    })
  ),
  schema(tenantDocumentSchema)
)
const cache = newRedisCache({
  url: redisUrl,
  prefix: "likego:example:saas:",
  connectTimeoutMs: 5_000,
  commandTimeoutMs: 5_000
})
const destination = pino.destination({ dest: 1, sync: false })
const logger = pino(
  {
    base: null,
    redact: ["authorization", "cookie", "token", "password", "secret"]
  },
  destination
)
const logging = newPinoServer(logger, destination)
const handler = newTenantHandler({
  config,
  cache,
  logger,
  resolveTenant(_ctx, request) {
    return request.headers.get("X-Tenant-Id") ?? ""
  }
})
const origin = `http://${host}:${portNumber}`
const webServer = newNodeServer(handler, hostname(host), port(portNumber))
const app = newApp(
  signal(),
  name("saas-tenant-api"),
  beforeStart(async function loadRuntime(ctx): Promise<void> {
    await config.load(ctx)
    await runtimeState.publish(ctx)
  }),
  server(logging, cache, webServer),
  afterStart(async function announceReady(ctx): Promise<void> {
    await webServer.endpoint(ctx)
    process.stdout.write(
      `LIKEGO_EXAMPLE_READY=${JSON.stringify({ example: "saas-tenant-api", origin })}\n`
    )
  }),
  afterStop(async function closeRuntime(ctx): Promise<void> {
    const cleanup = withoutCancel(ctx)
    try {
      await runtimeState.remove(cleanup)
    } finally {
      await config.close(cleanup)
    }
  })
)

await app.run()
