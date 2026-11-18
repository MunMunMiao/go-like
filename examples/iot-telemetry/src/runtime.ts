import { newResourceServer, type Server } from "@go-like/core/lifecycle"
import { AckPolicy, RetentionPolicy, StorageType, type JetStreamManager } from "@nats-io/jetstream"
import { nanos, type NatsConnection } from "@nats-io/transport-node"

import { deadLetterTelemetrySubject, rawTelemetrySubjects } from "./nats"

export const rawStream = "TELEMETRY_RAW"
export const validatedStream = "TELEMETRY_VALIDATED"
export const deadLetterStream = "TELEMETRY_DLQ"
export const consumerName = "telemetry-validator-v1"

/** Adds one stream only when the target JetStream account does not already contain it. */
async function ensureStream(
  manager: JetStreamManager,
  name: string,
  subjects: readonly string[]
): Promise<void> {
  try {
    await manager.streams.info(name)
  } catch {
    await manager.streams.add({
      name,
      subjects: Array.from(subjects),
      retention: RetentionPolicy.Limits,
      storage: StorageType.File
    })
  }
}

/** Creates the stream and durable-consumer topology required by the worker. */
export async function ensureTelemetryTopology(manager: JetStreamManager): Promise<void> {
  await ensureStream(manager, rawStream, [rawTelemetrySubjects])
  await ensureStream(manager, validatedStream, ["telemetry.validated.v1.*"])
  await ensureStream(manager, deadLetterStream, [deadLetterTelemetrySubject])
  try {
    await manager.consumers.info(rawStream, consumerName)
  } catch {
    await manager.consumers.add(rawStream, {
      durable_name: consumerName,
      name: consumerName,
      ack_policy: AckPolicy.Explicit,
      ack_wait: nanos(2_000),
      max_ack_pending: 1,
      max_deliver: -1,
      filter_subject: rawTelemetrySubjects
    })
  }
}

/**
 * Admits an application-owned NATS connection into the resource tier.
 * Start resolves while the connection is open. Stop drains it once.
 * An unexpected close is the resource terminal and fails the App.
 */
export function newNatsConnectionResource(connection: NatsConnection): Server {
  return newResourceServer({
    terminal: connection.closed(),
    close: async () => {
      if (!connection.isClosed()) await connection.drain()
    }
  })
}
