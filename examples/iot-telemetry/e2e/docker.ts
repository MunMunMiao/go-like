import { background } from "@likego/context"
import { newApp, server, stopTimeout, type App } from "@likego/core"
import { newNatsJetStreamBroker } from "@likego/nats/jetstream/broker"
import {
  AckPolicy,
  RetentionPolicy,
  StorageType,
  jetstream,
  jetstreamManager,
  type JetStreamClient,
  type JetStreamManager
} from "@nats-io/jetstream"
import { connect, nanos, type NatsConnection, type Status } from "@nats-io/transport-node"

import { errorSummary } from "../../../e2e/harness/diagnostics"
import {
  closeOwnedDockerContext,
  createContainer,
  createVolume,
  ownedDockerContextFromEnvironment,
  scenarioDockerEnvironment,
  type OwnedDockerContext
} from "../../../e2e/harness/owned-docker"
import { deadLetterTelemetrySubject, rawTelemetrySubjects } from "../src/nats"
import { newTelemetryPolicy } from "../src/telemetry"
import { newTelemetryServer } from "../src/worker"

const NatsImage =
  "docker.io/library/nats:2.14.4-alpine@sha256:f2123f533c2b0cada0a5c5ec434fb2b8cfe1cf220215ef9d7517e1372917ad66"
const ExpectedNatsVersion = "2.14.4"
const ExpectedSdkVersion = "3.4.0"
const RawStream = "TELEMETRY_RAW"
const ValidatedStream = "TELEMETRY_VALIDATED"
const DeadLetterStream = "TELEMETRY_DLQ"
const ConsumerName = "telemetry-validator-v1"
const DockerKnownSecrets: readonly string[] = Object.freeze([])
const RunId = crypto.randomUUID()
const NatsContainer = `likego-iot-nats-${RunId}`

interface CommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

interface PackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>
}

/** Throws when one real-service invariant is false. */
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/** Runs Docker without a shell and captures its complete result. */
async function docker(
  ownedDocker: OwnedDockerContext,
  args: readonly string[],
  allowFailure = false
): Promise<CommandResult> {
  const child = Bun.spawn(["docker", ...args], {
    env: scenarioDockerEnvironment(ownedDocker),
    stdout: "pipe",
    stderr: "pipe"
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ])
  const result = Object.freeze({
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    exitCode
  })
  if (exitCode !== 0 && !allowFailure) {
    throw new Error(`Docker operation failed with exit code ${exitCode}`)
  }
  return result
}

/** Produces one bounded diagnostic without retaining raw secrets or stacks. */
function safeErrorSummary(error: unknown): string {
  return errorSummary(error, { knownSecrets: DockerKnownSecrets }, 1_024)
}

/** Wraps a failure without retaining its raw cause. */
function safeFailure(summary: string, error: unknown): Error {
  const diagnostic = safeErrorSummary(error)
  return new Error(diagnostic.length === 0 ? summary : `${summary}: ${diagnostic}`)
}

/** Reserves a fixed loopback port so Docker restart preserves the client endpoint. */
function allocateHostPort(): number {
  const reservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(null, { status: 204 })
  })
  const port = reservation.port
  reservation.stop(true)
  assert(port !== undefined, "Bun did not allocate a host port")
  return port
}

/** Waits for a bounded observable real-service condition. */
async function waitUntil(
  label: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 20_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return
    } catch {
      // Container startup, stream deletion, and reconnect are deliberately raced here.
    }
    await Bun.sleep(25)
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** Opens an official reconnecting NATS connection after the container is ready. */
async function connectNats(port: number): Promise<NatsConnection> {
  let lastError: unknown = null
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try {
      return await connect({
        servers: `nats://127.0.0.1:${port}`,
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
  throw new Error(
    `NATS container never accepted an official client connection: ${safeErrorSummary(lastError)}`
  )
}

/** Closes one application-owned official connection. */
async function closeNats(connection: NatsConnection | null): Promise<void> {
  if (connection === null || connection.isClosed()) return
  try {
    await connection.drain()
  } catch {
    await connection.close()
  }
}

/** Stops and joins the Core application that owns the telemetry subscription. */
async function stopWorker(app: App, running: Promise<void>): Promise<number> {
  const started = performance.now()
  await app.stop()
  await running
  return Math.round(performance.now() - started)
}

/** Creates the three explicit file-backed streams. */
async function createStreams(manager: JetStreamManager): Promise<void> {
  await manager.streams.add({
    name: RawStream,
    subjects: [rawTelemetrySubjects],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File
  })
  await manager.streams.add({
    name: ValidatedStream,
    subjects: ["telemetry.validated.v1.*"],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File
  })
  await manager.streams.add({
    name: DeadLetterStream,
    subjects: [deadLetterTelemetrySubject],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File
  })
}

/** Adds the single durable explicit-ack consumer owned by deployment. */
async function createConsumer(manager: JetStreamManager): Promise<void> {
  await manager.consumers.add(RawStream, {
    durable_name: ConsumerName,
    name: ConsumerName,
    ack_policy: AckPolicy.Explicit,
    ack_wait: nanos(2_000),
    max_ack_pending: 1,
    max_deliver: -1,
    filter_subject: rawTelemetrySubjects
  })
}

/** Publishes one valid v1 payload and returns the official raw PubAck sequence. */
async function publishValid(
  client: JetStreamClient,
  deviceId: string,
  messageId: string,
  sequence: string
): Promise<number> {
  const acknowledgement = await client.publish(
    `telemetry.raw.v1.${deviceId}`,
    JSON.stringify({
      schemaVersion: 1,
      messageId,
      deviceId,
      sequence,
      observedAt: new Date().toISOString(),
      temperatureC: 23.4,
      humidityPct: 58.2
    }),
    { msgID: messageId, timeout: 500 }
  )
  assert(acknowledgement.stream === RawStream, "raw publish did not return the expected PubAck")
  return acknowledgement.seq
}

/** Reads the example manifest instead of trusting a duplicated SDK version claim. */
async function verifySdkPin(): Promise<void> {
  const manifest: PackageManifest = await Bun.file(
    new URL("../package.json", import.meta.url)
  ).json()
  assert(
    manifest.dependencies?.["@nats-io/jetstream"] === ExpectedSdkVersion &&
      manifest.dependencies?.["@nats-io/transport-node"] === ExpectedSdkVersion,
    "official NATS SDK packages are not pinned to 3.4.0"
  )
}

/** Executes the raw, validated, DLQ, redelivery, reconnect, and drain contracts. */
async function main(): Promise<void> {
  const ownedDocker = await ownedDockerContextFromEnvironment(process.env)
  let connection: NatsConnection | null = null
  let statusTask: Promise<void> | null = null
  let workerApp: App | null = null
  let workerRun: Promise<void> | null = null
  let primary: unknown | null = null
  const cleanupFailures: unknown[] = []
  const statuses: Status["type"][] = []
  let phase = "startup"
  let serverVersion = "unobserved"
  let imageId = "unobserved"
  let validPubAckSequence = -1
  let validatedEventId = "unobserved"
  let dlqErrorCode = "unobserved"
  let transientRedeliveries = -1
  let drainDurationMs = -1
  let persistent = false

  try {
    phase = "verify SDK pin"
    await verifySdkPin()
    phase = "create fixed-digest NATS resource"
    const port = allocateHostPort()
    const natsVolume = await createVolume(ownedDocker, [], {
      knownSecrets: DockerKnownSecrets
    })
    await createContainer(
      ownedDocker,
      [
        "--name",
        NatsContainer,
        "--publish",
        `127.0.0.1:${port}:4222`,
        "--mount",
        `source=${natsVolume.id},target=/data`,
        NatsImage,
        "-js",
        "-sd",
        "/data"
      ],
      { knownSecrets: DockerKnownSecrets }
    )

    phase = "connect and provision JetStream"
    connection = await connectNats(port)
    statusTask = (async () => {
      if (connection === null) return
      for await (const status of connection.status()) statuses.push(status.type)
    })()
    void statusTask.catch(() => {})
    serverVersion = (await docker(ownedDocker, ["exec", NatsContainer, "nats-server", "--version"]))
      .stdout
    imageId = (await docker(ownedDocker, ["inspect", "--format", "{{.Image}}", NatsContainer]))
      .stdout
    assert(serverVersion.includes(ExpectedNatsVersion), `unexpected NATS: ${serverVersion}`)
    const client = jetstream(connection)
    const manager = await jetstreamManager(connection)
    await createStreams(manager)
    await createConsumer(manager)
    for (const stream of [RawStream, ValidatedStream, DeadLetterStream]) {
      const info = await manager.streams.info(stream)
      assert(info.config.storage === StorageType.File, `${stream} is not file-backed`)
    }
    const consumerConfig = await manager.consumers.info(RawStream, ConsumerName)
    assert(
      consumerConfig.config.ack_policy === AckPolicy.Explicit &&
        consumerConfig.config.max_ack_pending === 1 &&
        consumerConfig.config.max_deliver === -1,
      "durable consumer contract differs from the example"
    )

    const broker = newNatsJetStreamBroker(client, async () => {
      const consumer = await client.consumers.get(RawStream, ConsumerName)
      return await consumer.consume({ max_messages: 1 })
    })
    workerApp = newApp(
      stopTimeout(5_000),
      server(
        newTelemetryServer(broker, newTelemetryPolicy({ retryDelayMs: 250, maximumDeliveries: 5 }))
      )
    )
    workerRun = workerApp.run()
    void workerRun.catch(() => {})

    phase = "validate and ack one real message"
    await waitUntil("durable pull request", async () => {
      const consumer = await manager.consumers.info(RawStream, ConsumerName)
      return consumer.num_waiting >= 1
    })
    validPubAckSequence = await publishValid(client, "sensor_42", "msg_valid_1", "1")
    try {
      await waitUntil("validated PubAck and raw ack floor", async () => {
        const stream = await manager.streams.info(ValidatedStream)
        const consumer = await manager.consumers.info(RawStream, ConsumerName)
        return stream.state.messages === 1 && consumer.num_ack_pending === 0
      })
    } catch (error) {
      const validatedInfo = await manager.streams.info(ValidatedStream)
      const deadLetterInfo = await manager.streams.info(DeadLetterStream)
      const consumerInfo = await manager.consumers.info(RawStream, ConsumerName)
      throw new Error(
        `first delivery readback: validated=${validatedInfo.state.messages}, dlq=${deadLetterInfo.state.messages}, pending=${consumerInfo.num_ack_pending}, redelivered=${consumerInfo.num_redelivered}; diagnostic=${safeErrorSummary(error)}`
      )
    }
    const validated = await manager.streams.getMessage(ValidatedStream, { seq: 1 })
    assert(validated !== null, "validated stream has no stored message")
    const validatedBody: unknown = JSON.parse(new TextDecoder().decode(validated.data))
    assert(
      validatedBody !== null &&
        typeof validatedBody === "object" &&
        "eventId" in validatedBody &&
        validatedBody.eventId === "sensor_42/msg_valid_1",
      "validated output does not carry the stable eventId"
    )
    validatedEventId = validatedBody.eventId

    phase = "dead-letter one permanently invalid message"
    const invalidBody = new TextEncoder().encode('{"schemaVersion":1}')
    const invalidAck = await client.publish("telemetry.raw.v1.sensor_42", invalidBody, {
      msgID: "msg_invalid_1",
      timeout: 500
    })
    assert(invalidAck.stream === RawStream, "invalid raw ingress lacked a real PubAck")
    await waitUntil("DLQ PubAck and raw term floor", async () => {
      const stream = await manager.streams.info(DeadLetterStream)
      const consumer = await manager.consumers.info(RawStream, ConsumerName)
      return stream.state.messages === 1 && consumer.num_ack_pending === 0
    })
    const deadLetter = await manager.streams.getMessage(DeadLetterStream, { seq: 1 })
    assert(deadLetter !== null, "DLQ has no stored message")
    dlqErrorCode = deadLetter.header.get("x-telemetry-error")
    assert(
      dlqErrorCode === "MISSING_REQUIRED_KEY" &&
        new TextDecoder().decode(deadLetter.data) === new TextDecoder().decode(invalidBody),
      "DLQ did not preserve bytes and sanitized error metadata"
    )

    phase = "recover one transient validated publish failure"
    await manager.streams.delete(ValidatedStream)
    await publishValid(client, "sensor_42", "msg_retry_1", "2")
    await waitUntil("native redelivery", async () => {
      const info = await manager.consumers.info(RawStream, ConsumerName)
      transientRedeliveries = info.num_redelivered
      return info.num_redelivered >= 1
    })
    await manager.streams.add({
      name: ValidatedStream,
      subjects: ["telemetry.validated.v1.*"],
      retention: RetentionPolicy.Limits,
      storage: StorageType.File
    })
    await waitUntil("validated stream recovery and raw ack", async () => {
      const stream = await manager.streams.info(ValidatedStream)
      const consumer = await manager.consumers.info(RawStream, ConsumerName)
      return stream.state.messages === 1 && consumer.num_ack_pending === 0
    })
    assert(
      (await manager.streams.info(DeadLetterStream)).state.messages === 1,
      "transient failure was incorrectly terminated to DLQ"
    )

    phase = "restart NATS under the live subscription"
    await docker(ownedDocker, ["stop", "--timeout", "1", NatsContainer])
    await waitUntil("official disconnect status", () => statuses.includes("disconnect"))
    await docker(ownedDocker, ["start", NatsContainer])
    await waitUntil(
      "reconnected JetStream API",
      async () => {
        await manager.streams.info(RawStream)
        return true
      },
      30_000
    )
    assert(
      statuses.includes("reconnect"),
      `official client did not report reconnect: ${statuses.join(",")}`
    )
    await publishValid(client, "sensor_42", "msg_after_restart", "3")
    await waitUntil("post-reconnect durable consumption", async () => {
      const stream = await manager.streams.info(ValidatedStream)
      const consumer = await manager.consumers.info(RawStream, ConsumerName)
      return stream.state.messages === 2 && consumer.num_ack_pending === 0
    })

    phase = "bounded drain and persistent fresh readback"
    drainDurationMs = await stopWorker(workerApp, workerRun)
    workerApp = null
    workerRun = null
    assert(drainDurationMs < 5_000, `LikeGo drain exceeded its caller budget: ${drainDurationMs}`)
    await closeNats(connection)
    connection = null
    if (statusTask !== null) await statusTask
    statusTask = null

    await docker(ownedDocker, ["restart", NatsContainer])
    connection = await connectNats(port)
    const restartedManager = await jetstreamManager(connection)
    const persistentConsumer = await restartedManager.consumers.info(RawStream, ConsumerName)
    const persistentRaw = await restartedManager.streams.info(RawStream)
    const persistentValidated = await restartedManager.streams.info(ValidatedStream)
    const persistentDeadLetter = await restartedManager.streams.info(DeadLetterStream)
    persistent =
      persistentConsumer.config.durable_name === ConsumerName &&
      persistentRaw.config.storage === StorageType.File &&
      persistentRaw.state.messages === 4 &&
      persistentValidated.config.storage === StorageType.File &&
      persistentValidated.state.messages === 2 &&
      persistentDeadLetter.config.storage === StorageType.File &&
      persistentDeadLetter.state.messages === 1
    assert(persistent, "named-volume restart did not preserve streams and durable state")

    phase = "run public start:prepared entrypoint"
    const program = Bun.spawn(["bun", "run", "start:prepared"], {
      cwd: `${import.meta.dir}/..`,
      env: {
        ...scenarioDockerEnvironment(ownedDocker),
        NATS_URL: `nats://127.0.0.1:${port}`
      },
      detached: true,
      stdout: "pipe",
      stderr: "pipe"
    })
    let programOutput = ""
    const outputTask = (async (): Promise<void> => {
      const reader = program.stdout.getReader()
      const decoder = new TextDecoder()
      for (;;) {
        const item = await reader.read()
        if (item.done) break
        programOutput += decoder.decode(item.value, { stream: true })
      }
      programOutput += decoder.decode()
    })()
    const errorTask = new Response(program.stderr).text()
    void errorTask.catch(() => {})
    let outputJoined = false
    let forced = false
    let terminationTimeout: ReturnType<typeof setTimeout> | null = null
    try {
      await waitUntil(
        "start:prepared readiness",
        () => programOutput.includes('LIKEGO_EXAMPLE_READY={"example":"iot-telemetry"'),
        30_000
      )
      await waitUntil("start:prepared durable pull request", async () => {
        return (await restartedManager.consumers.info(RawStream, ConsumerName)).num_waiting >= 1
      })
      const entryClient = jetstream(connection)
      const entryMessageId = `entry-${RunId}`
      await publishValid(entryClient, "sensor_entry", entryMessageId, "4")
      await waitUntil("start:prepared validated event", async () => {
        const stream = await restartedManager.streams.info(ValidatedStream)
        const consumer = await restartedManager.consumers.info(RawStream, ConsumerName)
        return stream.state.messages === 3 && consumer.num_ack_pending === 0
      })
      const entryValidated = await restartedManager.streams.getMessage(ValidatedStream, { seq: 3 })
      const entryPayload: unknown =
        entryValidated === null ? null : JSON.parse(new TextDecoder().decode(entryValidated.data))
      assert(
        entryPayload !== null &&
          typeof entryPayload === "object" &&
          "eventId" in entryPayload &&
          entryPayload.eventId === `sensor_entry/${entryMessageId}`,
        "start:prepared did not publish the expected validated event"
      )
      process.kill(-program.pid, "SIGTERM")
      terminationTimeout = setTimeout(() => {
        forced = true
        try {
          process.kill(-program.pid, "SIGKILL")
        } catch {
          // The process group can finish between the timeout and signal delivery.
        }
      }, 10_000)
      const exitCode = await program.exited
      await outputTask
      outputJoined = true
      clearTimeout(terminationTimeout)
      if (forced) throw new Error("start:prepared did not stop after SIGTERM")
      assert(exitCode === 0 || exitCode === 143, `start:prepared exited ${exitCode}`)
    } finally {
      if (terminationTimeout !== null) clearTimeout(terminationTimeout)
      if (!outputJoined) {
        try {
          process.kill(-program.pid, "SIGKILL")
        } catch {
          // The process group already exited.
        }
      }
      if (program.exitCode === null) {
        await program.exited
      }
      await outputTask
      await errorTask
    }
    await waitUntil("start:prepared subscription release", async () => {
      return (await restartedManager.consumers.info(RawStream, ConsumerName)).num_waiting === 0
    })
  } catch (error) {
    primary = safeFailure(`iot-telemetry E2E failed during ${phase}`, error)
  } finally {
    if (workerApp !== null && workerRun !== null) {
      try {
        await stopWorker(workerApp, workerRun)
      } catch (error) {
        cleanupFailures.push(safeFailure("telemetry worker cleanup failed", error))
      }
    }
    try {
      await closeNats(connection)
    } catch (error) {
      cleanupFailures.push(safeFailure("NATS cleanup failed", error))
    }
    if (statusTask !== null) {
      try {
        await statusTask
      } catch (error) {
        cleanupFailures.push(safeFailure("NATS status cleanup failed", error))
      }
    }
    try {
      await closeOwnedDockerContext(ownedDocker)
    } catch (error) {
      cleanupFailures.push(safeFailure("Owned Docker context cleanup failed", error))
    }
  }

  if (primary !== null || cleanupFailures.length > 0) {
    const failures = primary === null ? cleanupFailures : [primary, ...cleanupFailures]
    throw new AggregateError(failures, "iot-telemetry Docker scenario failed")
  }
}

await main()
