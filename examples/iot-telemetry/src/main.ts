import process from "node:process"

import { newNatsJetStreamBroker } from "@go-like/nats/jetstream"
import { afterStart, name, newApp, resources, server } from "@go-like/core"
import { signal } from "@go-like/core/node"
import { jetstream, jetstreamManager } from "@nats-io/jetstream"
import { connect } from "@nats-io/transport-node"

import {
  consumerName,
  ensureTelemetryTopology,
  newNatsConnectionResource,
  rawStream
} from "./runtime"
import { newTelemetryPolicy } from "./telemetry"
import { newTelemetryServer } from "./worker"

const natsUrl = process.env.NATS_URL ?? "nats://127.0.0.1:44222"

const connection = await connect({
  servers: natsUrl,
  maxReconnectAttempts: -1,
  reconnectTimeWait: 100,
  reconnectJitter: 0,
  timeout: 2_000
})
try {
  const client = jetstream(connection)
  const manager = await jetstreamManager(connection)
  await ensureTelemetryTopology(manager)
  const broker = newNatsJetStreamBroker(client, async () => {
    const consumer = await client.consumers.get(rawStream, consumerName)
    return await consumer.consume({ max_messages: 1 })
  })
  const app = newApp(
    signal(),
    name("iot-telemetry"),
    resources(newNatsConnectionResource(connection)),
    server(
      newTelemetryServer(broker, newTelemetryPolicy({ retryDelayMs: 250, maximumDeliveries: 5 }))
    ),
    afterStart(function announceReady(): void {
      process.stdout.write(
        `GO_LIKE_EXAMPLE_READY=${JSON.stringify({ example: "iot-telemetry", worker: consumerName })}\n`
      )
    })
  )
  await app.run()
} finally {
  if (!connection.isClosed()) await connection.close()
}
