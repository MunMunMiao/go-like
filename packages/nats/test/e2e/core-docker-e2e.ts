import { background, canceled, withCancelCause, type Context } from "@likego/context"
import { eventBroker, type Codec } from "@likego/event"
import {
  connect,
  type Msg,
  type NatsConnection,
  type Status,
  type Subscription,
  type SubscriptionOptions
} from "@nats-io/transport-node"
import { natsCoreDrainTimeout, newNatsCoreServer } from "../../src/index"
import { newNatsCoreBroker } from "../../src/broker"

const NatsImage =
  "docker.io/library/nats:2.14.3-alpine@sha256:c11af972c99ae542de8925e6a7d9c533aa1eb039660420d2074beed6089b3bf0"
const ExpectedServerVersion = "2.14.3"
const DockerOwner = process.env.LIKEGO_E2E_OWNER
if (DockerOwner === undefined || !/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(DockerOwner))
  throw new Error("invalid LIKEGO_E2E_OWNER")
const DockerOwnerLabel = `io.likego.e2e.owner=${DockerOwner}`

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
}

interface CommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

interface ManagedSubscription {
  readonly subscription: Subscription
  readonly server: ReturnType<typeof newNatsCoreServer>
  readonly running: Promise<void>
  readonly consuming: Promise<void>
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
      throw new TypeError("invalid typed NATS event")
    }
    const id: unknown = Reflect.get(value, "id")
    const name: unknown = Reflect.get(value, "name")
    if (typeof id !== "number" || typeof name !== "string")
      throw new TypeError("invalid typed NATS event")
    return Object.freeze({ id, name })
  }
})

/** Creates a manually controlled Promise for one E2E synchronization point. */
function deferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => {}
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}

/** Cancels at the final startup acceptance check without owning a native resource. */
function cancelAtAcceptance(): Context {
  let reads = 0
  return {
    deadline: () => [new Date(0), false],
    done: () => null,
    err: () => {
      reads += 1
      return reads >= 3 ? canceled : null
    },
    value: () => undefined
  }
}

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
  timeoutMs = 10_000
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

/** Starts lifecycle ownership while the application consumes official raw messages. */
async function startManaged(
  connection: NatsConnection,
  subject: string,
  onMessage: (message: Msg) => void | Promise<void>,
  options?: SubscriptionOptions
): Promise<ManagedSubscription> {
  const subscription = connection.subscribe(subject, options)
  const server = newNatsCoreServer(subscription)
  const running = server.start(background())
  void running.catch(() => {})
  const consuming = (async () => {
    for await (const message of subscription) await onMessage(message)
  })()
  void consuming.catch(() => {})
  return { subscription, server, running, consuming }
}

/** Stops lifecycle ownership and waits for the application iterator to end. */
async function stopManaged(managed: ManagedSubscription): Promise<void> {
  await managed.server.stop(background())
  await managed.running
  await managed.consuming
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

/** Executes the fixed-digest NATS Core real-service gate. */
async function main(): Promise<void> {
  const project = `likego-nats-core-${crypto.randomUUID()}`
  const container = `${project}-server`
  const label = `likego.project=${project}`
  const prefix = crypto.randomUUID().replaceAll("-", "")
  const lateRejections: unknown[] = []
  const statuses: Status["type"][] = []
  const consumingTasks: Promise<void>[] = []
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
      NatsImage
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

    const startupSubject = `${prefix}.startup.cancel`
    const acquisition = deferred<Subscription>()
    const [startupContext, cancelStartup] = withCancelCause(background())
    const startupCause = new Error("startup canceled before native ownership transfer")
    const startup = newNatsCoreServer(() => acquisition.promise).start(startupContext)
    await Bun.sleep(0)
    cancelStartup(startupCause)
    const startupFailure = await startup.catch((error: unknown) => error)
    assert(startupFailure === startupCause, "startup cancellation replaced its exact cause")
    const lateSubscription = connection.subscribe(startupSubject)
    acquisition.resolve(lateSubscription)
    await Bun.sleep(0)
    const consumeLateTerminal = (async () => {
      for await (const _message of lateSubscription) {
        // Rollback has no data-plane work; iteration admits the native unsubscribe callback.
      }
    })()
    await consumeLateTerminal
    await lateSubscription.closed
    assert(lateSubscription.isClosed(), "late Subscription did not reach native terminal")
    const deliveryBefore = lateSubscription.getReceived()
    connection.publish(startupSubject, "must-not-deliver")
    await connection.flush()
    await Bun.sleep(50)
    assert(
      lateSubscription.getReceived() === deliveryBefore,
      "startup rollback subscription still received data"
    )
    assert(!connection.isClosed() && !connection.isDraining(), "startup rollback closed connection")

    const directStartupSubject = `${prefix}.startup.direct`
    let directDeliveries = 0
    const directSubscription = connection.subscribe(directStartupSubject, {
      callback: (error, message) => {
        if (error !== null) {
          recordLateRejection(error)
          return
        }
        if (message.string() === "application-still-owns") directDeliveries += 1
      }
    })
    const directFailure = await newNatsCoreServer(directSubscription)
      .start(cancelAtAcceptance())
      .catch((error: unknown) => error)
    assert(directFailure === canceled, "direct startup cancellation replaced its sentinel")
    const openAfterRejectedStart = !directSubscription.isClosed()
    connection.publish(directStartupSubject, "application-still-owns")
    await connection.flush()
    await waitUntil("direct Subscription after rejected startup", () => directDeliveries === 1)
    directSubscription.unsubscribe()
    await directSubscription.closed
    assert(openAfterRejectedStart, "rejected startup closed an application-owned subscription")
    assert(directSubscription.isClosed(), "application-owned subscription did not close")
    assert(!connection.isClosed() && !connection.isDraining(), "direct startup closed connection")

    const rawSubject = `${prefix}.raw`
    const rawBodies: string[] = []
    const rawSubjects: string[] = []
    const raw = await startManaged(connection, rawSubject, (message) => {
      rawBodies.push(message.string())
      rawSubjects.push(message.subject)
    })
    consumingTasks.push(raw.consuming)
    connection.publish(rawSubject, "one")
    await connection.flush()
    await waitUntil("application raw consumption", () => rawBodies.length === 1)
    await stopManaged(raw)
    assert(rawSubjects[0] === rawSubject && rawBodies[0] === "one", "raw delivery changed")
    assert(!connection.isClosed() && !connection.isDraining(), "raw subscription closed connection")

    const typedSubject = `${prefix}.typed`
    const typedEvents = eventBroker(newNatsCoreBroker(connection), typedEventCodec)
    const typedIds: number[] = []
    const typedNames: string[] = []
    const typedNativeSubjects: string[] = []
    const typedFirst = await typedEvents.subscribe(
      background(),
      typedSubject,
      (_ctx, event) => {
        const value = event.decode()
        typedIds.push(value.id)
        typedNames.push(value.name)
        typedNativeSubjects.push(event.native.subject)
      },
      { queue: "typed-workers" }
    )
    const typedSecond = await typedEvents.subscribe(
      background(),
      typedSubject,
      (_ctx, event) => {
        const value = event.decode()
        typedIds.push(value.id)
        typedNames.push(value.name)
        typedNativeSubjects.push(event.native.subject)
      },
      { queue: "typed-workers" }
    )
    for (let id = 0; id < 12; id += 1) {
      await typedEvents.publish(background(), typedSubject, { id, name: `event-${id}` })
    }
    await connection.flush()
    await waitUntil("typed queue group round trip", () => typedIds.length === 12)
    await Promise.all([typedFirst.unsubscribe(background()), typedSecond.unsubscribe(background())])
    assert(new Set(typedIds).size === 12, "typed queue group duplicated an event")
    assert(typedNames.length === 12, "typed queue group omitted decoded names")
    assert(
      typedNativeSubjects.every((subject) => subject === typedSubject),
      "typed queue group changed the native subject"
    )

    const queueSubject = `${prefix}.queue`
    const firstIds: string[] = []
    const secondIds: string[] = []
    const first = await startManaged(
      connection,
      queueSubject,
      (message) => {
        firstIds.push(message.string())
      },
      { queue: "workers" }
    )
    const second = await startManaged(
      connection,
      queueSubject,
      (message) => {
        secondIds.push(message.string())
      },
      { queue: "workers" }
    )
    consumingTasks.push(first.consuming, second.consuming)
    for (let index = 0; index < 20; index += 1) connection.publish(queueSubject, String(index))
    await connection.flush()
    await waitUntil("native queue distribution", () => firstIds.length + secondIds.length === 20)
    await Promise.all([stopManaged(first), stopManaged(second)])
    const uniqueIds = new Set([...firstIds, ...secondIds])
    assert(uniqueIds.size === 20, "queue group duplicated a delivery")
    assert(!connection.isClosed() && !connection.isDraining(), "queue group closed connection")

    const failureSubject = `${prefix}.failure`
    let observedFailures = 0
    let failedDeliveries = 0
    const postFailure: string[] = []
    const failureManaged = await startManaged(connection, failureSubject, (message) => {
      if (message.string() === "bad") {
        failedDeliveries += 1
        try {
          throw new Error("application handler failed")
        } catch {
          observedFailures += 1
        }
        return
      }
      postFailure.push(message.string())
    })
    consumingTasks.push(failureManaged.consuming)
    connection.publish(failureSubject, "bad")
    connection.publish(failureSubject, "good")
    await connection.flush()
    await waitUntil(
      "application failure isolation",
      () => observedFailures === 1 && postFailure.length === 1
    )
    await Bun.sleep(100)
    await stopManaged(failureManaged)
    assert(failedDeliveries === 1, "at-most-once handler failure redelivered")
    assert(postFailure[0] === "good", "handler failure blocked the following delivery")

    const forceSubject = `${prefix}.force`
    const forceSubscription = connection.subscribe(forceSubject)
    const forceServer = newNatsCoreServer(forceSubscription, natsCoreDrainTimeout(0))
    const forceRunning = forceServer.start(background())
    void forceRunning.catch(() => {})
    const forceConsuming = (async () => {
      for await (const _message of forceSubscription) {
        // The application owns iteration even in the force-lifecycle scenario.
      }
    })()
    void forceConsuming.catch(() => {})
    consumingTasks.push(forceConsuming)
    const forceFailure = await forceServer.stop(background()).catch((error: unknown) => error)
    assert(forceFailure instanceof Error, "zero boundary did not reject the owner waiter")
    await forceRunning.catch(() => {})
    await forceConsuming
    const borrowedConnectionOpenAfterForce = !connection.isClosed() && !connection.isDraining()
    assert(borrowedConnectionOpenAfterForce, "forced server stop closed borrowed connection")

    const reconnectSubject = `${prefix}.reconnect`
    const recovered: string[] = []
    const recoveredSubjects: string[] = []
    const reconnecting = await startManaged(connection, reconnectSubject, (message) => {
      recovered.push(message.string())
      recoveredSubjects.push(message.subject)
    })
    consumingTasks.push(reconnecting.consuming)
    await command(["docker", "stop", "--time", "1", container])
    await waitUntil(
      "official disconnect status",
      () => statuses.includes("disconnect") || statuses.includes("reconnecting")
    )
    await command(["docker", "start", container])
    await waitUntil("official reconnect status", () => statuses.includes("reconnect"), 30_000)
    connection.publish(reconnectSubject, "after-reconnect")
    await connection.flush()
    await waitUntil("application recovery", () => recovered.length === 1, 30_000)
    await stopManaged(reconnecting)
    assert(recovered[0] === "after-reconnect", "reconnect delivery body changed")
    assert(recoveredSubjects[0] === reconnectSubject, "reconnect delivery subject changed")
    assert(!connection.isClosed() && !connection.isDraining(), "reconnect closed connection")

    await Bun.sleep(50)
    assert(lateRejections.length === 0, `observed ${lateRejections.length} late rejection(s)`)
  } finally {
    await closeConnection(connection)
    await Promise.allSettled(consumingTasks)
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
