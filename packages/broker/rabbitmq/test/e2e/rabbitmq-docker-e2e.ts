import { newBrokerServer } from "@likego/broker"
import { background } from "@likego/context"
import type { Server } from "@likego/core"
import {
  connect,
  type Channel,
  type ChannelModel,
  type ConsumeMessage,
  type RecoveringChannelModel
} from "amqplib"

import { newRecoveringRabbitMqBroker } from "../../src/index"

const RabbitMqImage =
  "docker.io/library/rabbitmq:4.3.4-management-alpine@sha256:09b39ca8a3e884e91cab8842cd41264de21aab0625e1f1d016a9a3135ba590ef"
const ExpectedServerVersion = "4.3.4"
const ConcurrentPublisherConfirms = 100
const DockerOwner = process.env.LIKEGO_E2E_OWNER
if (DockerOwner === undefined || !/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(DockerOwner)) {
  throw new Error("invalid LIKEGO_E2E_OWNER")
}

interface CommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

interface DeliveryEvidence {
  readonly topic: string
  readonly body: string
  readonly trace: string
  readonly nativeConsumerTag: string
}

/** Throws when one real-service invariant is false. */
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/** Runs one command without a shell and captures its complete result. */
async function command(args: string[], allowFailure = false): Promise<CommandResult> {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ])
  if (!allowFailure && exitCode !== 0) {
    throw new Error(`${args.join(" ")} failed (${exitCode}): ${stderr.trim()}`)
  }
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode }
}

/** Reserves and releases one loopback port for Docker publication. */
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

/** Creates a manually controlled Promise for one delivery. */
function deliveryBarrier(): {
  readonly promise: Promise<DeliveryEvidence>
  resolve(value: DeliveryEvidence): void
} {
  let resolvePromise: (value: DeliveryEvidence) => void = () => {}
  const promise = new Promise<DeliveryEvidence>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}

/** Waits for the fixed container to report RabbitMQ health. */
async function waitForHealth(container: string, stage: string): Promise<void> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const result = await command(
      [
        "docker",
        "exec",
        "--user",
        "rabbitmq",
        container,
        "rabbitmq-diagnostics",
        "-q",
        "-t",
        "2",
        "check_running"
      ],
      true
    )
    if (result.exitCode === 0) return
    await Bun.sleep(100)
  }
  const state = await command(["docker", "inspect", "--format", "{{json .State}}", container], true)
  const logs = await command(["docker", "logs", "--tail", "80", container], true)
  throw new Error(`RabbitMQ container did not become healthy during ${stage}`, {
    cause: { state: state.stdout, logs: logs.stderr || logs.stdout }
  })
}

/** Waits until one real-service condition becomes observable. */
async function waitUntil(
  label: string,
  predicate: () => boolean,
  timeoutMs = 30_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await Bun.sleep(500)
  }
  throw new Error(`timed out waiting for ${label}`)
}

/** Bounds one asynchronous assertion without retaining its losing timeout. */
async function within<T>(label: string, operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 30_000)
  })
  try {
    return await Promise.race([operation, timeout])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/** Resolves after the official recovering model completes its next setup generation. */
function nextConnect(connection: RecoveringChannelModel): Promise<void> {
  return new Promise<void>((resolve) => {
    connection.once("connect", () => resolve())
  })
}

/** Waits until one real queue exposes the expected consumer count. */
async function waitForConsumerCount(
  container: string,
  queue: string,
  expected: number
): Promise<number> {
  const deadline = Date.now() + 30_000
  let attempts = 0
  let lastExitCode = -1
  let lastRows = "not observed"
  let lastStderr = ""
  while (Date.now() < deadline) {
    attempts += 1
    const result = await command(
      [
        "docker",
        "exec",
        "--user",
        "rabbitmq",
        container,
        "rabbitmqctl",
        "-q",
        "list_queues",
        "name",
        "consumers",
        "--formatter",
        "json"
      ],
      true
    )
    lastExitCode = result.exitCode
    lastStderr = result.stderr
    if (result.exitCode === 0) {
      let rows: unknown = null
      try {
        rows = JSON.parse(result.stdout)
        lastRows = JSON.stringify(rows)
      } catch {
        lastRows = result.stdout
      }
      if (Array.isArray(rows)) {
        for (const row of rows) {
          if (typeof row !== "object" || row === null) continue
          const name: unknown = Reflect.get(row, "name")
          const consumers: unknown = Reflect.get(row, "consumers")
          if (name === queue && consumers === expected) return consumers
        }
      }
    }
    await Bun.sleep(50)
  }
  throw new Error(
    `timed out waiting for ${queue} consumer count ${expected}; attempts=${attempts}; ` +
      `lastExitCode=${lastExitCode}; lastRows=${lastRows}; lastStderr=${lastStderr}`
  )
}

/** Executes the fixed-digest RabbitMQ provider E2E. */
async function main(): Promise<void> {
  const project = `likego-rabbitmq-${crypto.randomUUID()}`
  const container = `${project}-server`
  const projectLabel = `likego.project=${project}`
  const ownerLabel = `io.likego.e2e.owner=${DockerOwner}`
  const port = allocateHostPort()
  const queue = `${project}.queue`
  const terminalQueue = `${project}.terminal.queue`
  const exchange = `${project}.exchange`
  const routingKey = "orders.created"
  const terminalRoutingKey = "orders.terminal"
  const deliveries: DeliveryEvidence[] = []
  const lateRejections: unknown[] = []
  const connectionErrors: Error[] = []
  let model: RecoveringChannelModel | null = null
  let probe: Channel | null = null
  let terminalServer: Server | null = null
  let containerPaused = false
  let serverVersion = ""
  let confirmGenerations = 0
  let initialConfirmAck = false
  let recoveredGenerationAck = false
  let pendingCloseRejected = false
  let concurrentConfirmed = 0
  let flowControlAccepted = 0
  let flowControlBackpressured = 0
  let consumerCountAfterRecovery = -1
  let consumerCountAfterBasicCancel = -1
  let terminalConsumerCountAfterFailure = -1
  let terminalFailureObserved = false
  let consumerCountAfterUnsubscribe = -1
  let consumerCountAfterUnsubscribeRecovery = -1
  let cleanupVerified = false

  /** Records any process-level late rejection as a release-gate failure. */
  const recordLateRejection = (reason: unknown): void => {
    lateRejections.push(reason)
  }
  process.on("unhandledRejection", recordLateRejection)

  try {
    await command([
      "docker",
      "run",
      "--detach",
      "--name",
      container,
      "--label",
      projectLabel,
      "--label",
      ownerLabel,
      "--env",
      `RABBITMQ_ERLANG_COOKIE=${project.replaceAll("-", "")}`,
      "--publish",
      `127.0.0.1:${port}:5672`,
      RabbitMqImage
    ])
    await waitForHealth(container, "initial boot")
    serverVersion = (
      await command(["docker", "exec", container, "rabbitmq-diagnostics", "-q", "server_version"])
    ).stdout
    assert(serverVersion === ExpectedServerVersion, `unexpected RabbitMQ version ${serverVersion}`)

    const url = `amqp://guest:guest@127.0.0.1:${port}/%2f`
    const provider = await newRecoveringRabbitMqBroker(background(), (setup) =>
      connect(url, {
        recovery: {
          initialDelay: 100,
          maxDelay: 1_000,
          factor: 1.5,
          jitter: 0,
          async setup(generationModel: ChannelModel) {
            confirmGenerations += 1
            await setup(generationModel)
          }
        }
      })
    )
    model = provider.connection
    model.on("error", (error) => connectionErrors.push(error))
    const broker = provider.broker
    const subscriber = await broker.subscribe(
      background(),
      routingKey,
      (_ctx, event) => {
        const native: ConsumeMessage = event.native
        const trace = event.message.headers.trace ?? ""
        broker.ack(native)
        deliveries.push({
          topic: event.topic,
          body: new TextDecoder().decode(event.message.body),
          trace,
          nativeConsumerTag: native.fields.consumerTag
        })
      },
      {
        exchange: {
          name: exchange,
          type: "topic",
          options: { durable: true, autoDelete: false }
        },
        queue: {
          name: queue,
          options: { durable: true, exclusive: false, autoDelete: false }
        },
        routingKey,
        prefetch: { count: 1 },
        consume: { noAck: false }
      }
    )
    const accepted = await broker.publish(
      background(),
      routingKey,
      {
        headers: { trace: "docker-e2e" },
        body: new TextEncoder().encode("rabbitmq-real-delivery")
      },
      {
        exchange,
        routingKey,
        properties: {
          contentType: "text/plain",
          persistent: false,
          messageId: project
        }
      }
    )
    assert(typeof accepted === "boolean", "publish did not return native flow-control status")
    initialConfirmAck = true
    await waitUntil("first real RabbitMQ delivery", () => deliveries.length === 1)
    assert(deliveries[0]?.topic === routingKey, "delivery routing key changed")
    assert(deliveries[0]?.body === "rabbitmq-real-delivery", "delivery body changed")
    assert(deliveries[0]?.trace === "docker-e2e", "delivery header changed")

    const concurrentPublishes: Array<Promise<boolean>> = []
    for (let index = 0; index < ConcurrentPublisherConfirms; index += 1) {
      concurrentPublishes.push(
        broker.publish(background(), `${project}.confirm.${index}`, {
          headers: {},
          body: new TextEncoder().encode(`confirm-${index}`)
        })
      )
    }
    const concurrentResults = await within(
      "concurrent publisher confirms",
      Promise.all(concurrentPublishes)
    )
    concurrentConfirmed = concurrentResults.length
    for (const result of concurrentResults) {
      if (result) flowControlAccepted += 1
      else flowControlBackpressured += 1
    }
    assert(
      concurrentConfirmed === ConcurrentPublisherConfirms,
      "concurrent publisher confirm evidence missing"
    )

    probe = await model.createChannel()
    await probe.deleteQueue(queue)
    await probe.close()
    probe = null
    consumerCountAfterBasicCancel = await waitForConsumerCount(container, queue, 1)
    await broker.publish(
      background(),
      routingKey,
      {
        headers: { trace: "docker-basic-cancel" },
        body: new TextEncoder().encode("rabbitmq-basic-cancel-recovered")
      },
      { exchange, routingKey, properties: { messageId: `${project}-basic-cancel` } }
    )
    await waitUntil("basic.cancel recovered delivery", () => deliveries.length === 2)
    assert(
      deliveries[1]?.body === "rabbitmq-basic-cancel-recovered",
      "basic.cancel recovery body changed"
    )

    const terminalFailure = new Error("real RabbitMQ handler failed")
    terminalServer = newBrokerServer(
      broker,
      terminalRoutingKey,
      () => {
        throw terminalFailure
      },
      {
        exchange: {
          name: exchange,
          type: "topic",
          options: { durable: true, autoDelete: false }
        },
        queue: {
          name: terminalQueue,
          options: { durable: true, exclusive: false, autoDelete: false }
        },
        routingKey: terminalRoutingKey,
        prefetch: { count: 1 },
        consume: { noAck: false }
      }
    )
    const terminalRunning = terminalServer.start(background())
    await waitForConsumerCount(container, terminalQueue, 1)
    await broker.publish(
      background(),
      terminalRoutingKey,
      { headers: {}, body: new TextEncoder().encode("trigger-terminal") },
      { exchange, routingKey: terminalRoutingKey }
    )
    const terminalOutcome = await within(
      "Broker Server terminal",
      terminalRunning.catch((value: unknown) => value)
    )
    assert(
      terminalOutcome === terminalFailure,
      "Server.start did not preserve handler Error identity"
    )
    terminalFailureObserved = true
    const terminalStopOutcome = await terminalServer
      .stop(background())
      .catch((value: unknown) => value)
    assert(terminalStopOutcome === terminalFailure, "Server.stop did not preserve terminal failure")
    terminalConsumerCountAfterFailure = await waitForConsumerCount(container, terminalQueue, 0)

    await command(["docker", "pause", container])
    containerPaused = true
    const pendingPublish = broker.publish(background(), `${project}.pending-close`, {
      headers: {},
      body: new TextEncoder().encode("pending-close")
    })
    const pendingOutcome = pendingPublish.catch((value: unknown) => value)
    let pendingSettled = false
    void pendingPublish.then(
      () => {
        pendingSettled = true
      },
      () => {
        pendingSettled = true
      }
    )
    await Bun.sleep(100)
    assert(!pendingSettled, "publisher confirm settled while RabbitMQ was paused")

    const firstRecovery = nextConnect(model)
    await command(["docker", "kill", container])
    containerPaused = false
    const pendingFailure = await within("pending publisher confirm close", pendingOutcome)
    assert(pendingFailure instanceof Error, "pending publisher confirm did not reject on close")
    pendingCloseRejected = true

    await command(["docker", "start", container])
    await waitForHealth(container, "publisher confirm restart")
    await within("first recovered setup", firstRecovery)
    assert(confirmGenerations >= 2, "recovery did not create a new confirm generation")
    probe = await model.createChannel()
    consumerCountAfterRecovery = (await probe.checkQueue(queue)).consumerCount
    assert(consumerCountAfterRecovery === 1, "recovery did not rebuild exactly one consumer")
    await probe.close()
    probe = null
    await broker.publish(
      background(),
      routingKey,
      {
        headers: { trace: "docker-recovered" },
        body: new TextEncoder().encode("rabbitmq-recovered-delivery")
      },
      { exchange, routingKey, properties: { messageId: `${project}-recovered` } }
    )
    recoveredGenerationAck = true
    await waitUntil("recovered RabbitMQ delivery", () => deliveries.length === 3)
    assert(deliveries[2]?.body === "rabbitmq-recovered-delivery", "recovered body changed")
    assert(deliveries[2]?.trace === "docker-recovered", "recovered header changed")

    await subscriber.unsubscribe(background())
    probe = await model.createChannel()
    const queueState = await probe.checkQueue(queue)
    consumerCountAfterUnsubscribe = queueState.consumerCount
    assert(consumerCountAfterUnsubscribe === 0, "consumer remained after unsubscribe")
    await probe.close()
    probe = null

    const secondRecovery = nextConnect(model)
    await command(["docker", "restart", container])
    await waitForHealth(container, "second restart")
    await within("second recovered setup", secondRecovery)
    probe = await model.createChannel()
    consumerCountAfterUnsubscribeRecovery = (await probe.checkQueue(queue)).consumerCount
    assert(
      consumerCountAfterUnsubscribeRecovery === 0,
      "unsubscribed consumer revived after recovery"
    )
    assert(deliveries.length === 3, "recovery produced a duplicate delivery")
    await probe.deleteQueue(queue)
    await probe.deleteQueue(terminalQueue)
    await probe.deleteExchange(exchange)
  } finally {
    if (containerPaused) {
      const unpaused = await command(["docker", "unpause", container], true)
      if (unpaused.exitCode !== 0) {
        await command(["docker", "rm", "--force", "--volumes", container], true)
      }
      containerPaused = false
    }
    if (probe !== null) {
      try {
        await probe.close()
      } catch {}
    }
    if (terminalServer !== null) {
      try {
        await terminalServer.stop(background())
      } catch {}
    }
    if (model !== null) {
      try {
        await model.close()
      } catch {}
    }
    await command(["docker", "rm", "--force", "--volumes", container], true)
    const inspected = await command(["docker", "inspect", container], true)
    const remaining = await command([
      "docker",
      "ps",
      "--all",
      "--quiet",
      "--filter",
      `label=${projectLabel}`
    ])
    cleanupVerified = inspected.exitCode !== 0 && remaining.stdout.length === 0
    await Bun.sleep(50)
    process.off("unhandledRejection", recordLateRejection)
  }

  assert(cleanupVerified, "RabbitMQ container cleanup readback failed")
  assert(lateRejections.length === 0, "late unhandled rejection observed")
  assert(deliveries.length === 3, "delivery evidence missing")
  assert(initialConfirmAck && recoveredGenerationAck, "publisher ack evidence missing")
  assert(pendingCloseRejected, "pending publisher close evidence missing")
  assert(concurrentConfirmed === ConcurrentPublisherConfirms, "concurrent confirm evidence missing")
}

await main()
