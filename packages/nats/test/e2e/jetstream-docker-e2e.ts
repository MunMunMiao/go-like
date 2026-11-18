import { background } from "@go-like/core/context"
import { eventBroker, type Codec } from "@go-like/core/broker"
import { brokerConformance, brokerTelemetryConformance } from "@go-like/core/testing"
import {
  AckPolicy,
  DeliverPolicy,
  RetentionPolicy,
  StorageType,
  jetstream,
  jetstreamManager,
  type ConsumerMessages,
  type JetStreamClient,
  type JetStreamManager,
  type JsMsg
} from "@nats-io/jetstream"
import { connect, nanos, type NatsConnection, type Status } from "@nats-io/transport-node"
import { newNatsJetStreamBroker } from "../../src/jetstream"
import { brokerCaseSubject, runIsolatedBrokerCases } from "../conformance-subject"

const NatsImage =
  "docker.io/library/nats:2.14.4-alpine@sha256:f2123f533c2b0cada0a5c5ec434fb2b8cfe1cf220215ef9d7517e1372917ad66"
const ExpectedServerVersion = "2.14.4"
const DockerOwner = process.env.GO_LIKE_E2E_OWNER
if (DockerOwner === undefined || !/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(DockerOwner))
  throw new Error("invalid GO_LIKE_E2E_OWNER")
const DockerOwnerLabel = `io.go-like.e2e.owner=${DockerOwner}`

interface CommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

interface ManagedMessages {
  readonly unsubscribe: () => Promise<void>
}

interface TypedEvent {
  readonly id: number
  readonly name: string
}

const typedEventCodec: Codec<TypedEvent> = Object.freeze({
  mediaType: "application/json",
  encode(value: TypedEvent) {
    return new TextEncoder().encode(JSON.stringify(value))
  },
  decode(bytes: Uint8Array) {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
    if (typeof value !== "object" || value === null) {
      throw new TypeError("invalid typed JetStream event")
    }
    const id: unknown = Reflect.get(value, "id")
    const name: unknown = Reflect.get(value, "name")
    if (typeof id !== "number" || typeof name !== "string")
      throw new TypeError("invalid typed JetStream event")
    return Object.freeze({ id, name })
  }
})

/** Throws when one real-service invariant is false. */
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/** Runs one command without a shell and captures its complete result. */
async function command(args: string[], allowFailure = false): Promise<CommandResult> {
  const process = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text()
  ])
  if (!allowFailure && exitCode !== 0) {
    throw new Error(`${args.join(" ")} failed (${exitCode}): ${stderr.trim()}`)
  }
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode }
}

/** Reserves and releases one loopback port for the Docker publication. */
function allocateHostPort(): number {
  const reservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(null, { status: 204 })
  })
  const port = reservation.port
  reservation.stop(true)
  if (port === undefined) throw new Error("Bun did not allocate a loopback port")
  return port
}

/** Waits until an observable real-service condition is satisfied. */
async function waitUntil(
  label: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 15_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await Bun.sleep(25)
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** Opens the official connection after the real container becomes ready. */
async function connectWhenReady(server: string): Promise<NatsConnection> {
  let lastError: unknown = null
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      return await connect({
        servers: server,
        maxReconnectAttempts: -1,
        reconnectTimeWait: 100,
        reconnectJitter: 0,
        timeout: 1_000
      })
    } catch (error) {
      lastError = error
      await Bun.sleep(50)
    }
  }
  throw new Error("NATS container never accepted an official client connection", {
    cause: lastError
  })
}

/** Adds one application-owned named pull consumer with explicit acknowledgement. */
async function addDurableConsumer(
  manager: JetStreamManager,
  stream: string,
  consumerName: string,
  subject: string,
  maxDeliver: number,
  ackWaitMs = 200
): Promise<void> {
  await manager.consumers.add(stream, {
    durable_name: consumerName,
    name: consumerName,
    ack_policy: AckPolicy.Explicit,
    ack_wait: nanos(ackWaitMs),
    max_ack_pending: 1,
    max_deliver: maxDeliver,
    filter_subject: subject
  })
}

/** Subscribes through the broker over one already-opened official consumer iterator. */
async function startManaged(
  client: JetStreamClient,
  subject: string,
  messages: ConsumerMessages,
  onMessage: (message: JsMsg) => void | Promise<void>
): Promise<ManagedMessages> {
  const broker = newNatsJetStreamBroker(client, () => messages)
  const subscriber = await broker.subscribe(background(), subject, async (_ctx, event) => {
    await onMessage(event.native)
  })
  return {
    async unsubscribe() {
      await subscriber.unsubscribe(background())
    }
  }
}

/** Stops the broker subscription. */
async function stopManaged(managed: ManagedMessages): Promise<void> {
  await managed.unsubscribe()
}

/** Opens one continuous official pull iterator for a named durable consumer. */
async function consumeDurable(
  client: JetStreamClient,
  stream: string,
  consumerName: string
): Promise<ConsumerMessages> {
  const consumer = await client.consumers.get(stream, consumerName)
  return await consumer.consume({ max_messages: 1 })
}

/** Closes the application-owned connection during final cleanup. */
async function closeConnection(connection: NatsConnection | null): Promise<void> {
  if (connection === null || connection.isClosed()) return
  try {
    await connection.drain()
  } catch {
    await connection.close()
  }
}

/** Executes the fixed-digest JetStream real-service gate. */
async function main(): Promise<void> {
  const project = `go-like-nats-jetstream-${crypto.randomUUID()}`
  const container = `${project}-server`
  const label = `go-like.project=${project}`
  const prefix = crypto.randomUUID().replaceAll("-", "")
  const sourceStream = `LGSOURCE_${prefix}`
  const deadStream = `LGDEAD_${prefix}`
  const sourcePrefix = `go-like.${prefix}.events`
  const deadPrefix = `go-like.${prefix}.dlq`
  const lateRejections: unknown[] = []
  const statuses: Status["type"][] = []
  let connection: NatsConnection | null = null
  let statusTask: Promise<void> | null = null
  let serverVersion = ""

  /** Records any process-level late rejection as a release-gate failure. */
  const recordLateRejection = (reason: unknown): void => {
    lateRejections.push(reason)
  }
  process.on("unhandledRejection", recordLateRejection)

  try {
    const hostPort = allocateHostPort()
    await command([
      "docker",
      "run",
      "--detach",
      "--name",
      container,
      "--label",
      label,
      "--label",
      DockerOwnerLabel,
      "--publish",
      `127.0.0.1:${hostPort}:4222`,
      NatsImage,
      "-js"
    ])
    const server = `nats://127.0.0.1:${hostPort}`
    connection = await connectWhenReady(server)
    serverVersion = (await command(["docker", "exec", container, "nats-server", "--version"]))
      .stdout
    assert(
      serverVersion.includes(ExpectedServerVersion),
      `unexpected nats-server version: ${serverVersion}`
    )

    statusTask = (async () => {
      if (connection === null) return
      for await (const status of connection.status()) statuses.push(status.type)
    })()
    void statusTask.catch(recordLateRejection)

    const client = jetstream(connection)
    const manager = await jetstreamManager(connection)
    await manager.streams.add({
      name: sourceStream,
      subjects: [`${sourcePrefix}.>`],
      retention: RetentionPolicy.Limits,
      storage: StorageType.File
    })
    await manager.streams.add({
      name: deadStream,
      subjects: [`${deadPrefix}.>`],
      retention: RetentionPolicy.Limits,
      storage: StorageType.File
    })

    const rawSubject = `${sourcePrefix}.raw`
    const rawConsumer = `raw_${prefix}`
    await addDurableConsumer(manager, sourceStream, rawConsumer, rawSubject, 4)
    const rawBodies: string[] = []
    const rawSubjects: string[] = []
    const rawAcks: boolean[] = []
    const raw = await startManaged(
      client,
      rawSubject,
      await consumeDurable(client, sourceStream, rawConsumer),
      async (message) => {
        rawBodies.push(message.string())
        rawSubjects.push(message.subject)
        rawAcks.push(await message.ackAck())
      }
    )
    await client.publish(rawSubject, "one")
    await waitUntil("application raw JetStream consumption", () => rawBodies.length === 1)
    await waitUntil(
      "raw acknowledgement floor",
      async () => (await manager.consumers.info(sourceStream, rawConsumer)).num_ack_pending === 0
    )
    const rawInfo = await manager.consumers.info(sourceStream, rawConsumer)
    await stopManaged(raw)
    assert(
      rawSubjects[0] === rawSubject && rawBodies[0] === "one",
      "raw JetStream delivery changed"
    )
    assert(
      rawAcks[0] === true && rawInfo.num_ack_pending === 0,
      "raw JetStream ack was not confirmed"
    )

    const typedSubject = `${sourcePrefix}.typed`
    const typedConsumer = `typed_${prefix}`
    await addDurableConsumer(manager, sourceStream, typedConsumer, typedSubject, 4)
    const typedBroker = newNatsJetStreamBroker(client, async () => {
      return await consumeDurable(client, sourceStream, typedConsumer)
    })
    const typedEvents = eventBroker(typedBroker, typedEventCodec)
    const typedIds: number[] = []
    const typedAckResults: boolean[] = []
    const typedHandle = await typedEvents.subscribe(
      background(),
      typedSubject,
      async (_ctx, event) => {
        const value = event.decode()
        typedIds.push(value.id)
        typedAckResults.push(await event.native.ackAck())
      }
    )
    const typedPubAck = await typedEvents.publish(background(), typedSubject, {
      id: 7,
      name: "typed"
    })
    await waitUntil("typed JetStream Event delivery", () => typedIds.length === 1)
    await waitUntil(
      "typed JetStream acknowledgement floor",
      async () => (await manager.consumers.info(sourceStream, typedConsumer)).num_ack_pending === 0
    )
    await typedHandle.unsubscribe(background())
    assert(typedPubAck.stream === sourceStream && typedPubAck.seq > 0, "typed publish ack changed")
    assert(typedIds[0] === 7 && typedAckResults[0] === true, "typed event delivery or ack changed")

    const invalidSubject = `${sourcePrefix}.typed.invalid`
    const invalidConsumer = `typed_invalid_${prefix}`
    await addDurableConsumer(manager, sourceStream, invalidConsumer, invalidSubject, 4, 100)
    const invalidBroker = newNatsJetStreamBroker(client, async () => {
      return await consumeDurable(client, sourceStream, invalidConsumer)
    })
    const invalidEvents = eventBroker(invalidBroker, typedEventCodec)
    let invalidDeliveries = 0
    let decodeFailures = 0
    let retainedNative = false
    const invalidHandle = await invalidEvents.subscribe(
      background(),
      invalidSubject,
      (_ctx, event) => {
        invalidDeliveries += 1
        try {
          event.decode()
        } catch {
          decodeFailures += 1
          retainedNative = event.native.subject === invalidSubject
          if (invalidDeliveries === 1) event.native.nak(25)
          else event.native.term("invalid typed payload")
        }
      }
    )
    await invalidBroker.publish(background(), invalidSubject, {
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode('{"id":"invalid","name":"typed"}')
    })
    await waitUntil(
      "typed invalid payload application settlement",
      () => invalidDeliveries === 2 && decodeFailures === 2
    )
    await waitUntil(
      "typed invalid payload term floor",
      async () =>
        (await manager.consumers.info(sourceStream, invalidConsumer)).num_ack_pending === 0
    )
    await invalidHandle.unsubscribe(background())
    assert(retainedNative, "invalid typed event lost its native message")
    assert(
      !connection.isClosed() && !connection.isDraining(),
      "invalid typed event closed connection"
    )

    const maxSubject = `${sourcePrefix}.max`
    const maxConsumer = `max_${prefix}`
    await addDurableConsumer(manager, sourceStream, maxConsumer, maxSubject, 2, 100)
    const deliveryCounts: number[] = []
    const maximum = await startManaged(
      client,
      maxSubject,
      await consumeDurable(client, sourceStream, maxConsumer),
      (message) => {
        deliveryCounts.push(message.info.deliveryCount)
      }
    )
    await client.publish(maxSubject, "retry")
    await waitUntil("MaxDeliver redelivery", () => deliveryCounts.length === 2)
    await Bun.sleep(350)
    await stopManaged(maximum)
    assert(deliveryCounts.join(",") === "1,2", "MaxDeliver produced unexpected delivery counts")

    const dlqSourceSubject = `${sourcePrefix}.dead`
    const dlqTargetSubject = `${deadPrefix}.events`
    const dlqConsumer = `dlq_${prefix}`
    await addDurableConsumer(manager, sourceStream, dlqConsumer, dlqSourceSubject, 4, 100)
    let publishFailureAtThreshold = false
    let deadLetterPublished = false
    const dead = await startManaged(
      client,
      dlqSourceSubject,
      await consumeDurable(client, sourceStream, dlqConsumer),
      async (message) => {
        if (message.info.deliveryCount === 2) {
          try {
            await client.publish(`unbound.${prefix}`, message.data)
          } catch {
            publishFailureAtThreshold = true
          }
          return
        }
        if (message.info.deliveryCount >= 3 && !deadLetterPublished) {
          await client.publish(dlqTargetSubject, message.data, {
            msgID: `application-dlq:${message.info.streamSequence}`
          })
          deadLetterPublished = true
          message.term("application dead-lettered after PubAck")
        }
      }
    )
    await client.publish(dlqSourceSubject, "dead-body")
    await waitUntil(
      "application DLQ recovery",
      () => publishFailureAtThreshold && deadLetterPublished
    )
    await waitUntil(
      "source term acknowledgement",
      async () => (await manager.consumers.info(sourceStream, dlqConsumer)).num_ack_pending === 0
    )
    const deadConsumerName = `deadread_${prefix}`
    await addDurableConsumer(manager, deadStream, deadConsumerName, dlqTargetSubject, 1)
    const deadConsumer = await client.consumers.get(deadStream, deadConsumerName)
    const deadMessage = await deadConsumer.next({ expires: 2_000 })
    assert(deadMessage !== null, "application DLQ publication was not stored")
    const deadLetterBodyMatch = deadMessage.string() === "dead-body"
    const deadLetterAckConfirmed = await deadMessage.ackAck()
    const deadStreamInfo = await manager.streams.info(deadStream)
    const sourceInfo = await manager.consumers.info(sourceStream, dlqConsumer)
    await stopManaged(dead)
    assert(publishFailureAtThreshold, "DLQ did not observe the forced publish failure")
    assert(sourceInfo.num_ack_pending === 0, "DLQ source acknowledgement remained pending")
    assert(deadStreamInfo.state.messages === 1, "DLQ published more than one message")
    assert(deadLetterBodyMatch && deadLetterAckConfirmed, "DLQ body or ack changed")

    const reconnectSubject = `${sourcePrefix}.reconnect`
    const reconnectConsumer = `reconnect_${prefix}`
    await addDurableConsumer(manager, sourceStream, reconnectConsumer, reconnectSubject, 4)
    const recovered: string[] = []
    const recoveredAcks: boolean[] = []
    const reconnecting = await startManaged(
      client,
      reconnectSubject,
      await consumeDurable(client, sourceStream, reconnectConsumer),
      async (message) => {
        recovered.push(message.string())
        recoveredAcks.push(await message.ackAck())
      }
    )
    await command(["docker", "stop", "--time", "1", container])
    await waitUntil(
      "official disconnect status",
      () => statuses.includes("disconnect") || statuses.includes("reconnecting")
    )
    await command(["docker", "start", container])
    await waitUntil("official reconnect status", () => statuses.includes("reconnect"), 30_000)
    await client.publish(reconnectSubject, "after-reconnect")
    await waitUntil("application iterator recovery", () => recovered.length === 1, 30_000)
    await stopManaged(reconnecting)
    await manager.consumers.info(sourceStream, reconnectConsumer)
    assert(
      recovered[0] === "after-reconnect" && recoveredAcks[0] === true,
      "reconnect delivery changed"
    )
    assert(!connection.isClosed() && !connection.isDraining(), "reconnect closed connection")

    let caseNumber = 0
    const nextJetStreamSubject = () => {
      caseNumber += 1
      const topic = `go-like.${prefix}.conformance.${caseNumber}`
      const stream = `SUITE_${prefix}_${caseNumber}`
      let consumers = 0
      return {
        ...brokerCaseSubject(
          topic,
          async () => {
            await manager.streams.add({
              name: stream,
              subjects: [topic],
              retention: RetentionPolicy.Limits,
              storage: StorageType.Memory
            })
            return newNatsJetStreamBroker(client, async () => {
              consumers += 1
              const durable = `s${caseNumber}c${consumers}`
              await manager.consumers.add(stream, {
                durable_name: durable,
                ack_policy: AckPolicy.Explicit,
                deliver_policy: DeliverPolicy.New,
                filter_subject: topic,
                max_deliver: 1
              })
              const consumer = await client.consumers.get(stream, durable)
              return consumer.consume()
            })
          },
          async () => {
            await manager.streams.delete(stream)
          }
        ),
        settle(event: { native: { ack(): void } }) {
          event.native.ack()
        }
      }
    }
    await runIsolatedBrokerCases(brokerConformance, nextJetStreamSubject)
    await runIsolatedBrokerCases(brokerTelemetryConformance, nextJetStreamSubject)
    const first = nextJetStreamSubject()
    const firstBroker = await first.newBroker(background())
    const seen: string[] = []
    await firstBroker.subscribe(background(), first.topic, (_ctx, event) => {
      seen.push(new TextDecoder().decode(event.message.body))
    })
    await first.close(background())
    const second = nextJetStreamSubject()
    const secondBroker = await second.newBroker(background())
    const encode = (value: string): Uint8Array => new TextEncoder().encode(value)
    await secondBroker.publish(background(), second.topic, {
      headers: {},
      body: encode("later")
    })
    try {
      await secondBroker.publish(background(), first.topic, {
        headers: {},
        body: encode("stale-topic")
      })
    } catch {
      // The first stream is already deleted. A throw is not a leftover delivery.
    }
    await connection.flush()
    const deadline = Date.now() + 500
    while (Date.now() < deadline && seen.length === 0) await Bun.sleep(20)
    assert(seen.length === 0, `leftover subscriber received ${seen.join(",")}`)
    await second.close(background())

    await Bun.sleep(50)
    assert(lateRejections.length === 0, `observed ${lateRejections.length} late rejection(s)`)
  } finally {
    await closeConnection(connection)
    if (statusTask !== null) await statusTask.catch(() => {})
    await command(["docker", "rm", "--force", container], true)
    process.off("unhandledRejection", recordLateRejection)
  }

  const remaining = await command([
    "docker",
    "ps",
    "--all",
    "--quiet",
    "--filter",
    `label=${label}`
  ])
  assert(remaining.stdout.length === 0, `project containers remain: ${remaining.stdout}`)
  assert(
    lateRejections.length === 0,
    `observed ${lateRejections.length} late rejection(s) after cleanup`
  )
}

await main()
