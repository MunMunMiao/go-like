import type { Context } from "@likego/context"
import type { Server } from "@likego/core"
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

/** Adapts one application-owned NATS connection to the standard Core Server contract. */
export function newNatsConnectionServer(connection: NatsConnection): Server {
  const done = connection.closed().then((failure) => {
    if (failure !== undefined) throw failure
  })
  return Object.freeze({
    async start(ctx: Context): Promise<void> {
      const failure = ctx.err()
      if (failure !== null) throw failure
      await done
    },
    async stop(): Promise<void> {
      if (!connection.isClosed()) await connection.drain()
    }
  })
}
