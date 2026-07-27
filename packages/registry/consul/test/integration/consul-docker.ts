import { background } from "@likego/context"
import { type ServiceInstance, type Watcher } from "@likego/registry"

import { newConsulRegistry, type ConsulFetch } from "../../src/index"
import { sealConsulScenarioEvidence } from "./consul-evidence"

const Image =
  "hashicorp/consul:2.0.2@sha256:7dcf35d6b2682831094f1680aa58be214134969505acce0a9b280249581aa7d2"
const DockerOwner = process.env.LIKEGO_E2E_OWNER
if (DockerOwner === undefined || !/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(DockerOwner)) {
  throw new Error("invalid LIKEGO_E2E_OWNER")
}
const DockerOwnerLabel = `io.likego.e2e.owner=${DockerOwner}`
const Container = `likego-registry-consul-${crypto.randomUUID()}`

interface CommandResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** Throws when one real-service invariant is false. */
function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/** Executes one Docker command and captures complete diagnostics. */
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

/** Reads the exact host port assigned to the Consul HTTP listener. */
async function mappedPort(): Promise<number> {
  const result = await docker(["port", Container, "8500/tcp"])
  const match = /:([0-9]+)$/.exec(result.stdout)
  if (match?.[1] === undefined) throw new Error("Docker did not report the Consul port")
  return Number(match[1])
}

/** Waits until the real Consul Agent serves its HTTP self endpoint. */
async function ready(address: string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${address}/v1/agent/self`)
      if (response.ok) {
        await response.body?.cancel()
        return
      }
      await response.body?.cancel()
    } catch {
      // Docker can publish the port before Consul begins accepting requests.
    }
    await Bun.sleep(100)
  }
  throw new Error("Consul Agent did not become ready")
}

/** Polls one real-service predicate with a bounded deadline. */
async function eventually(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  message: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await Bun.sleep(50)
  }
  throw new Error(message)
}

/** Creates one public ServiceInstance revision. */
function service(revision: "initial" | "updated"): ServiceInstance {
  return {
    id: "orders-1",
    name: `orders-${DockerOwner}`,
    version: "v1",
    metadata: { revision },
    endpoints: [revision === "initial" ? "http://127.0.0.1:8080/" : "http://127.0.0.1:8081/"]
  }
}

/** Reads the real Agent service table. */
async function agentServices(address: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${address}/v1/agent/services`)
  ensure(response.ok, `Consul Agent services returned HTTP ${response.status}`)
  const value: unknown = await response.json()
  ensure(typeof value === "object" && value !== null && !Array.isArray(value), "invalid services")
  return value as Record<string, unknown>
}

let containerExists = false
let watcher: Watcher | null = null
let registry: ReturnType<typeof newConsulRegistry> | null = null
let registered: ServiceInstance | null = null
let primaryFailure: unknown = null
const cleanupFailures: Error[] = []
let evidence: readonly Readonly<Record<string, unknown>>[] = []
let observedVersion = "unobserved"

try {
  await docker([
    "run",
    "--detach",
    "--name",
    Container,
    "--label",
    DockerOwnerLabel,
    "--publish",
    "127.0.0.1::8500",
    Image,
    "agent",
    "-dev",
    "-client=0.0.0.0"
  ])
  containerExists = true
  const address = `http://127.0.0.1:${await mappedPort()}`
  await ready(address)
  const version = await docker(["exec", Container, "consul", "version"])
  const versionMatch = /Consul v([0-9]+\.[0-9]+\.[0-9]+)/.exec(version.stdout)
  ensure(versionMatch?.[1] === "2.0.2", `unexpected Consul version: ${version.stdout}`)
  observedVersion = versionMatch[1]

  let heartbeatPasses = 0
  const trackedFetch: ConsulFetch = async function tracked(input, init): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input, init)
    if (new URL(request.url).pathname.startsWith("/v1/agent/check/pass/")) {
      heartbeatPasses += 1
    }
    return await fetch(request)
  }
  registry = newConsulRegistry({
    fetch: trackedFetch,
    address,
    waitMs: 500,
    minimumQueryIntervalMs: 20,
    retryInitialMs: 50,
    retryMaximumMs: 500,
    ttlMs: 2_000
  })
  const initial = service("initial")
  const updated = service("updated")
  watcher = await registry.watch(background(), initial.name)
  const watcherSurfaceExact = JSON.stringify(Object.keys(watcher).sort()) === '["next","stop"]'

  const registerResult = await registry.register(background(), initial)
  registered = initial
  const initialSnapshot = await watcher.next(background())
  const discovered = await registry.getService(background(), initial.name)
  const remoteBefore = await agentServices(address)
  const remoteIds = Object.keys(remoteBefore)
  ensure(remoteIds.length === 1, "Consul did not retain exactly one managed service")
  const remoteId = remoteIds[0]
  ensure(remoteId !== undefined, "Consul omitted the managed remote ID")

  const updateResult = await registry.register(background(), updated)
  registered = updated
  const updatedSnapshot = await watcher.next(background())
  const heartbeatBaseline = heartbeatPasses
  await eventually(
    () => heartbeatPasses >= heartbeatBaseline + 2,
    3_500,
    "private TTL heartbeat did not renew twice"
  )
  const remoteAfter = await agentServices(address)

  const deregisterResult = await registry.deregister(background(), updated)
  registered = null
  const emptySnapshot = await watcher.next(background())
  await eventually(
    async () => Object.keys(await agentServices(address)).length === 0,
    5_000,
    "Consul retained the deregistered service"
  )

  const roundTrip = sealConsulScenarioEvidence("service-instance-roundtrip", {
    registerReturnedVoid: registerResult === undefined && updateResult === undefined,
    discoveredExact: JSON.stringify(discovered) === JSON.stringify([initial]),
    deterministicRemoteId:
      /^li-[a-z2-7]{52}$/.test(remoteId) &&
      Object.keys(remoteAfter).length === 1 &&
      Object.keys(remoteAfter)[0] === remoteId,
    deregisterReturnedVoid: deregisterResult === undefined
  })
  const watchEvidence = sealConsulScenarioEvidence("replacement-snapshot-watch", {
    initialSnapshot: initialSnapshot.length,
    updatedSnapshot:
      updatedSnapshot.length === 1 && JSON.stringify(updatedSnapshot[0]) === JSON.stringify(updated)
        ? 1
        : -1,
    emptySnapshot: emptySnapshot.length,
    watcherSurfaceExact
  })
  const heartbeatEvidence = sealConsulScenarioEvidence("private-ttl-heartbeat", {
    heartbeatPasses: heartbeatPasses - heartbeatBaseline,
    publicHandleExposed: registerResult !== undefined
  })
  evidence = Object.freeze([roundTrip, watchEvidence, heartbeatEvidence])
  ensure(
    evidence.every((value) => value.valid === true),
    "Consul scenario evidence is invalid"
  )
} catch (value) {
  primaryFailure = value
} finally {
  if (registered !== null && registry !== null) {
    try {
      await registry.deregister(background(), registered)
    } catch (value) {
      cleanupFailures.push(value instanceof Error ? value : new Error("deregister cleanup failed"))
    }
  }
  if (watcher !== null) {
    try {
      await watcher.stop(background())
    } catch (value) {
      cleanupFailures.push(value instanceof Error ? value : new Error("watcher cleanup failed"))
    }
  }
  if (containerExists) {
    const removed = await docker(["rm", "-f", Container], true)
    if (removed.code !== 0) cleanupFailures.push(new Error(removed.stderr))
  }
}

const remaining = await docker(
  ["ps", "-a", "--filter", `name=^/${Container}$`, "--format", "{{.Names}}"],
  true
)
const residualContainers = remaining.stdout === "" ? 0 : remaining.stdout.split("\n").length
if (residualContainers !== 0) cleanupFailures.push(new Error("Consul E2E container remains"))
if (primaryFailure !== null || cleanupFailures.length !== 0) {
  const errors: Error[] = []
  if (primaryFailure !== null) {
    errors.push(primaryFailure instanceof Error ? primaryFailure : new Error("Consul E2E failed"))
  }
  for (const failure of cleanupFailures) errors.push(failure)
  throw errors.length === 1
    ? errors[0]
    : new AggregateError(errors, "Consul E2E and cleanup failed")
}

console.log(
  `LIKEGO_REGISTRY_CONSUL_E2E_RESULT=${JSON.stringify({
    schemaVersion: 1,
    valid: true,
    package: "@likego/registry-consul",
    image: Image,
    consulVersion: observedVersion,
    scenarios: [
      "service-instance-roundtrip",
      "replacement-snapshot-watch",
      "private-ttl-heartbeat"
    ],
    evidence,
    scenarioEvidence: {
      "service-instance-roundtrip": evidence[0],
      "replacement-snapshot-watch": evidence[1],
      "private-ttl-heartbeat": evidence[2]
    },
    cleanup: {
      watcherTerminal: true,
      registrationRemoved: true,
      residualContainers
    }
  })}`
)
