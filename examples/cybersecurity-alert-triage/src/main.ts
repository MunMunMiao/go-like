import process from "node:process"

import { withoutCancel } from "@go-like/core/context"
import { afterStart, afterStop, beforeStart, name, newApp, registrar, server } from "@go-like/core"
import { signal } from "@go-like/core/node"
import { newEtcdClient } from "@go-like/etcd"
import { newEtcdRegistry } from "@go-like/etcd/registry"
import type { Handler } from "@go-like/core/web"
import { createHealthHandler } from "@go-like/core/web"
import { hostname, newNodeServer, port } from "@go-like/core/web/node"

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
const etcdClient =
  etcdAddress === undefined
    ? null
    : newEtcdClient({
        address: etcdAddress,
        fetch(request) {
          return fetch(request)
        }
      })
const etcdOptions =
  etcdClient === null
    ? null
    : Object.freeze({
        client: etcdClient,
        configKey: process.env.ETCD_CONFIG_KEY ?? "go-like/examples/security/triage/config"
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
  etcdClient === null
    ? null
    : newEtcdRegistry(etcdClient, {
        prefix: "/go-like/examples/security/registry/"
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
      `GO_LIKE_EXAMPLE_READY=${JSON.stringify({ example: "cybersecurity-alert-triage", origin })}\n`
    )
  }),
  afterStop((ctx) => config.close(withoutCancel(ctx)))
)

await app.run()
