import process from "node:process"

import { afterStart, name, newApp, server } from "@go-like/core"
import { signal } from "@go-like/core/node"
import { hostname, newNodeServer, port } from "@go-like/web/node"

import { newWarehousePickingHandler } from "./http"
import { newAcquirePickLease, newCompletePickTask, newMemoryPickTaskRepository } from "./service"
import { newPickWorkerServer } from "./worker"

const host = process.env.HOST ?? "127.0.0.1"
const portText = process.env.PORT ?? "3000"
if (host === "" || host.trim() !== host || /[/?#@\s]/u.test(host)) {
  throw new TypeError("HOST must be a non-empty hostname or IP address")
}
if (!/^[1-9]\d{0,4}$/u.test(portText)) {
  throw new TypeError("PORT must be a decimal integer in 1..65535")
}
const portNumber = Number(portText)
if (portNumber > 65_535) throw new TypeError("PORT must be a decimal integer in 1..65535")

const repository = newMemoryPickTaskRepository({ taskIds: ["wave-1", "worker-task"] })
const worker = newPickWorkerServer(repository, {
  taskId: "worker-task",
  workerId: "resident-worker",
  leaseMs: 3_600_000
})
const handler = newWarehousePickingHandler(
  newAcquirePickLease(repository),
  newCompletePickTask(repository)
)
const originHost = host.includes(":") ? `[${host}]` : host
const origin = `http://${originHost}:${portNumber}`
const webServer = newNodeServer(handler, hostname(host), port(portNumber))
const app = newApp(
  signal(),
  name("warehouse-wave-picking"),
  server(worker, webServer),
  afterStart(async function announceReady(ctx): Promise<void> {
    await webServer.endpoint(ctx)
    process.stdout.write(
      `GO_LIKE_EXAMPLE_READY=${JSON.stringify({ example: "warehouse-wave-picking", origin })}\n`
    )
  })
)

await app.run()
