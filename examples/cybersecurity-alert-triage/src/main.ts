import process from "node:process"

import { withoutCancel } from "@likego/context"
import { afterStart, afterStop, beforeStart, name, newApp, registrar, server } from "@likego/core"
import { signal } from "@likego/core/node"
import { newEtcdRegistry } from "@likego/registry-etcd"
import type { Handler } from "@likego/web"
import { createHealthHandler } from "@likego/web/health"
import { hostname, newNodeServer, port } from "@likego/web/node"

import {
  newEtcdAlertTriageLedger,
  newEtcdTriageConfig,
  newMemoryAlertTriageLedger,
  newTriageConfig,
  newTriageReadiness
} from "./config"
import { newSecurityTriageHandler } from "./http"
import { newTriageAlert } from "./service"

const host = process.env.HOST ?? "127.0.0.1"
const portNumber = Number(process.env.PORT ?? "3000")
if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65_535) {
  throw new TypeError("PORT must be an integer in 1..65535")
}

const etcdAddress = process.env.ETCD_ADDRESS
if (etcdAddress === "") throw new TypeError("ETCD_ADDRESS must not be empty")
const etcdOptions =
  etcdAddress === undefined
    ? null
    : Object.freeze({
        address: etcdAddress,
        configKey: process.env.ETCD_CONFIG_KEY ?? "likego/examples/security/triage/config"
      })
const config =
  etcdOptions === null
    ? newTriageConfig({
        highFailedAttempts: 5,
        criticalFailedAttempts: 10,
        highMalwareConfidence: 60,
        criticalMalwareConfidence: 90
      })
    : newEtcdTriageConfig(etcdOptions)
const ledger =
  etcdOptions === null ? newMemoryAlertTriageLedger() : newEtcdAlertTriageLedger(etcdOptions)
const registry =
  etcdOptions === null
    ? null
    : newEtcdRegistry({
        fetch,
        address: etcdOptions.address,
        prefix: "/likego/examples/security/registry/"
      })
const registration = registry === null ? [] : [registrar(registry)]
const readiness = newTriageReadiness(config)
const business = newSecurityTriageHandler(newTriageAlert(config, readiness, ledger))
const health = createHealthHandler(readiness)
/** Routes health endpoints without replacing the security-triage handler. */
const handler: Handler = function route(request: Request): Response | Promise<Response> {
  const pathname = new URL(request.url).pathname
  return pathname === "/livez" || pathname === "/readyz" ? health(request) : business(request)
}
const origin = `http://${host}:${portNumber}`
const httpServer = newNodeServer(handler, hostname(host), port(portNumber))
const app = newApp(
  signal(),
  name("cybersecurity-alert-triage"),
  ...registration,
  beforeStart((ctx) => config.load(ctx)),
  server(httpServer),
  afterStart(async function announceReady(ctx): Promise<void> {
    await httpServer.endpoint(ctx)
    process.stdout.write(
      `LIKEGO_EXAMPLE_READY=${JSON.stringify({ example: "cybersecurity-alert-triage", origin })}\n`
    )
  }),
  afterStop((ctx) => config.close(withoutCancel(ctx)))
)

await app.run()
