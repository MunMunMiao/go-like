import { background } from "@likego/context"
import { AckPolicy, StorageType, jetstream, jetstreamManager } from "@nats-io/jetstream"
import { connect, type NatsConnection } from "@nats-io/transport-node"
import { newNatsJetStreamServer } from "@likego/nats/jetstream"

/** Throws when one package-install runtime invariant is false. */
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/** Waits for one installed-package behavior with a bounded deadline. */
async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("installed JetStream package smoke timed out")
}

/** Closes the application-owned connection after the smoke completes. */
async function closeConnection(connection: NatsConnection | null): Promise<void> {
  if (connection === null || connection.isClosed()) return
  try {
    await connection.drain()
  } catch {
    await connection.close()
  }
}

/** Runs one package-name smoke against a real JetStream server. */
async function main(): Promise<void> {
  const serverUrl = process.env.LIKEGO_NATS_URL
  assert(serverUrl !== undefined, "LIKEGO_NATS_URL is required")
  const token = crypto.randomUUID().replaceAll("-", "")
  const stream = `LGSMOKE_${token}`
  const consumerName = `smoke_${token}`
  const subject = `likego.smoke.${token}`
  let connection: NatsConnection | null = null
  try {
    connection = await connect({ servers: serverUrl })
    const client = jetstream(connection)
    const manager = await jetstreamManager(connection)
    await manager.streams.add({ name: stream, subjects: [subject], storage: StorageType.Memory })
    await manager.consumers.add(stream, {
      durable_name: consumerName,
      name: consumerName,
      ack_policy: AckPolicy.Explicit,
      max_deliver: 4,
      filter_subject: subject
    })
    const payloads: string[] = []
    const consumer = await client.consumers.get(stream, consumerName)
    const messages = await consumer.consume({ max_messages: 1 })
    const server = newNatsJetStreamServer(messages)
    const running = server.start(background())
    const consuming = (async () => {
      for await (const message of messages) {
        payloads.push(message.string())
        await message.ackAck()
      }
    })()
    await client.publish(subject, "installed")
    await waitUntil(() => payloads.length === 1)
    await waitUntil(
      async () => (await manager.consumers.info(stream, consumerName)).num_ack_pending === 0
    )
    await server.stop(background())
    await running
    await consuming
    assert(payloads[0] === "installed", "installed package changed the payload")
    assert(
      !connection.isClosed() && !connection.isDraining(),
      "installed adapter took connection ownership"
    )
    await manager.streams.delete(stream)
    const runtime = typeof Bun === "undefined" ? process.version : `bun-${Bun.version}`
    console.log(
      `LIKEGO_NATS_JETSTREAM_RUNTIME_RESULT=${JSON.stringify({
        valid: true,
        runtime,
        package: "@likego/nats",
        connectionOwnedBy: "application",
        durableConsumerOwnedBy: "application",
        consumptionAndAckOwnedBy: "application"
      })}`
    )
  } finally {
    await closeConnection(connection)
  }
}

await main()
