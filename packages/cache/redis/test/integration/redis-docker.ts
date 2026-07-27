import { background, withTimeout, type Context } from "@likego/context"
import type { Cache } from "@likego/cache"
import type { Server } from "@likego/core"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { createClient, createCluster, createSentinel } from "@redis/client"
import redisClientManifest from "@redis/client/package.json" with { type: "json" }

import { cacheConformanceCases, type CacheConformanceCase } from "../../../src/testing"
import { encodeRedisCacheValue } from "../../src/codec"
import { newRedisCache } from "../../src/index"

const Image =
  "redis:8.8.1-alpine@sha256:8096655e437712b07503796fb64d81359256cfcff0ab29d95a7da72863786efb"
const RedisVersion = "8.8.1"
const NodeRedisVersion = redisClientManifest.version
const RunId = crypto.randomUUID()
const Name = `likego-cache-redis-${RunId}`
const Network = `${Name}-network`
const Label = `likego.cache-redis.integration=${RunId}`
const DockerOwner = process.env.LIKEGO_E2E_OWNER
if (DockerOwner === undefined || !/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(DockerOwner)) {
  throw new Error("invalid LIKEGO_E2E_OWNER")
}
const DockerOwnerLabel = `io.likego.e2e.owner=${DockerOwner}`
const Prefix = `likego:cache:e2e:${RunId}:`
const ResultMarker = "LIKEGO_CACHE_REDIS_E2E_RESULT"
const Password = `likego-${RunId}`
const ArtifactRoot = join(process.cwd(), ".artifacts", "cache-redis", RunId)

interface CommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

interface StartedCache {
  readonly cache: Cache & Server
  readonly running: Promise<void>
}

type CacheFactory = (prefix: string) => Cache & Server

interface RedisAddress {
  readonly host: string
  readonly port: number
}

interface SentinelEvidence {
  readonly rootNodes: number
  readonly failedPrimary: string
  readonly promotedPrimary: string
  readonly replicatedBeforeFailover: boolean
  readonly writeAfterFailover: boolean
}

interface ClusterEvidence {
  readonly masters: number
  readonly replicas: number
  readonly failedMasterId: string
  readonly failedKeySlot: number
  readonly promotedMasterId: string
  readonly crossSlotBeforeFailover: boolean
  readonly crossSlotAfterFailover: boolean
  readonly replicatedBeforeFailover: boolean
}

interface ClusterNode {
  readonly id: string
  readonly address: string
  readonly flags: readonly string[]
  readonly masterId: string
  readonly slots: readonly string[]
}

/** Runs one argv-safe Docker command and captures its complete result. */
async function docker(args: readonly string[], allowFailure = false): Promise<CommandResult> {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" })
  const stdoutPromise = new Response(child.stdout).text()
  const stderrPromise = new Response(child.stderr).text()
  const exitCode = await child.exited
  const stdout = (await stdoutPromise).trim()
  const stderr = (await stderrPromise).trim()
  if (exitCode !== 0 && !allowFailure) {
    throw new Error(`docker ${args.join(" ")} failed (${exitCode}): ${stderr}`)
  }
  return Object.freeze({ stdout, stderr, exitCode })
}

/** Runs one argv-safe host command and captures its complete result. */
async function host(args: readonly string[]): Promise<CommandResult> {
  const child = Bun.spawn(Array.from(args), { stdout: "pipe", stderr: "pipe" })
  const stdoutPromise = new Response(child.stdout).text()
  const stderrPromise = new Response(child.stderr).text()
  const exitCode = await child.exited
  const stdout = (await stdoutPromise).trim()
  const stderr = (await stderrPromise).trim()
  if (exitCode !== 0) throw new Error(`${args.join(" ")} failed (${exitCode}): ${stderr}`)
  return Object.freeze({ stdout, stderr, exitCode })
}

/** Waits one bounded real-time polling interval. */
function pause(milliseconds: number): Promise<void> {
  return new Promise<void>(function wait(resolve): void {
    setTimeout(resolve, milliseconds)
  })
}

/** Returns one random localhost mapping for a container TCP port. */
async function hostPort(name: string, port: number): Promise<number> {
  const result = await docker(["port", name, `${port}/tcp`])
  const first = result.stdout.split("\n")[0]
  const match = first === undefined ? null : /:([0-9]+)$/u.exec(first)
  if (match?.[1] === undefined) throw new Error(`invalid Redis port mapping: ${result.stdout}`)
  return Number(match[1])
}

/** Returns the random localhost mapping for the baseline Redis TCP port. */
async function address(): Promise<string> {
  return `redis://127.0.0.1:${await hostPort(Name, 6379)}`
}

/** Waits until the real Redis server answers PING inside its container. */
async function ready(name = Name, password: string | null = null): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const authentication = password === null ? [] : ["-a", password]
    const result = await docker(["exec", name, "redis-cli", ...authentication, "PING"], true)
    if (result.exitCode === 0 && result.stdout === "PONG") return
    await pause(100)
  }
  throw new Error(`${name} did not become ready within 30 seconds`)
}

/** Returns one container's current IPv4 address on the isolated integration network. */
async function containerIp(name: string): Promise<string> {
  const result = await docker([
    "inspect",
    "--format",
    `{{with index .NetworkSettings.Networks \"${Network}\"}}{{.IPAddress}}{{end}}`,
    name
  ])
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(result.stdout)) {
    throw new Error(`invalid container address for ${name}: ${result.stdout}`)
  }
  return result.stdout
}

/** Retries one real topology operation until it succeeds or the deadline expires. */
async function eventually<T>(label: string, operation: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 60_000
  let lastFailure: unknown = null
  while (Date.now() < deadline) {
    try {
      return await operation()
    } catch (value) {
      lastFailure = value
      await pause(100)
    }
  }
  throw new Error(`timed out waiting for ${label}`, { cause: lastFailure })
}

/** Starts one labeled Redis container on the isolated test network. */
async function runRedisContainer(
  name: string,
  alias: string,
  port: number,
  command: readonly string[]
): Promise<void> {
  await docker([
    "run",
    "--detach",
    "--name",
    name,
    "--network",
    Network,
    "--network-alias",
    alias,
    "--label",
    Label,
    "--label",
    DockerOwnerLabel,
    "--publish",
    `127.0.0.1::${port}`,
    Image,
    ...command
  ])
}

/** Creates one exact Redis Cache pair without a tuple assertion. */
function pair(
  first: Cache & Server,
  second: Cache & Server
): readonly [Cache & Server, Cache & Server] {
  return [first, second]
}

/** Stops every tracked provider in reverse ownership order. */
async function stopAll(startedCaches: StartedCache[]): Promise<void> {
  const failures: Error[] = []
  while (startedCaches.length > 0) {
    const started = startedCaches.pop()
    if (started === undefined) continue
    try {
      await started.cache.stop(background())
    } catch (value) {
      failures.push(value instanceof Error ? value : new Error("Redis Cache cleanup failed"))
    }
    try {
      await started.running
    } catch (value) {
      failures.push(value instanceof Error ? value : new Error("Redis Cache cleanup failed"))
    }
  }
  const first = failures[0]
  if (failures.length === 1 && first !== undefined) throw first
  if (failures.length > 1) throw new AggregateError(failures, "Redis Cache cleanup failed")
}

/** Starts one Redis Cache and transfers its lifetime to the integration owner. */
async function start(
  cache: Cache & Server,
  startedCaches: StartedCache[]
): Promise<Cache & Server> {
  const [startup, cancelStartup] = withTimeout(background(), 30_000)
  const running = cache.start(startup)
  void running.catch(function observeStartFailure(): void {})
  startedCaches.push(Object.freeze({ cache, running }))
  const deadline = Date.now() + 30_000
  try {
    while (Date.now() < deadline) {
      try {
        await cache.get(background(), "__likego_integration_readiness__")
        return cache
      } catch (value) {
        if (
          typeof value !== "object" ||
          value === null ||
          !("code" in value) ||
          value.code !== "LIKEGO_CACHE_REDIS_STATE" ||
          !("state" in value) ||
          value.state !== "starting"
        ) {
          throw value
        }
        await pause(10)
      }
    }
    throw new Error("Redis Cache did not start within 30 seconds")
  } finally {
    cancelStartup()
  }
}

/** Runs every provider-neutral case against one real Redis topology. */
async function runConformance(create: CacheFactory): Promise<number> {
  const subject = {
    createCache(): Cache & Server {
      return create(Prefix)
    },
    createSharedCaches(): readonly [Cache & Server, Cache & Server] {
      return pair(create(Prefix), create(Prefix))
    },
    async useCache(
      cache: Cache & Server,
      run: (cache: Cache & Server) => PromiseLike<void>
    ): Promise<void> {
      const startedCaches: StartedCache[] = []
      const active = await start(cache, startedCaches)
      try {
        await run(active)
      } finally {
        await stopAll(startedCaches)
      }
    },
    convergenceTimeoutMs: 5_000,
    ttlMs: 50
  }
  const cases: readonly CacheConformanceCase[] = cacheConformanceCases(subject)
  for (const entry of cases) await entry.run()
  return cases.length
}

/** Verifies binary ownership, namespace isolation, corruption handling, and lifecycle close. */
async function runDirect(redisUrl: string): Promise<Readonly<Record<string, unknown>>> {
  const startedCaches: StartedCache[] = []
  try {
    const first = await start(
      newRedisCache({ url: redisUrl, prefix: `${Prefix}first:` }),
      startedCaches
    )
    const second = await start(
      newRedisCache({ url: redisUrl, prefix: `${Prefix}second:` }),
      startedCaches
    )
    const binary = new Uint8Array(256)
    for (let index = 0; index < binary.length; index += 1) binary[index] = index
    await first.put(background(), "binary", binary)
    binary[0] = 99
    const roundTrip = await first.get(background(), "binary")
    if (
      roundTrip === null ||
      roundTrip.length !== 256 ||
      roundTrip[0] !== 0 ||
      roundTrip[255] !== 255
    ) {
      throw new Error("Redis binary round-trip failed")
    }
    if ((await second.get(background(), "binary")) !== null) {
      throw new Error("Redis namespace isolation failed")
    }
    await first.put(background(), "binary", new Uint8Array([9]))
    if ((await first.get(background(), "binary"))?.[0] !== 9) {
      throw new Error("Redis overwrite failed")
    }

    const foreignKey = `${Prefix}first:foreign`
    await docker(["exec", Name, "redis-cli", "SET", foreignKey, "foreign"])
    let protocolCode = ""
    try {
      await first.get(background(), "foreign")
    } catch (value) {
      if (value instanceof Error && "code" in value && typeof value.code === "string") {
        protocolCode = value.code
      }
    }
    if (protocolCode !== "LIKEGO_CACHE_REDIS_PROTOCOL") {
      throw new Error("Redis foreign value did not produce the protocol error")
    }

    return Object.freeze({ binaryBytes: roundTrip.length, protocolCode })
  } finally {
    await stopAll(startedCaches)
  }
}

/** Reads the exact server version from the running official container. */
async function serverVersion(): Promise<string> {
  const result = await docker(["exec", Name, "redis-cli", "INFO", "server"])
  const line = result.stdout.split("\n").find(function version(item) {
    return item.startsWith("redis_version:")
  })
  if (line === undefined) throw new Error("Redis server version was not reported")
  return line.slice("redis_version:".length).trim()
}

/** Generates one short-lived CA and localhost server certificate for the TLS gate. */
async function tlsMaterial(): Promise<Readonly<{ ca: string; directory: string }>> {
  const directory = join(ArtifactRoot, "tls")
  await mkdir(directory, { recursive: true })
  const caKey = join(directory, "ca.key")
  const ca = join(directory, "ca.crt")
  const serverKey = join(directory, "server.key")
  const request = join(directory, "server.csr")
  const certificate = join(directory, "server.crt")
  const extensions = join(directory, "server.ext")
  await writeFile(extensions, "subjectAltName=DNS:localhost,IP:127.0.0.1\n")
  await host([
    "openssl",
    "req",
    "-x509",
    "-nodes",
    "-newkey",
    "rsa:2048",
    "-keyout",
    caKey,
    "-out",
    ca,
    "-subj",
    "/CN=LikeGo Redis Test CA",
    "-days",
    "1"
  ])
  await host([
    "openssl",
    "req",
    "-nodes",
    "-newkey",
    "rsa:2048",
    "-keyout",
    serverKey,
    "-out",
    request,
    "-subj",
    "/CN=localhost"
  ])
  await host([
    "openssl",
    "x509",
    "-req",
    "-in",
    request,
    "-CA",
    ca,
    "-CAkey",
    caKey,
    "-CAcreateserial",
    "-out",
    certificate,
    "-days",
    "1",
    "-extfile",
    extensions
  ])
  await host(["chmod", "644", ca, certificate, serverKey])
  return Object.freeze({ ca: await Bun.file(ca).text(), directory })
}

/** Waits until the TLS-only authenticated server answers through redis-cli. */
async function readyTls(name: string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const result = await docker(
      ["exec", name, "redis-cli", "--tls", "--cacert", "/tls/ca.crt", "-a", Password, "PING"],
      true
    )
    if (result.exitCode === 0 && result.stdout === "PONG") return
    await pause(100)
  }
  throw new Error("TLS Redis did not become ready within 30 seconds")
}

/** Runs Cache conformance through a real TLS-only password-protected server. */
async function runTls(): Promise<Readonly<Record<string, unknown>>> {
  const name = `${Name}-tls`
  const material = await tlsMaterial()
  await docker([
    "run",
    "--detach",
    "--name",
    name,
    "--hostname",
    name,
    "--network",
    Network,
    "--label",
    Label,
    "--label",
    DockerOwnerLabel,
    "--publish",
    "127.0.0.1::6379",
    "--volume",
    `${material.directory}:/tls:ro`,
    Image,
    "redis-server",
    "--port",
    "0",
    "--tls-port",
    "6379",
    "--tls-cert-file",
    "/tls/server.crt",
    "--tls-key-file",
    "/tls/server.key",
    "--tls-ca-cert-file",
    "/tls/ca.crt",
    "--tls-auth-clients",
    "no",
    "--requirepass",
    Password,
    "--save",
    "",
    "--appendonly",
    "no"
  ])
  await readyTls(name)
  const port = await hostPort(name, 6379)
  const conformanceCases = await runConformance((prefix) =>
    newRedisCache({
      client: () =>
        createClient({
          url: `rediss://default:${Password}@127.0.0.1:${port}`,
          socket: { tls: true, ca: material.ca, servername: "localhost", rejectUnauthorized: true }
        }),
      prefix
    })
  )
  return Object.freeze({ authenticated: true, conformanceCases, tls: true })
}

/** Waits until one password-protected replica is attached to its primary. */
async function waitForReplica(name: string): Promise<void> {
  await eventually("Redis replica link", async () => {
    const result = await docker(["exec", name, "redis-cli", "-a", Password, "INFO", "replication"])
    if (!result.stdout.includes("role:slave") || !result.stdout.includes("master_link_status:up")) {
      throw new Error("replica has not attached")
    }
  })
}

/** Waits until one replica exposes the exact canonical Cache carrier. */
async function waitForReplicaValue(
  name: string,
  password: string | null,
  key: string,
  expected: string,
  cluster: boolean
): Promise<void> {
  await eventually(`${name} replicated value`, async () => {
    const result = cluster
      ? await docker([
          "exec",
          name,
          "sh",
          "-c",
          'printf "READONLY\\r\\nGET %s\\r\\n" "$1" | redis-cli --raw',
          "sh",
          key
        ])
      : await docker([
          "exec",
          name,
          "redis-cli",
          ...(password === null ? [] : ["-a", password]),
          "--raw",
          "GET",
          key
        ])
    const value = cluster ? result.stdout.split("\n")[1] : result.stdout
    if (value !== expected) throw new Error("replica value is not current")
  })
}

/** Starts one writable Sentinel from a private generated configuration. */
async function runSentinelContainer(name: string, alias: string, primary: string): Promise<void> {
  const configuration = [
    "port 26379",
    "bind 0.0.0.0",
    "protected-mode no",
    "sentinel resolve-hostnames yes",
    `sentinel monitor likego-primary ${primary} 6379 2`,
    `sentinel auth-pass likego-primary ${Password}`,
    "sentinel down-after-milliseconds likego-primary 500",
    "sentinel failover-timeout likego-primary 5000",
    "sentinel parallel-syncs likego-primary 1"
  ].join("\n")
  const launch = `cat > /tmp/sentinel.conf <<'EOF'\n${configuration}\nEOF\nexec redis-server /tmp/sentinel.conf --sentinel`
  await runRedisContainer(name, alias, 26379, ["sh", "-c", launch])
  await eventually(`${name} readiness`, async () => {
    const result = await docker(["exec", name, "redis-cli", "-p", "26379", "PING"], true)
    if (result.exitCode !== 0 || result.stdout !== "PONG") throw new Error("Sentinel not ready")
  })
}

/** Returns the address currently elected by one real Sentinel. */
async function sentinelPrimary(name: string): Promise<string> {
  const result = await docker([
    "exec",
    name,
    "redis-cli",
    "-p",
    "26379",
    "--raw",
    "SENTINEL",
    "get-master-addr-by-name",
    "likego-primary"
  ])
  const address = result.stdout.split("\n")[0]
  if (address === undefined || address.length === 0) throw new Error("Sentinel returned no primary")
  return address
}

/** Verifies official createSentinel discovery and a real primary failover. */
async function runSentinelFailover(): Promise<SentinelEvidence> {
  const primary = `${Name}-sentinel-primary`
  const replica = `${Name}-sentinel-replica`
  const sentinels = [1, 2, 3].map((index) => `${Name}-sentinel-${index}`)
  const primaryAlias = "sentinel-primary"
  const replicaAlias = "sentinel-replica"
  await runRedisContainer(primary, primaryAlias, 6379, [
    "redis-server",
    "--requirepass",
    Password,
    "--masterauth",
    Password,
    "--save",
    "",
    "--appendonly",
    "no"
  ])
  await ready(primary, Password)
  await runRedisContainer(replica, replicaAlias, 6379, [
    "redis-server",
    "--replicaof",
    primaryAlias,
    "6379",
    "--requirepass",
    Password,
    "--masterauth",
    Password,
    "--save",
    "",
    "--appendonly",
    "no"
  ])
  await ready(replica, Password)
  await waitForReplica(replica)
  for (const [index, sentinel] of sentinels.entries()) {
    await runSentinelContainer(sentinel, `sentinel-${index + 1}`, primaryAlias)
  }

  const primaryIp = await containerIp(primary)
  const replicaIp = await containerIp(replica)
  const primaryPort = await hostPort(primary, 6379)
  const replicaPort = await hostPort(replica, 6379)
  const nodeAddressMap: Record<string, RedisAddress> = {
    [`${primaryIp}:6379`]: { host: "127.0.0.1", port: primaryPort },
    [`${replicaIp}:6379`]: { host: "127.0.0.1", port: replicaPort },
    [`${primaryAlias}:6379`]: { host: "127.0.0.1", port: primaryPort },
    [`${replicaAlias}:6379`]: { host: "127.0.0.1", port: replicaPort }
  }
  const sentinelRootNodes: RedisAddress[] = []
  for (const sentinel of sentinels) {
    sentinelRootNodes.push({ host: "127.0.0.1", port: await hostPort(sentinel, 26379) })
  }
  const startedCaches: StartedCache[] = []
  try {
    const cache = await start(
      newRedisCache({
        client: () =>
          createSentinel({
            name: "likego-primary",
            sentinelRootNodes,
            nodeAddressMap,
            nodeClientOptions: { password: Password },
            passthroughClientErrorEvents: true,
            scanInterval: 100
          }),
        prefix: `${Prefix}sentinel:`,
        commandTimeoutMs: 5_000
      }),
      startedCaches
    )
    const beforeKey = `${Prefix}sentinel:before`
    const beforeValue = new Uint8Array([1])
    await cache.put(background(), "before", beforeValue)
    await waitForReplicaValue(
      replica,
      Password,
      beforeKey,
      encodeRedisCacheValue(beforeValue),
      false
    )
    await docker(["kill", primary])
    const promotedPrimary = await eventually("Sentinel primary failover", async () => {
      const selected = await sentinelPrimary(sentinels[0] ?? "")
      if (selected !== replicaIp && selected !== replicaAlias) {
        throw new Error("replica not promoted")
      }
      return selected
    })
    await eventually("Sentinel Cache write after failover", async () => {
      await cache.put(background(), "after", new Uint8Array([2]))
      const before = await cache.get(background(), "before")
      const after = await cache.get(background(), "after")
      if (before?.[0] !== 1 || after?.[0] !== 2) throw new Error("failover values unavailable")
    })
    return Object.freeze({
      rootNodes: sentinelRootNodes.length,
      failedPrimary: primaryIp,
      promotedPrimary,
      replicatedBeforeFailover: true,
      writeAfterFailover: true
    })
  } finally {
    await stopAll(startedCaches)
  }
}

/** Reads and parses one real Redis Cluster topology snapshot. */
async function clusterNodes(name: string): Promise<readonly ClusterNode[]> {
  const result = await docker(["exec", name, "redis-cli", "CLUSTER", "NODES"])
  const nodes: ClusterNode[] = []
  for (const line of result.stdout.split("\n")) {
    const fields = line.trim().split(/\s+/u)
    const id = fields[0]
    const address = fields[1]
    const flags = fields[2]
    const masterId = fields[3]
    if (
      id === undefined ||
      address === undefined ||
      flags === undefined ||
      masterId === undefined
    ) {
      continue
    }
    nodes.push(
      Object.freeze({
        id,
        address,
        flags: Object.freeze(flags.split(",")),
        masterId,
        slots: Object.freeze(fields.slice(8))
      })
    )
  }
  return Object.freeze(nodes)
}

/** Reports whether one Cluster node owns an exact stable slot. */
function ownsSlot(node: ClusterNode, slot: number): boolean {
  return node.slots.some(function owns(token): boolean {
    const match = /^(\d+)(?:-(\d+))?$/u.exec(token)
    if (match?.[1] === undefined) return false
    const start = Number(match[1])
    const end = match[2] === undefined ? start : Number(match[2])
    return slot >= start && slot <= end
  })
}

/** Waits until a surviving Cluster node reports a healthy topology. */
async function waitForCluster(name: string): Promise<void> {
  await eventually("Redis Cluster state", async () => {
    const result = await docker(["exec", name, "redis-cli", "CLUSTER", "INFO"], true)
    if (result.exitCode !== 0 || !result.stdout.includes("cluster_state:ok")) {
      throw new Error("cluster is not healthy")
    }
  })
}

/** Waits until every Redis Cluster replica has completed its initial synchronization. */
async function waitForClusterReplicas(names: readonly string[]): Promise<void> {
  await eventually("Redis Cluster replica synchronization", async () => {
    let replicas = 0
    for (const name of names) {
      const result = await docker(["exec", name, "redis-cli", "INFO", "replication"])
      if (!result.stdout.includes("role:slave")) continue
      replicas += 1
      if (
        !result.stdout.includes("master_link_status:up") ||
        !result.stdout.includes("master_sync_in_progress:0")
      ) {
        throw new Error(`${name} has not completed replication`)
      }
    }
    if (replicas !== 3) throw new Error(`expected 3 Redis Cluster replicas, received ${replicas}`)
  })
}

/** Verifies official createCluster routing and one real replica promotion. */
async function runClusterFailover(): Promise<ClusterEvidence> {
  const names = [1, 2, 3, 4, 5, 6].map((index) => `${Name}-cluster-${index}`)
  const aliases = [1, 2, 3, 4, 5, 6].map((index) => `cluster-${index}`)
  for (const [index, name] of names.entries()) {
    const alias = aliases[index]
    if (alias === undefined) throw new Error("Redis Cluster alias inventory is incomplete")
    await runRedisContainer(name, alias, 6379, [
      "redis-server",
      "--cluster-enabled",
      "yes",
      "--cluster-config-file",
      "nodes.conf",
      "--cluster-node-timeout",
      "1000",
      "--protected-mode",
      "no",
      "--save",
      "",
      "--appendonly",
      "no"
    ])
    await ready(name)
  }
  const firstName = names[0]
  if (firstName === undefined) throw new Error("Redis Cluster node inventory is empty")
  await docker([
    "exec",
    firstName,
    "redis-cli",
    "--cluster",
    "create",
    ...aliases.map((alias) => `${alias}:6379`),
    "--cluster-replicas",
    "1",
    "--cluster-yes"
  ])
  await waitForCluster(firstName)
  await waitForClusterReplicas(names)

  const ips: string[] = []
  const ports: number[] = []
  const nodeAddressMap: Record<string, RedisAddress> = {}
  for (const [index, name] of names.entries()) {
    const alias = aliases[index]
    if (alias === undefined) throw new Error("Redis Cluster alias inventory is incomplete")
    const ip = await containerIp(name)
    const port = await hostPort(name, 6379)
    ips.push(ip)
    ports.push(port)
    nodeAddressMap[`${ip}:6379`] = { host: "127.0.0.1", port }
    nodeAddressMap[`${alias}:6379`] = { host: "127.0.0.1", port }
  }
  const before = await clusterNodes(firstName)
  const masters = before.filter((node) => node.flags.includes("master"))
  const replicas = before.filter((node) => node.flags.includes("slave"))
  const firstIp = ips[0]
  const failed = masters.find((node) => node.address.startsWith(`${firstIp}:6379@`))
  if (failed === undefined) throw new Error("first Redis Cluster node is not a master")
  const promoted = replicas.find((node) => node.masterId === failed.id)
  if (promoted === undefined) throw new Error("failed Redis Cluster master has no replica")
  const rootNodes = ports.map((port) => ({ url: `redis://127.0.0.1:${port}` }))
  const startedCaches: StartedCache[] = []
  try {
    const cache = await start(
      newRedisCache({
        client: () => createCluster({ rootNodes, nodeAddressMap }),
        prefix: `${Prefix}cluster:`,
        commandTimeoutMs: 5_000
      }),
      startedCaches
    )
    await cache.put(background(), "{orders}:before", new Uint8Array([1]))
    await cache.put(background(), "{users}:before", new Uint8Array([2]))
    if (
      (await cache.get(background(), "{orders}:before"))?.[0] !== 1 ||
      (await cache.get(background(), "{users}:before"))?.[0] !== 2
    ) {
      throw new Error("cross-slot values unavailable before failover")
    }

    const failedKey = `${Prefix}cluster:{orders}:before`
    const slotResult = await docker([
      "exec",
      firstName,
      "redis-cli",
      "CLUSTER",
      "KEYSLOT",
      failedKey
    ])
    const failedKeySlot = Number(slotResult.stdout)
    if (!Number.isInteger(failedKeySlot) || !ownsSlot(failed, failedKeySlot)) {
      throw new Error("Redis Cluster failure key is not owned by the selected master")
    }
    const promotedIp = promoted.address.split(":")[0]
    const promotedIndex = promotedIp === undefined ? -1 : ips.indexOf(promotedIp)
    const promotedReplica = names[promotedIndex]
    if (promotedReplica === undefined) throw new Error("promoted Redis Cluster replica is unknown")
    await waitForReplicaValue(
      promotedReplica,
      null,
      failedKey,
      encodeRedisCacheValue(new Uint8Array([1])),
      true
    )

    await docker(["kill", firstName])
    const surviving = names[1]
    if (surviving === undefined) throw new Error("Redis Cluster has no surviving probe")
    await eventually("Redis Cluster replica promotion", async () => {
      await waitForCluster(surviving)
      const current = await clusterNodes(surviving)
      const selected = current.find((node) => node.id === promoted.id)
      if (selected === undefined || !selected.flags.includes("master")) {
        throw new Error("replica has not been promoted")
      }
    })
    await eventually("Redis Cluster Cache after failover", async () => {
      await cache.put(background(), "{orders}:after", new Uint8Array([3]))
      await cache.put(background(), "{users}:after", new Uint8Array([4]))
      if (
        (await cache.get(background(), "{orders}:before"))?.[0] !== 1 ||
        (await cache.get(background(), "{users}:before"))?.[0] !== 2 ||
        (await cache.get(background(), "{orders}:after"))?.[0] !== 3 ||
        (await cache.get(background(), "{users}:after"))?.[0] !== 4
      ) {
        throw new Error("cross-slot values unavailable after failover")
      }
    })
    return Object.freeze({
      masters: masters.length,
      replicas: replicas.length,
      failedMasterId: failed.id,
      failedKeySlot,
      promotedMasterId: promoted.id,
      crossSlotBeforeFailover: true,
      crossSlotAfterFailover: true,
      replicatedBeforeFailover: true
    })
  } finally {
    await stopAll(startedCaches)
  }
}

/** Removes every integration resource with this exact run label and proves none remain. */
async function cleanup(): Promise<
  Readonly<{ residualContainers: number; residualNetworks: number; residualVolumes: number }>
> {
  const listed = await docker(["ps", "--all", "--quiet", "--filter", `label=${Label}`])
  const names = listed.stdout.split("\n").filter(function present(value) {
    return value.length > 0
  })
  if (names.length > 0) await docker(["rm", "--force", ...names])
  const remaining = await docker(["ps", "--all", "--quiet", "--filter", `label=${Label}`])
  const residualContainers = remaining.stdout.split("\n").filter(function present(value) {
    return value.length > 0
  }).length
  if (residualContainers !== 0) throw new Error("Redis integration containers remain")
  const networks = await docker(["network", "ls", "--quiet", "--filter", `label=${Label}`])
  const networkIds = networks.stdout.split("\n").filter(function present(value) {
    return value.length > 0
  })
  if (networkIds.length > 0) await docker(["network", "rm", ...networkIds])
  const remainingNetworks = await docker(["network", "ls", "--quiet", "--filter", `label=${Label}`])
  const residualNetworks = remainingNetworks.stdout.split("\n").filter(function present(value) {
    return value.length > 0
  }).length
  if (residualNetworks !== 0) throw new Error("Redis integration networks remain")
  const volumes = await docker(["volume", "ls", "--quiet", "--filter", `label=${Label}`])
  const volumeNames = volumes.stdout.split("\n").filter(function present(value) {
    return value.length > 0
  })
  if (volumeNames.length > 0) await docker(["volume", "rm", "--force", ...volumeNames])
  const remainingVolumes = await docker(["volume", "ls", "--quiet", "--filter", `label=${Label}`])
  const residualVolumes = remainingVolumes.stdout.split("\n").filter(function present(value) {
    return value.length > 0
  }).length
  if (residualVolumes !== 0) throw new Error("Redis integration volumes remain")
  await rm(ArtifactRoot, { recursive: true, force: true })
  return Object.freeze({ residualContainers, residualNetworks, residualVolumes })
}

/** Executes the complete real Redis integration scenario. */
async function main(_ctx: Context = background()): Promise<void> {
  await cleanup()
  let redisVersion: string | null = null
  let plainConformanceCases = 0
  let direct: Readonly<Record<string, unknown>> | null = null
  let tls: Readonly<Record<string, unknown>> | null = null
  let sentinel: SentinelEvidence | null = null
  let cluster: ClusterEvidence | null = null
  let primary: { readonly value: unknown } | null = null
  try {
    await docker(["network", "create", "--label", Label, "--label", DockerOwnerLabel, Network])
    await docker([
      "run",
      "--detach",
      "--name",
      Name,
      "--hostname",
      Name,
      "--network",
      Network,
      "--label",
      Label,
      "--label",
      DockerOwnerLabel,
      "--publish",
      "127.0.0.1::6379",
      Image,
      "redis-server",
      "--save",
      "",
      "--appendonly",
      "no"
    ])
    await ready()
    const redisUrl = await address()
    plainConformanceCases = await runConformance((prefix) =>
      newRedisCache({ url: redisUrl, prefix })
    )
    direct = await runDirect(redisUrl)
    redisVersion = await serverVersion()
    if (redisVersion !== RedisVersion) {
      throw new Error(`expected Redis ${RedisVersion}, received ${redisVersion}`)
    }
    tls = await runTls()
    sentinel = await runSentinelFailover()
    cluster = await runClusterFailover()
  } catch (value) {
    primary = Object.freeze({ value })
  }

  let cleanupEvidence: Readonly<{
    residualContainers: number
    residualNetworks: number
    residualVolumes: number
  }> | null = null
  let cleanupFailure: { readonly value: unknown } | null = null
  try {
    cleanupEvidence = await cleanup()
  } catch (value) {
    cleanupFailure = Object.freeze({ value })
  }
  if (primary !== null && cleanupFailure !== null) {
    throw new AggregateError(
      [primary.value, cleanupFailure.value],
      "Redis integration and cleanup failed"
    )
  }
  if (primary !== null) throw primary.value
  if (cleanupFailure !== null) throw cleanupFailure.value
  if (
    redisVersion === null ||
    direct === null ||
    tls === null ||
    sentinel === null ||
    cluster === null ||
    cleanupEvidence === null
  ) {
    throw new Error("Redis integration completed without scenario evidence")
  }
  const result = Object.freeze({
    image: Image,
    redisVersion,
    nodeRedisVersion: NodeRedisVersion,
    conformanceCases: Object.freeze({
      plain: plainConformanceCases,
      tls: tls.conformanceCases
    }),
    direct,
    tls,
    sentinel,
    cluster,
    cleanup: cleanupEvidence
  })
  console.log(`${ResultMarker}=${JSON.stringify(result)}`)
}

await main()
