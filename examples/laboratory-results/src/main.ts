import process from "node:process"

import { afterStart, name, newApp, server } from "@likego/core"
import { signal } from "@likego/core/node"
import { hostname, newNodeServer, port } from "@likego/web/node"

import { newLaboratoryResultHandler } from "./http"
import {
  newMemoryLaboratoryResultRepository,
  newMemoryResultAuditSink,
  newRecordLaboratoryResult
} from "./service"

const host = process.env.HOST ?? "127.0.0.1"
const portNumber = Number(process.env.PORT ?? "3000")
if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65_535) {
  throw new TypeError("PORT must be an integer in 1..65535")
}

const repository = newMemoryLaboratoryResultRepository({
  encounters: [
    {
      encounterId: "encounter-1",
      patientId: "patient-1",
      orderingClinicianId: "clinician-1"
    }
  ]
})
const handler = newLaboratoryResultHandler(
  newRecordLaboratoryResult(repository, newMemoryResultAuditSink())
)
const origin = `http://${host}:${portNumber}`
const httpServer = newNodeServer(handler, hostname(host), port(portNumber))
const app = newApp(
  signal(),
  name("laboratory-results"),
  server(httpServer),
  afterStart(async function announceReady(ctx): Promise<void> {
    await httpServer.endpoint(ctx)
    process.stdout.write(
      `LIKEGO_EXAMPLE_READY=${JSON.stringify({ example: "laboratory-results", origin })}\n`
    )
  })
)

await app.run()
