import process from "node:process"

import { afterStart, name, newApp, server } from "@likego/core"
import { signal } from "@likego/core/node"
import { hostname, newNodeServer, port } from "@likego/web/node"

import { newPrescriptionHandler } from "./http"
import {
  newCancelPrescription,
  newDispensePrescription,
  newMemoryPharmacyInventory,
  newMemoryPrescriptionRepository,
  type Prescription
} from "./service"

const host = process.env.HOST ?? "127.0.0.1"
const portNumber = Number(process.env.PORT ?? "3000")
if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65_535) {
  throw new TypeError("PORT must be an integer in 1..65535")
}

const prescriptions: readonly Prescription[] = Object.freeze([
  Object.freeze({
    prescriptionId: "rx-demo",
    patientId: "patient-demo",
    drugCode: "drug-a",
    quantity: 2,
    status: "issued"
  })
])
const repository = newMemoryPrescriptionRepository({ prescriptions })
const inventory = newMemoryPharmacyInventory({ stock: { "drug-a": 10 } })
const handler = newPrescriptionHandler(
  newDispensePrescription(repository, inventory),
  newCancelPrescription(repository)
)
const origin = `http://${host}:${portNumber}`
const webServer = newNodeServer(handler, hostname(host), port(portNumber))
const app = newApp(
  signal(),
  name("pharmacy-prescription"),
  server(webServer),
  afterStart(async function announceReady(ctx): Promise<void> {
    await webServer.endpoint(ctx)
    process.stdout.write(
      `LIKEGO_EXAMPLE_READY=${JSON.stringify({ example: "pharmacy-prescription", origin })}\n`
    )
  })
)

await app.run()
