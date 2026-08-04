import {
  newClient,
  withDiscovery,
  withFilter,
  withSelector,
  withTransport,
  type Client
} from "@go-like/client"
import { background, withTimeout, type Context } from "@go-like/context"
import {
  id,
  metadata,
  name,
  newApp,
  registrar,
  server as appServer,
  version,
  type App,
  type Endpointer,
  type Server as LifecycleServer
} from "@go-like/core"
import {
  filterLabel,
  newRoundRobinSelector,
  type Registrar,
  type SelectionDone,
  type SelectionOutcome,
  type Selector,
  type ServiceEndpoint,
  type ServiceInstance,
  type Watcher
} from "@go-like/registry"
import { newConsulRegistry, type ConsulFetch } from "@go-like/registry-consul"
import {
  address as serverAddress,
  handler,
  newServer,
  transport as serverTransport
} from "@go-like/server"
import {
  type Client as TransportClient,
  type DialOption,
  type Listener,
  type ListenOption,
  type Message,
  type Option,
  type Options,
  type Transport
} from "@go-like/transport"
import { executor, type HTTPExecutor } from "@go-like/transport-http"
import { newNodeHTTPTransport } from "@go-like/transport-http/node"

const Image =
  "hashicorp/consul:2.0.2@sha256:7dcf35d6b2682831094f1680aa58be214134969505acce0a9b280249581aa7d2"
const Marker = "Go-Like-Service-Instance=1"
const Session = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`
const ContainerName = `go-like-registry-transport-${Session}`
const NetworkName = `go-like-registry-transport-${Session}`
const DockerOwner = process.env.GO_LIKE_E2E_OWNER
if (DockerOwner === undefined || !/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(DockerOwner)) {
  throw new Error("invalid GO_LIKE_E2E_OWNER")
}
const DockerOwnerLabel = `io.go-like.e2e.owner=${DockerOwner}`
const ServiceName = `go-like-call-${Session}`
const OperationEndpoint = "Get"
const DeregisterProbeEndpoint = "DeregisterProbe"
const Encoder = new TextEncoder()
const Decoder = new TextDecoder()
const RequestMessage: Message = Object.freeze({
  header: Object.freeze({}),
  body: Encoder.encode("request")
})

interface CommandResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

interface NodeState {
  readonly calls: Record<"a" | "b", number>
  readonly deregisterProbes: Record<"a" | "b", number>
  activeHandlers: number
}

interface SelectionTracker {
  issued: number
  feedbackCalls: number
  duplicateFeedbackCalls: number
  probeSnapshot: boolean
  snapshot: string
}

interface TransportTracker {
  binds: number
  dialedClients: number
  clientsWithClose: number
  closeCalls: number
  duplicateCloseCalls: number
}

/** Fails one real scenario when its observed invariant is false. */
function ensure(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

/** Preserves native Error identity and normalizes one untrusted rejection boundary. */
function errorValue(value: unknown, message: string): Error {
  return value instanceof Error ? value : new Error(message, { cause: value })
}

/** Executes one Docker command and returns complete captured diagnostics. */
async function docker(values: readonly string[], allowFailure = false): Promise<CommandResult> {
  const child = Bun.spawn(["docker", ...values], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ])
  if (!allowFailure && code !== 0) {
    throw new Error(`docker ${values[0] ?? "command"} failed: ${stderr.trim()}`)
  }
  return Object.freeze({ code, stdout: stdout.trim(), stderr: stderr.trim() })
}

/** Reads the exact dynamic host port assigned to Consul HTTP. */
async function mappedPort(name: string): Promise<number> {
  const result = await docker(["port", name, "8500/tcp"])
  const match = /:([0-9]+)$/.exec(result.stdout)
  if (match?.[1] === undefined) throw new Error("Docker did not publish the Consul HTTP port")
  return Number(match[1])
}

/** Waits for the real Consul Agent self endpoint with a bounded deadline. */
async function ready(address: string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${address}/v1/agent/self`)
      await response.body?.cancel()
      if (response.ok) return
    } catch {
      // Docker can publish a port before the Consul HTTP listener accepts traffic.
    }
    await Bun.sleep(100)
  }
  throw new Error("Consul Agent did not become ready within 30 seconds")
}

/** Returns exact go-like-managed Agent service IDs from a real Consul readback. */
async function managedRemoteIds(address: string, serviceName: string | null): Promise<string[]> {
  const response = await fetch(`${address}/v1/agent/services`)
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`Consul Agent services readback returned ${response.status}`)
  }
  const value: unknown = await response.json()
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Consul Agent services readback was not an object")
  }
  const ids: string[] = []
  for (const [remoteId, carrier] of Object.entries(value)) {
    if (typeof carrier !== "object" || carrier === null || Array.isArray(carrier)) continue
    const tags = Object.getOwnPropertyDescriptor(carrier, "Tags")?.value
    const nameValue = Object.getOwnPropertyDescriptor(carrier, "Service")?.value
    if (!Array.isArray(tags) || !tags.includes(Marker)) continue
    if (serviceName === null || nameValue === serviceName) ids.push(remoteId)
  }
  return ids.sort()
}

/** Waits until a real Consul Agent exposes the exact managed service count. */
async function waitManagedRemoteCount(
  address: string,
  serviceName: string,
  expected: number,
  residentFailure: (() => Error | null) | null = null
): Promise<string[]> {
  const deadline = Date.now() + 10_000
  let ids = await managedRemoteIds(address, serviceName)
  while (ids.length !== expected && Date.now() < deadline) {
    const failure = residentFailure?.()
    if (failure !== null && failure !== undefined) throw failure
    await Bun.sleep(25)
    ids = await managedRemoteIds(address, serviceName)
  }
  if (ids.length !== expected) {
    throw new Error(
      `Consul Agent exposed ${String(ids.length)} ${serviceName} services; expected ${String(expected)}`
    )
  }
  return ids
}

/** Completes a callable standard Fetch executor with the runtime-specific static surface. */
function httpExecutor(
  run: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
): HTTPExecutor {
  return Object.assign(run, {
    preconnect(): void {}
  })
}

/** Wraps round-robin selection to retain exact node and feedback evidence. */
function trackedSelector(
  base: Selector,
  selections: string[],
  outcomes: SelectionOutcome[],
  tracker: SelectionTracker,
  snapshotObserved: Error
): Selector {
  return Object.freeze({
    select(
      ctx: Context,
      instances: readonly ServiceInstance[]
    ): readonly [ServiceEndpoint, SelectionDone] {
      tracker.snapshot = instances.map((instance) => instance.id).join(",")
      if (tracker.probeSnapshot) throw snapshotObserved
      const selected = base.select(ctx, instances)
      selections.push(selected[0].instance.id)
      tracker.issued += 1
      let feedbackCalls = 0
      const complete: SelectionDone = function complete(feedbackContext, outcome): void {
        feedbackCalls += 1
        tracker.feedbackCalls += 1
        if (feedbackCalls > 1) tracker.duplicateFeedbackCalls += 1
        outcomes.push(outcome)
        selected[1](feedbackContext, outcome)
      }
      return Object.freeze([selected[0], complete])
    }
  })
}

/** Wraps Transport bind, dial, and close while retaining the current public contract. */
function trackedTransport(base: Transport, tracker: TransportTracker): Transport {
  return Object.freeze({
    kind(): string {
      return base.kind?.() ?? "http"
    },
    init(...options: readonly Option[]): void {
      base.init(...options)
    },
    options(): Options {
      return base.options()
    },
    async dial(
      ctx: Context,
      address: string,
      ...options: readonly DialOption[]
    ): Promise<TransportClient> {
      const client = await base.dial(ctx, address, ...options)
      tracker.dialedClients += 1
      let closeCalls = 0
      return Object.freeze({
        recv(operationContext: Context) {
          return client.recv(operationContext)
        },
        send(operationContext: Context, message: Message) {
          return client.send(operationContext, message)
        },
        async close(operationContext: Context): Promise<void> {
          closeCalls += 1
          tracker.closeCalls += 1
          if (closeCalls === 1) tracker.clientsWithClose += 1
          else tracker.duplicateCloseCalls += 1
          await client.close(operationContext)
        },
        local(): string {
          return client.local()
        },
        remote(): string {
          return client.remote()
        }
      })
    },
    listen(ctx: Context, address: string, ...options: readonly ListenOption[]): Promise<Listener> {
      tracker.binds += 1
      return base.listen(ctx, address, ...options)
    },
    string(): string {
      return base.string()
    }
  })
}

/** Records current Server bind, start, and stop phases without adding lifecycle ownership. */
function observedServer(
  label: "a" | "b",
  subject: LifecycleServer & Endpointer,
  events: string[]
): LifecycleServer & Endpointer {
  return Object.freeze({
    async endpoint(ctx: Context): Promise<string> {
      const value = await subject.endpoint(ctx)
      events.push(`bind:${label}`)
      return value
    },
    async start(ctx: Context): Promise<void> {
      events.push(`start:${label}`)
      await subject.start(ctx)
    },
    async stop(ctx: Context): Promise<void> {
      events.push(`stop:${label}`)
      await subject.stop(ctx)
    }
  })
}

/** Records current Registry void operations while preserving exact ServiceInstance identity. */
function observedRegistrar(
  label: "a" | "b",
  subject: Registrar,
  events: string[],
  voidResults: boolean[],
  beforeDeregister: (ctx: Context, instance: ServiceInstance) => Promise<void>
): Registrar {
  return Object.freeze({
    async register(ctx: Context, instance: ServiceInstance): Promise<void> {
      events.push(`register:${label}`)
      const result = await subject.register(ctx, instance)
      voidResults.push(result === undefined)
    },
    async deregister(ctx: Context, instance: ServiceInstance): Promise<void> {
      events.push(`deregister:${label}`)
      await beforeDeregister(ctx, instance)
      const result = await subject.deregister(ctx, instance)
      voidResults.push(result === undefined)
    }
  })
}

/** Creates one current unary Server for a single application instance. */
function serviceServer(
  node: "a" | "b",
  transport: Transport,
  state: NodeState
): LifecycleServer & Endpointer {
  return newServer(
    serverTransport(transport),
    serverAddress("127.0.0.1:0"),
    handler(ServiceName, OperationEndpoint, async function handle(): Promise<Message> {
      state.activeHandlers += 1
      state.calls[node] += 1
      try {
        return Object.freeze({
          header: Object.freeze({ "Go-Like-Node": node }),
          body: Encoder.encode(node)
        })
      } finally {
        state.activeHandlers -= 1
      }
    }),
    handler(ServiceName, DeregisterProbeEndpoint, async function probe(): Promise<Message> {
      state.deregisterProbes[node] += 1
      return Object.freeze({
        header: Object.freeze({ "Go-Like-Node": node }),
        body: Encoder.encode(node)
      })
    })
  )
}

/** Calls one still-registered endpoint through real Consul discovery and HTTP Transport. */
async function probeBeforeDeregister(
  ctx: Context,
  node: "a" | "b",
  instance: ServiceInstance,
  registry: ReturnType<typeof newConsulRegistry>,
  transport: Transport,
  probes: string[]
): Promise<void> {
  ensure(instance.id === node, `deregister probe received unexpected instance ${instance.id}`)
  const probeClient = newClient(
    withDiscovery(registry),
    withSelector(newRoundRobinSelector()),
    withTransport(transport)
  )
  try {
    const response = await probeClient.call(
      ctx,
      {
        service: ServiceName,
        endpoint: DeregisterProbeEndpoint,
        message: RequestMessage
      },
      withFilter(filterLabel("node", node))
    )
    ensure(Decoder.decode(response.body) === node, `deregister probe did not reach node ${node}`)
    probes.push(node)
  } finally {
    await probeClient.close(background())
  }
}

/** Creates one Core App that owns a current unary Server and Registry lifecycle. */
function serviceApp(
  node: "a" | "b",
  server: LifecycleServer & Endpointer,
  registry: Registrar,
  events: string[],
  voidResults: boolean[],
  beforeDeregister: (ctx: Context, instance: ServiceInstance) => Promise<void>
): App {
  return newApp(
    id(node),
    name(ServiceName),
    version("v1"),
    metadata({ node }),
    registrar(observedRegistrar(node, registry, events, voidResults, beforeDeregister)),
    appServer(observedServer(node, server, events))
  )
}

/** Waits for one complete Registry watcher replacement snapshot. */
async function nextSnapshot(watcher: Watcher): Promise<readonly ServiceInstance[]> {
  const timed = withTimeout(background(), 10_000)
  try {
    return await watcher.next(timed[0])
  } finally {
    timed[1]()
  }
}

/** Stops one Core App and joins its resident run without duplicating Error identities. */
async function stopApplication(app: App, running: Promise<void>): Promise<void> {
  const failures: Error[] = []
  try {
    await app.stop()
  } catch (value) {
    failures.push(errorValue(value, "App stop rejected with a non-Error value"))
  }
  try {
    await running
  } catch (value) {
    const failure = errorValue(value, "App run rejected with a non-Error value")
    if (!failures.includes(failure)) failures.push(failure)
  }
  if (failures.length === 1 && failures[0] !== undefined) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, "App stop and run failed")
}

/** Proves one previously owned HTTP authority can be rebound and closed. */
async function portReleased(address: string): Promise<boolean> {
  const transport = newNodeHTTPTransport()
  const listener = await transport.listen(background(), address)
  try {
    return listener.addr() === address
  } finally {
    await listener.close(background())
  }
}

const nodeState: NodeState = {
  calls: { a: 0, b: 0 },
  deregisterProbes: { a: 0, b: 0 },
  activeHandlers: 0
}
const selectionTracker: SelectionTracker = {
  issued: 0,
  feedbackCalls: 0,
  duplicateFeedbackCalls: 0,
  probeSnapshot: false,
  snapshot: ""
}
const clientSnapshotObserved = new Error("client discovery snapshot observed")
const transportTracker: TransportTracker = {
  binds: 0,
  dialedClients: 0,
  clientsWithClose: 0,
  closeCalls: 0,
  duplicateCloseCalls: 0
}
const selections: string[] = []
const feedbackOutcomes: SelectionOutcome[] = []
const lifecycleEvents: string[] = []
const registryVoidResults: boolean[] = []
const deregisterProbeNodes: string[] = []
const cleanupFailures: Error[] = []
const boundAddresses: string[] = []
let unhandledRejections = 0
let containerStarted = false
let networkCreated = false
let consulAddress = ""
let consulVersion = ""
let registry: ReturnType<typeof newConsulRegistry> | null = null
let watcher: Watcher | null = null
let appA: App | null = null
let appB: App | null = null
let appARunning: Promise<void> | null = null
let appBRunning: Promise<void> | null = null
let client: Client | null = null
let appARunFailure: Error | null = null
let appBRunFailure: Error | null = null
let appAStopped = false
let appBStopped = false
let appRunsSettled = false
let watcherStopped = false
let httpPortsReleased = false
let remainingProviderRegistrations = 0
let remainingContainers = 0
let remainingNetworks = 0
let primaryFailure: Error | null = null

/** Counts process-level unhandled rejections without retaining their private values. */
function unhandledRejection(): void {
  unhandledRejections += 1
}

process.on("unhandledRejection", unhandledRejection)

try {
  await docker([
    "network",
    "create",
    "--label",
    "go-like.suite=registry-transport-consul",
    "--label",
    `go-like.run=${Session}`,
    "--label",
    DockerOwnerLabel,
    NetworkName
  ])
  networkCreated = true
  await docker([
    "run",
    "--detach",
    "--name",
    ContainerName,
    "--network",
    NetworkName,
    "--label",
    "go-like.suite=registry-transport-consul",
    "--label",
    `go-like.run=${Session}`,
    "--label",
    DockerOwnerLabel,
    "--tmpfs",
    "/consul/data:rw,size=64m",
    "--publish",
    "127.0.0.1::8500",
    Image,
    "agent",
    "-dev",
    "-client=0.0.0.0",
    "-log-level=warn"
  ])
  containerStarted = true
  consulAddress = `http://127.0.0.1:${await mappedPort(ContainerName)}`
  await ready(consulAddress)
  const imageReference = (await docker(["inspect", "--format", "{{.Config.Image}}", ContainerName]))
    .stdout
  ensure(imageReference === Image, "Consul image reference drifted")
  consulVersion = (await docker(["exec", ContainerName, "consul", "version"])).stdout
  ensure(consulVersion.includes("Consul v2.0.2"), "Consul version drifted")

  const consulFetch: ConsulFetch = async function trackedConsulFetch(input, init) {
    return await fetch(input, init)
  }
  const selectedRegistry = newConsulRegistry({
    fetch: consulFetch,
    address: consulAddress,
    waitMs: 500,
    minimumQueryIntervalMs: 20,
    retryInitialMs: 50,
    retryMaximumMs: 200,
    deregisterCriticalServiceAfterMs: 60_000
  })
  registry = selectedRegistry
  const trackedFetch = httpExecutor(async function trackedHTTPFetch(input, init) {
    return await fetch(input, init)
  })
  const transport = trackedTransport(newNodeHTTPTransport(executor(trackedFetch)), transportTracker)
  const probeTransport = newNodeHTTPTransport()
  const serverA = serviceServer("a", transport, nodeState)
  const serverB = serviceServer("b", transport, nodeState)
  appA = serviceApp(
    "a",
    serverA,
    selectedRegistry,
    lifecycleEvents,
    registryVoidResults,
    (ctx, instance) =>
      probeBeforeDeregister(
        ctx,
        "a",
        instance,
        selectedRegistry,
        probeTransport,
        deregisterProbeNodes
      )
  )
  appB = serviceApp(
    "b",
    serverB,
    selectedRegistry,
    lifecycleEvents,
    registryVoidResults,
    (ctx, instance) =>
      probeBeforeDeregister(
        ctx,
        "b",
        instance,
        selectedRegistry,
        probeTransport,
        deregisterProbeNodes
      )
  )

  appARunning = appA.run()
  void appARunning.then(
    () => {
      appARunFailure = new Error("App a run returned before stop")
    },
    (value: unknown) => {
      appARunFailure = errorValue(value, "App a run rejected with a non-Error value")
    }
  )
  await waitManagedRemoteCount(consulAddress, ServiceName, 1, () => appARunFailure)
  appBRunning = appB.run()
  void appBRunning.then(
    () => {
      appBRunFailure = new Error("App b run returned before stop")
    },
    (value: unknown) => {
      appBRunFailure = errorValue(value, "App b run rejected with a non-Error value")
    }
  )
  const rawRegistrations = (
    await waitManagedRemoteCount(consulAddress, ServiceName, 2, () => appBRunFailure)
  ).length

  const endpointA = appA.endpoint()[0]
  const endpointB = appB.endpoint()[0]
  ensure(endpointA !== undefined && endpointB !== undefined, "Apps did not publish bound endpoints")
  ensure(endpointA !== endpointB, "Apps published the same HTTP endpoint")
  boundAddresses.push(new URL(endpointA).host, new URL(endpointB).host)

  const discovered = await registry.getService(background(), ServiceName)
  const discoveredNodes = discovered.map((instance) => instance.id)
  ensure(discoveredNodes.join(",") === "a,b", "Consul discovery did not return nodes a,b")
  const discoveredEndpoints = discovered.map((instance) => instance.endpoints[0])
  const boundEndpointsMatchRegistry =
    discoveredEndpoints[0] === endpointA && discoveredEndpoints[1] === endpointB
  ensure(boundEndpointsMatchRegistry, "Consul discovery changed the bound App endpoints")

  watcher = await registry.watch(background(), ServiceName)
  const initialSnapshot = await nextSnapshot(watcher)
  const watcherInitialNodes = initialSnapshot.map((instance) => instance.id).join(",")
  ensure(watcherInitialNodes === "a,b", "Consul watcher initial snapshot omitted one node")

  const selector = trackedSelector(
    newRoundRobinSelector(),
    selections,
    feedbackOutcomes,
    selectionTracker,
    clientSnapshotObserved
  )
  client = newClient(withDiscovery(registry), withSelector(selector), withTransport(transport))
  const roundRobin: string[] = []
  for (let index = 0; index < 4; index += 1) {
    const response = await client.call(background(), {
      service: ServiceName,
      endpoint: OperationEndpoint,
      message: RequestMessage
    })
    roundRobin.push(Decoder.decode(response.body))
  }
  const roundRobinSequence = roundRobin.join(",")
  ensure(roundRobinSequence === "a,b,a,b", "round-robin unary sequence was not a,b,a,b")
  ensure(selections.join(",") === roundRobinSequence, "selector and unary responses diverged")

  await stopApplication(appA, appARunning)
  appA = null
  appARunning = null
  appAStopped = true
  const registrationsAfterFirstDeregister = (
    await waitManagedRemoteCount(consulAddress, ServiceName, 1)
  ).length
  const replacement = await nextSnapshot(watcher)
  const watcherAfterDeregister = replacement.map((instance) => instance.id).join(",")
  ensure(watcherAfterDeregister === "b", "Consul watcher did not converge to node b")
  const clientSnapshotDeadline = Date.now() + 10_000
  selectionTracker.probeSnapshot = true
  try {
    while (selectionTracker.snapshot !== "b") {
      try {
        await client.call(background(), {
          service: ServiceName,
          endpoint: OperationEndpoint,
          message: RequestMessage
        })
      } catch (value) {
        if (value !== clientSnapshotObserved) throw value
      }
      if (selectionTracker.snapshot === "b") break
      if (Date.now() >= clientSnapshotDeadline) {
        throw new Error(
          `Client discovery snapshot remained ${selectionTracker.snapshot || "empty"}; expected b`
        )
      }
      await Bun.sleep(10)
    }
  } finally {
    selectionTracker.probeSnapshot = false
  }
  const postDeregister = await client.call(background(), {
    service: ServiceName,
    endpoint: OperationEndpoint,
    message: RequestMessage
  })
  const postDeregisterNode = Decoder.decode(postDeregister.body)
  ensure(postDeregisterNode === "b", "post-deregister unary call did not select node b")

  await watcher.stop(background())
  watcher = null
  watcherStopped = true
  await client.close(background())
  client = null
  await stopApplication(appB, appBRunning)
  appB = null
  appBRunning = null
  appBStopped = true
  appRunsSettled = true
  const registrationsAfterSecondDeregister = (
    await waitManagedRemoteCount(consulAddress, ServiceName, 0)
  ).length

  httpPortsReleased = true
  for (const address of boundAddresses) {
    if (!(await portReleased(address))) httpPortsReleased = false
  }
  ensure(httpPortsReleased, "one App-owned HTTP port could not be rebound")
  ensure(nodeState.activeHandlers === 0, "one unary handler remained active")

  const bindBeforeRegister =
    lifecycleEvents.indexOf("bind:a") < lifecycleEvents.indexOf("register:a") &&
    lifecycleEvents.indexOf("bind:b") < lifecycleEvents.indexOf("register:b")
  const deregisterBeforeStop =
    lifecycleEvents.indexOf("deregister:a") < lifecycleEvents.indexOf("stop:a") &&
    lifecycleEvents.indexOf("deregister:b") < lifecycleEvents.indexOf("stop:b")
  const lifecycleOrder = lifecycleEvents.join(",")
  const expectedLifecycleOrder =
    "start:a,bind:a,register:a,start:b,bind:b,register:b,deregister:a,stop:a,deregister:b,stop:b"
  ensure(bindBeforeRegister, "App registration occurred before HTTP bind")
  ensure(deregisterBeforeStop, "App server stop occurred before Registry deregistration")
  const reachableDuringDeregister =
    deregisterProbeNodes.join(",") === "a,b" &&
    nodeState.deregisterProbes.a === 1 &&
    nodeState.deregisterProbes.b === 1
  ensure(reachableDuringDeregister, "one App endpoint was unavailable during deregistration")
  ensure(
    lifecycleOrder === expectedLifecycleOrder,
    `App lifecycle order drifted: ${lifecycleOrder}`
  )
  const registryOperationsReturnedVoid =
    registryVoidResults.length === 4 && registryVoidResults.every(Boolean)
  ensure(registryOperationsReturnedVoid, "Registry operations did not return void")
  const selectionFeedbackExactlyOnce =
    selectionTracker.issued === 5 &&
    selectionTracker.feedbackCalls === selectionTracker.issued &&
    selectionTracker.duplicateFeedbackCalls === 0
  const feedbackOutcomesHealthy =
    feedbackOutcomes.length === selectionTracker.feedbackCalls &&
    feedbackOutcomes.every((outcome) => outcome.error === null)
  const transportClientsClosedExactlyOnce =
    transportTracker.dialedClients === 2 &&
    transportTracker.clientsWithClose === transportTracker.dialedClients &&
    transportTracker.closeCalls === transportTracker.dialedClients &&
    transportTracker.duplicateCloseCalls === 0
  ensure(selectionFeedbackExactlyOnce, "one unary selection feedback was not completed once")
  ensure(feedbackOutcomesHealthy, "one successful unary call reported unhealthy feedback")
  ensure(
    transportClientsClosedExactlyOnce,
    "unary Transport clients were not reused per endpoint and closed exactly once"
  )
} catch (value) {
  primaryFailure = errorValue(value, "joint Docker suite rejected with a non-Error value")
} finally {
  if (client !== null) {
    try {
      await client.close(background())
    } catch (value) {
      cleanupFailures.push(errorValue(value, "Client cleanup rejected"))
    }
    client = null
  }
  if (watcher !== null) {
    try {
      await watcher.stop(background())
      watcherStopped = true
    } catch (value) {
      cleanupFailures.push(errorValue(value, "Registry watcher cleanup rejected"))
    }
    watcher = null
  }
  if (appB !== null && appBRunning !== null) {
    try {
      await stopApplication(appB, appBRunning)
      appBStopped = true
    } catch (value) {
      cleanupFailures.push(errorValue(value, "App b cleanup rejected"))
    }
    appB = null
    appBRunning = null
  }
  if (appA !== null && appARunning !== null) {
    try {
      await stopApplication(appA, appARunning)
      appAStopped = true
    } catch (value) {
      cleanupFailures.push(errorValue(value, "App a cleanup rejected"))
    }
    appA = null
    appARunning = null
  }
  appRunsSettled = appAStopped && appBStopped
  if (boundAddresses.length > 0 && !httpPortsReleased) {
    try {
      httpPortsReleased = true
      for (const address of boundAddresses) {
        if (!(await portReleased(address))) httpPortsReleased = false
      }
    } catch (value) {
      httpPortsReleased = false
      cleanupFailures.push(errorValue(value, "HTTP port cleanup readback failed"))
    }
  }
  if (consulAddress !== "") {
    try {
      remainingProviderRegistrations = (await managedRemoteIds(consulAddress, null)).length
    } catch (value) {
      cleanupFailures.push(errorValue(value, "Consul residual readback failed"))
    }
  }
  if (containerStarted) {
    const removed = await docker(["rm", "--force", "--volumes", ContainerName], true)
    if (removed.code !== 0 && !removed.stderr.includes("No such container")) {
      cleanupFailures.push(
        new Error(`test-owned Consul container removal failed: ${removed.stderr}`)
      )
    }
  }
  containerStarted = false
  if (networkCreated) {
    const removed = await docker(["network", "rm", NetworkName], true)
    if (removed.code !== 0 && !removed.stderr.includes("No such network")) {
      cleanupFailures.push(new Error(`test-owned Docker network removal failed: ${removed.stderr}`))
    }
  }
  networkCreated = false
  const containerReadback = await docker(["inspect", ContainerName], true)
  remainingContainers = containerReadback.code === 0 ? 1 : 0
  const networkReadback = await docker(["network", "inspect", NetworkName], true)
  remainingNetworks = networkReadback.code === 0 ? 1 : 0
  await Promise.resolve()
  process.off("unhandledRejection", unhandledRejection)
}

const cleanup = Object.freeze({
  remainingContainers,
  remainingNetworks,
  remainingProviderRegistrations,
  watcherStopped,
  appsStopped: appAStopped && appBStopped,
  appRunsSettled,
  httpPortsReleased,
  activeHandlers: nodeState.activeHandlers,
  unhandledRejections
})

if (primaryFailure !== null || cleanupFailures.length > 0) {
  const failures: Error[] = []
  if (primaryFailure !== null) failures.push(primaryFailure)
  for (const failure of cleanupFailures) failures.push(failure)
  throw failures.length === 1
    ? failures[0]
    : new AggregateError(failures, "joint Docker suite and cleanup failed")
}
ensure(
  cleanup.remainingContainers === 0 &&
    cleanup.remainingNetworks === 0 &&
    cleanup.remainingProviderRegistrations === 0 &&
    cleanup.watcherStopped &&
    cleanup.appsStopped &&
    cleanup.appRunsSettled &&
    cleanup.httpPortsReleased &&
    cleanup.activeHandlers === 0 &&
    cleanup.unhandledRejections === 0,
  "joint Docker suite cleanup evidence was not clean"
)
