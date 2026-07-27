import { background, withCancelCause, withTimeout } from "@likego/context"
import { type Registry, type ServiceInstance, type Watcher } from "@likego/registry"
import {
  domain,
  families,
  newMDNSRegistry,
  port,
  queryTimeout,
  ttl,
  watchBufferSize,
  type MDNSBindOptions
} from "@likego/registry-mdns"
import { registryConformanceCases } from "../../../src/testing"
import { newMemoryMDNSNetwork, type MemoryMDNSNetwork } from "../../src/testing"

const scenarios = Object.freeze([
  "conformance",
  "registry-lifecycle",
  "domain-isolation",
  "context-cancellation",
  "testing-host"
])
const networks: MemoryMDNSNetwork[] = []
let assertions = 0

/** Records one runner-neutral portable assertion. */
function ensure(condition: unknown, message: string): asserts condition {
  assertions += 1
  if (!condition) throw new Error(`portable mDNS runtime failed: ${message}`)
}

/** Creates and tracks one deterministic multicast network. */
function network(): MemoryMDNSNetwork {
  const created = newMemoryMDNSNetwork()
  networks.push(created)
  return created
}

/** Creates one normalized ServiceInstance revision. */
function service(revision: "initial" | "updated" = "initial"): ServiceInstance {
  return {
    id: "runtime-node",
    name: "runtime-mdns",
    version: revision === "initial" ? "v1" : "v2",
    metadata: { revision },
    endpoints: [revision === "initial" ? "http://127.0.0.1:8080/" : "http://127.0.0.1:8081/"]
  }
}

/** Waits for one watcher snapshot under a caller-only timeout. */
async function next(watcher: Watcher): Promise<readonly ServiceInstance[]> {
  const [ctx, cancel] = withTimeout(background(), 3_000)
  try {
    return await watcher.next(ctx)
  } finally {
    cancel()
  }
}

/** Exercises the provider-neutral Registry conformance inventory. */
async function conformanceScenario(): Promise<number> {
  const cases = registryConformanceCases({
    createRegistry(): Registry {
      const shared = network()
      return newMDNSRegistry(shared.host("single"), queryTimeout(5))
    },
    createSharedRegistries(): readonly [Registry, Registry] {
      const shared = network()
      return Object.freeze([
        newMDNSRegistry(shared.host("publisher"), queryTimeout(10)),
        newMDNSRegistry(shared.host("reader"), queryTimeout(10))
      ])
    },
    service
  })
  for (const value of cases) await value.run()
  ensure(cases.length === 3, "unexpected Registry conformance inventory")
  return cases.length
}

/** Exercises the public register/discover/watch/deregister lifecycle. */
async function lifecycleScenario(): Promise<void> {
  const shared = network()
  const publisher = newMDNSRegistry(
    shared.host("lifecycle-publisher"),
    queryTimeout(10),
    ttl(2_000)
  )
  const observer = newMDNSRegistry(
    shared.host("lifecycle-observer"),
    queryTimeout(10),
    watchBufferSize(8)
  )
  const watcher = await observer.watch(background(), service().name)
  const initial = service("initial")
  const updated = service("updated")

  await publisher.register(background(), initial)
  ensure(JSON.stringify(await next(watcher)) === JSON.stringify([initial]), "watch omitted create")
  ensure(
    JSON.stringify(await observer.getService(background(), initial.name)) ===
      JSON.stringify([initial]),
    "getService omitted registration"
  )
  await publisher.register(background(), updated)
  ensure(JSON.stringify(await next(watcher)) === JSON.stringify([updated]), "watch omitted update")
  await publisher.deregister(background(), updated)
  ensure((await next(watcher)).length === 0, "watch omitted deregistration")
  await watcher.stop(background())
  ensure(shared.activeSockets() === 0, "lifecycle leaked sockets")
}

/** Proves independent configured domains do not discover each other. */
async function domainScenario(): Promise<void> {
  const shared = network()
  const publisher = newMDNSRegistry(shared.host("default-domain"), queryTimeout(5), ttl(2_000))
  const isolated = newMDNSRegistry(
    shared.host("isolated-domain"),
    domain("isolated.likego"),
    queryTimeout(5)
  )
  const current = service()
  await publisher.register(background(), current)
  ensure(
    (await isolated.getService(background(), current.name)).length === 0,
    "configured domain leaked a service"
  )
  await publisher.deregister(background(), current)
  ensure(shared.activeSockets() === 0, "domain scenario leaked sockets")
}

/** Proves admission preserves the caller's exact Context cause. */
async function cancellationScenario(): Promise<void> {
  const shared = network()
  const registry = newMDNSRegistry(shared.host("canceled"), queryTimeout(5))
  const [ctx, cancel] = withCancelCause(background())
  const failure = new Error("portable cancellation")
  cancel(failure)
  let observed: unknown = null
  try {
    await registry.register(ctx, service())
  } catch (error) {
    observed = error
  }
  ensure(observed === failure, "register changed Context failure identity")
  ensure(shared.activeSockets() === 0, "canceled admission leaked sockets")
}

/** Exercises the public deterministic host without importing provider internals. */
async function testingHostScenario(): Promise<void> {
  const shared = network()
  const senderHost = shared.host("direct-sender")
  const receiverHost = shared.host("direct-receiver")
  const bind = (id: string): MDNSBindOptions =>
    Object.freeze({
      family: "ipv4",
      bindAddress: "0.0.0.0",
      port: 5_353,
      interfaceId: `${id}-ipv4`,
      interfaceAddress: "127.0.0.1",
      reuseAddress: true,
      multicastTTL: 255
    })
  const sender = await senderHost.bindDatagram(background(), bind("direct-sender"))
  const receiver = await receiverHost.bindDatagram(background(), bind("direct-receiver"))
  const membership = await receiver.joinMulticast(
    background(),
    "224.0.0.251",
    "direct-receiver-ipv4"
  )
  await sender.setMulticastInterface(background(), "direct-sender-ipv4")
  const pending = receiver.receive(background())
  await sender.send(background(), new Uint8Array([76, 105, 107, 101, 71, 111]), {
    family: "ipv4",
    address: "224.0.0.251",
    port: 5_353
  })
  ensure(
    Array.from((await pending).data).join(",") === "76,105,107,101,71,111",
    "testing host changed datagram bytes"
  )
  await membership.leave(background())
  await sender.close(background())
  await receiver.close(background())
  await Promise.all([sender.settled(), receiver.settled()])
  ensure(shared.activeSockets() === 0, "testing host leaked sockets")
}

ensure(families("ipv4") instanceof Function, "families option was not constructed")
ensure(port(5_353) instanceof Function, "port option was not constructed")
const conformanceCases = await conformanceScenario()
await lifecycleScenario()
await domainScenario()
await cancellationScenario()
await testingHostScenario()
const sockets = networks.reduce((total, current) => total + current.activeSockets(), 0)
ensure(sockets === 0, "portable runtime leaked sockets")

console.log(
  `LIKEGO_REGISTRY_MDNS_PORTABLE_RUNTIME=${JSON.stringify({
    valid: true,
    assertions,
    conformanceCases,
    scenarios,
    sockets
  })}`
)
