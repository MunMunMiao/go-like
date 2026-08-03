import { newRedisCache } from "@likego/cache-redis"
import { newClient, withDiscovery, withSelector, withTransport, type Client } from "@likego/client"
import { background } from "@likego/context"
import {
  endpoint,
  id,
  name,
  newApp,
  registrar,
  server,
  stopTimeout,
  version,
  type App
} from "@likego/core"
import { newRoundRobinSelector } from "@likego/registry"
import { newConsulRegistry } from "@likego/registry-consul"
import {
  address,
  handler as serviceHandler,
  newServer,
  transport as serverTransport
} from "@likego/server"
import { newHTTPTransport } from "@likego/transport-http"
import { newNodeHTTPTransport } from "@likego/transport-http/node"

import {
  closeOwnedDockerContext,
  createContainer,
  ownedDockerContextFromEnvironment,
  scenarioDockerEnvironment,
  type OwnedDockerContext
} from "../../../e2e/harness/owned-docker"
import { newCatalogHandler } from "../src/http"
import { newPricingHandler } from "../src/pricing"

const ConsulImage =
  "hashicorp/consul:2.0.2@sha256:7dcf35d6b2682831094f1680aa58be214134969505acce0a9b280249581aa7d2"
const RedisImage =
  "redis:8.10.0-alpine@sha256:978f0e01593e65eed801f2402944efcd936d43b5027e4908a7897baf88ed6241"
const RunId = crypto.randomUUID()
const ConsulName = `likego-commerce-consul-${RunId}`
const RedisName = `likego-commerce-redis-${RunId}`

interface CommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

/** Runs one argv-safe Docker command and captures its complete outcome. */
async function docker(
  ownedDocker: OwnedDockerContext,
  operation: string,
  args: readonly string[],
  allowFailure = false
): Promise<CommandResult> {
  let result: CommandResult
  try {
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
    result = Object.freeze({
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode
    })
  } catch {
    throw new Error(`Docker ${operation} did not complete`)
  }
  if (result.exitCode !== 0 && !allowFailure) {
    throw new Error(`Docker ${operation} failed (${result.exitCode})`)
  }
  return result
}

/** Waits one bounded polling interval. */
function pause(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}

/** Returns one random host port currently mapped by Docker. */
async function mappedPort(
  ownedDocker: OwnedDockerContext,
  container: string,
  internalPort: number
): Promise<number> {
  const result = await docker(ownedDocker, "read container port", [
    "port",
    container,
    `${internalPort}/tcp`
  ])
  const match = /:([0-9]+)$/u.exec(result.stdout.split("\n")[0] ?? "")
  if (match?.[1] === undefined) throw new Error("invalid Docker port mapping")
  return Number(match[1])
}

/** Polls real Consul and Redis processes until both are ready. */
async function waitForServices(ownedDocker: OwnedDockerContext, consul: string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const leader = await fetch(`${consul}/v1/status/leader`)
      const redis = await docker(
        ownedDocker,
        "probe Redis readiness",
        ["exec", RedisName, "redis-cli", "PING"],
        true
      )
      if (leader.ok && (await leader.text()).length > 2 && redis.stdout === "PONG") return
    } catch {
      // Docker publishes ports before both processes necessarily accept traffic.
    }
    await pause(100)
  }
  throw new Error("Consul and Redis did not become ready within 30 seconds")
}

/** Waits for the exact count of passing Pricing registrations. */
async function waitForPricingCount(consul: string, expected: number): Promise<void> {
  const deadline = Date.now() + 10_000
  let observed = -1
  while (Date.now() < deadline) {
    const response = await fetch(`${consul}/v1/health/service/pricing?passing=true`)
    if (response.ok) {
      const services: unknown = await response.json()
      if (Array.isArray(services)) {
        observed = services.length
        if (observed === expected) return
      }
    } else await response.body?.cancel()
    await pause(25)
  }
  throw new Error(`Consul exposed ${observed} passing Pricing registrations; expected ${expected}`)
}

/** Waits until one Cache is admitted by its owning Core App. */
async function waitForCache(cache: ReturnType<typeof newRedisCache>): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      await cache.get(background(), "ready")
      return
    } catch {
      await pause(10)
    }
  }
  throw new Error("Redis Cache did not enter its running state")
}

/** Stops and joins one Core App. */
async function stopApp(app: App, running: Promise<void>): Promise<void> {
  await app.stop()
  await running
}

/** Executes the real registration, discovery, transport, cache, and Hono scenario. */
async function main(): Promise<void> {
  const ownedDocker = await ownedDockerContextFromEnvironment(process.env)
  let pricingApp: App | null = null
  let pricingRun: Promise<void> | null = null
  let catalogApp: App | null = null
  let catalogRun: Promise<void> | null = null
  let client: Client | null = null
  let consulAddress = ""
  let primary: { readonly value: unknown } | null = null
  const cleanupFailures: unknown[] = []
  let consulVersion = "unobserved"
  let redisVersion = "unobserved"
  let pricingCalls = 0
  try {
    await createContainer(
      ownedDocker,
      [
        "--name",
        ConsulName,
        "--tmpfs",
        "/consul/data:rw,noexec,nosuid,size=64m",
        "--publish",
        "127.0.0.1::8500",
        ConsulImage,
        "agent",
        "-dev",
        "-client=0.0.0.0",
        "-log-level=warn"
      ],
      { knownSecrets: [] }
    )
    await createContainer(
      ownedDocker,
      [
        "--name",
        RedisName,
        "--publish",
        "127.0.0.1::6379",
        RedisImage,
        "redis-server",
        "--save",
        "",
        "--appendonly",
        "no"
      ],
      { knownSecrets: [] }
    )
    consulAddress = `http://127.0.0.1:${await mappedPort(ownedDocker, ConsulName, 8500)}`
    const redisUrl = `redis://127.0.0.1:${await mappedPort(ownedDocker, RedisName, 6379)}`
    await waitForServices(ownedDocker, consulAddress)

    const consulReference = await docker(ownedDocker, "inspect Consul image", [
      "inspect",
      "--format",
      "{{.Config.Image}}",
      ConsulName
    ])
    const redisReference = await docker(ownedDocker, "inspect Redis image", [
      "inspect",
      "--format",
      "{{.Config.Image}}",
      RedisName
    ])
    if (consulReference.stdout !== ConsulImage || redisReference.stdout !== RedisImage) {
      throw new Error("Docker image references drifted from the exact pinned digests")
    }
    consulVersion =
      (
        await docker(ownedDocker, "read Consul version", ["exec", ConsulName, "consul", "version"])
      ).stdout.split("\n")[0] ?? "missing"
    const redisInfo = await docker(ownedDocker, "read Redis version", [
      "exec",
      RedisName,
      "redis-cli",
      "INFO",
      "server"
    ])
    redisVersion =
      redisInfo.stdout
        .split("\n")
        .find((line) => line.startsWith("redis_version:"))
        ?.slice("redis_version:".length)
        .trim() ?? "missing"
    if (!consulVersion.includes("2.0.2") || redisVersion !== "8.10.0") {
      throw new Error(`unexpected container versions: ${consulVersion}, redis ${redisVersion}`)
    }

    const registry = newConsulRegistry({
      fetch,
      address: consulAddress,
      waitMs: 1_000,
      minimumQueryIntervalMs: 20,
      retryInitialMs: 50,
      retryMaximumMs: 200,
      deregisterCriticalServiceAfterMs: 60_000
    })
    const pricingServer = newServer(
      serverTransport(newNodeHTTPTransport()),
      address("127.0.0.1:0"),
      serviceHandler(
        "pricing",
        "Pricing.Get",
        newPricingHandler(function countCall(): void {
          pricingCalls += 1
        })
      )
    )
    const pricingEndpoint = await pricingServer.endpoint(background())
    pricingApp = newApp(
      id(`pricing-${RunId}`),
      name("pricing"),
      version("v1"),
      endpoint(pricingEndpoint),
      registrar(registry),
      stopTimeout(10_000),
      server(pricingServer)
    )
    pricingRun = pricingApp.run()
    void pricingRun.catch(() => {})
    await waitForPricingCount(consulAddress, 1)

    const cachePrefix = `likego:example:commerce:${RunId}:`
    const cache = newRedisCache({
      url: redisUrl,
      prefix: cachePrefix,
      connectTimeoutMs: 5_000,
      commandTimeoutMs: 5_000
    })
    client = newClient(
      withDiscovery(registry),
      withSelector(newRoundRobinSelector()),
      withTransport(newHTTPTransport())
    )
    catalogApp = newApp(name("commerce-catalog"), stopTimeout(10_000), server(cache))
    catalogRun = catalogApp.run()
    void catalogRun.catch(() => {})
    await waitForCache(cache)
    const handler = newCatalogHandler({ cache, client })

    const first = await handler(new Request("http://example.test/v1/products/sku-001?currency=USD"))
    const firstBody = await first.text()
    if (first.status !== 200 || !firstBody.includes('"amountMinor":1299') || pricingCalls !== 1) {
      throw new Error(
        `first Hono request failed: status=${first.status}, pricingCalls=${pricingCalls}`
      )
    }
    const redisKey = `${cachePrefix}price:v1:USD:sku-001`
    const cached = await docker(ownedDocker, "read Redis cache key", [
      "exec",
      RedisName,
      "redis-cli",
      "EXISTS",
      redisKey
    ])
    if (cached.stdout !== "1") throw new Error("first Pricing response was not present in Redis")

    const second = await handler(
      new Request("http://example.test/v1/products/sku-001?currency=USD")
    )
    const secondBody = await second.text()
    if (second.status !== 200 || secondBody !== firstBody || pricingCalls !== 1) {
      throw new Error("second Hono request did not use the real Redis cache hit")
    }

    await stopApp(catalogApp, catalogRun)
    catalogApp = null
    catalogRun = null
    await stopApp(pricingApp, pricingRun)
    pricingApp = null
    pricingRun = null
    await waitForPricingCount(consulAddress, 0)

    const programPort = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(null, { status: 204 })
    })
    const portNumber = programPort.port
    programPort.stop(true)
    if (portNumber === undefined) throw new Error("Bun did not allocate the program port")
    const program = (() => {
      try {
        return Bun.spawn(["bun", "run", "start:prepared"], {
          cwd: `${import.meta.dir}/..`,
          env: {
            ...scenarioDockerEnvironment(ownedDocker),
            HOST: "127.0.0.1",
            PORT: String(portNumber),
            CONSUL_HTTP_ADDR: consulAddress,
            REDIS_URL: redisUrl
          },
          detached: true,
          stdout: "pipe",
          stderr: "pipe"
        })
      } catch {
        throw new Error("start:prepared command did not start")
      }
    })()
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
    const errorTask = new Response(program.stderr).arrayBuffer()
    let outputJoined = false
    let forced = false
    let terminationTimeout: ReturnType<typeof setTimeout> | null = null
    try {
      await waitForPricingCount(consulAddress, 1)
      let body = ""
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        if (programOutput.includes('LIKEGO_EXAMPLE_READY={"example":"commerce-catalog"')) {
          const response = await fetch(
            `http://127.0.0.1:${portNumber}/v1/products/sku-001?currency=USD`
          )
          body = await response.text()
          if (response.status === 200 && body.includes('"amountMinor":1299')) break
        }
        await pause(25)
      }
      if (!body.includes('"amountMinor":1299')) {
        throw new Error("start:prepared catalog probe failed")
      }
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
      if (exitCode !== 0 && exitCode !== 143) {
        await errorTask
        throw new Error(`start:prepared exited ${exitCode}`)
      }
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
    }
    await waitForPricingCount(consulAddress, 0)
    const released = Bun.serve({
      hostname: "127.0.0.1",
      port: portNumber,
      fetch: () => new Response(null, { status: 204 })
    })
    released.stop(true)
  } catch (error) {
    primary = Object.freeze({ value: error })
  } finally {
    if (client !== null) {
      try {
        await client.close(background())
      } catch (error) {
        cleanupFailures.push(error)
      }
    }
    if (catalogApp !== null && catalogRun !== null) {
      try {
        await stopApp(catalogApp, catalogRun)
      } catch (error) {
        cleanupFailures.push(error)
      }
    }
    if (pricingApp !== null && pricingRun !== null) {
      try {
        await stopApp(pricingApp, pricingRun)
      } catch (error) {
        cleanupFailures.push(error)
      }
    }
    if (consulAddress !== "") {
      try {
        await waitForPricingCount(consulAddress, 0)
      } catch (error) {
        cleanupFailures.push(error)
      }
    }
    try {
      await closeOwnedDockerContext(ownedDocker)
    } catch (error) {
      cleanupFailures.push(error)
    }
  }

  if (primary !== null || cleanupFailures.length > 0) {
    const failures = primary === null ? cleanupFailures : [primary.value, ...cleanupFailures]
    throw new AggregateError(failures, "Commerce catalog Docker scenario failed")
  }
}

await main()
