import process from "node:process"

import { newNatsJetStreamBroker } from "@likego/nats/jetstream/broker"
import { afterStart, name, newApp, server } from "@likego/core"
import { signal } from "@likego/core/node"
import { jetstream, jetstreamManager } from "@nats-io/jetstream"
import { connect } from "@nats-io/transport-node"

import {
  consumerName,
  ensureTelemetryTopology,
  newNatsConnectionServer,
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
    server(
      newNatsConnectionServer(connection),
      newTelemetryServer(broker, newTelemetryPolicy({ retryDelayMs: 250, maximumDeliveries: 5 }))
    ),
    afterStart(function announceReady(): void {
      process.stdout.write(
        `LIKEGO_EXAMPLE_READY=${JSON.stringify({ example: "iot-telemetry", worker: consumerName })}\n`
      )
    })
  )
  await app.run()
} finally {
  if (!connection.isClosed()) await connection.close()
}
