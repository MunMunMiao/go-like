import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { newRedisCache } from "@likego/cache-redis"
import { newConfig, schema, source, type ConfigObject } from "@likego/config"
import { consulSource } from "@likego/config-consul"
import { background, withoutCancel } from "@likego/context"
import { afterStop, beforeStart, name, newApp, server, stopTimeout, type App } from "@likego/core"
import { newPinoServer } from "@likego/pino"
import pino from "pino"

import { tenantDocumentSchema } from "../src/config"
import { newTenantHandler } from "../src/http"
import { newTenantRuntimeState } from "../src/runtime-state"

const ConsulImage =
  "hashicorp/consul:2.0.2@sha256:7dcf35d6b2682831094f1680aa58be214134969505acce0a9b280249581aa7d2"
const RedisImage =
  "redis:8.8.1-alpine@sha256:8096655e437712b07503796fb64d81359256cfcff0ab29d95a7da72863786efb"
const RunId = crypto.randomUUID()
const Owner = `saas-tenant-api-${RunId}`
const OwnerLabel = `io.likego.e2e.owner=${Owner}`
const ConsulName = `likego-saas-consul-${RunId}`
const RedisName = `likego-saas-redis-${RunId}`
const ConfigKey = "likego/examples/saas-tenant-api/config"

interface CommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

/** Runs one argv-safe Docker command and captures its complete outcome. */
async function docker(args: readonly string[], allowFailure = false): Promise<CommandResult> {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" })
  const stdout = new Response(child.stdout).text()
  const stderr = new Response(child.stderr).text()
  const exitCode = await child.exited
  const result = Object.freeze({
    stdout: (await stdout).trim(),
    stderr: (await stderr).trim(),
    exitCode
  })
  if (exitCode !== 0 && !allowFailure) {
    throw new Error(`docker ${args.join(" ")} failed (${exitCode}): ${result.stderr}`)
  }
  return result
}

/** Waits one bounded polling interval. */
function pause(milliseconds: number): Promise<void> {
  return new Promise<void>(function wait(resolve): void {
    setTimeout(resolve, milliseconds)
  })
}

/** Returns one random host port currently mapped by Docker. */
async function mappedPort(container: string, internalPort: number): Promise<number> {
  const result = await docker(["port", container, `${internalPort}/tcp`])
  const match = /:([0-9]+)$/u.exec(result.stdout.split("\n")[0] ?? "")
  if (match?.[1] === undefined) throw new Error(`invalid Docker port mapping: ${result.stdout}`)
  return Number(match[1])
}

/** Polls real Consul and Redis processes until both are ready. */
async function waitForServices(consul: string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const leader = await fetch(`${consul}/v1/status/leader`)
      const redis = await docker(["exec", RedisName, "redis-cli", "PING"], true)
      if (leader.ok && (await leader.text()).length > 2 && redis.stdout === "PONG") return
    } catch {
      // Docker publishes ports before both processes necessarily accept traffic.
    }
    await pause(100)
  }
  throw new Error("Consul and Redis did not become ready within 30 seconds")
}

/** Writes one complete JSON document to the exact Consul KV key. */
async function putConfig(address: string, value: ConfigObject): Promise<void> {
  const response = await fetch(`${address}/v1/kv/${ConfigKey}`, {
    method: "PUT",
    body: JSON.stringify(value)
  })
  if (!response.ok || (await response.text()) !== "true") throw new Error("Consul KV write failed")
}

/** Creates one valid two-tenant generation. */
function document(generation: string, exportsEnabled: boolean): ConfigObject {
  return {
    schemaVersion: 1,
    generation,
    cacheTtlMs: 30_000,
    tenants: {
      "tenant-acme": {
        enabled: true,
        plan: "pro",
        features: { exports: exportsEnabled, auditLog: true },
        rateLimit: { capacity: 10, refillTokens: 10, refillIntervalMs: 60_000 }
      },
      "tenant-beta": {
        enabled: true,
        plan: "basic",
        features: { exports: false },
        rateLimit: { capacity: 1, refillTokens: 1, refillIntervalMs: 60_000 }
      }
    }
  }
}

/** Waits for one exact automatic Config publication. */
async function waitForGeneration(
  config: ReturnType<typeof newConfig>,
  expected: string
): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (config.value("generation").load() === expected) return
    await pause(25)
  }
  throw new Error(`Config did not publish ${expected}`)
}

/** Waits until the real Redis Cache server has completed connection admission. */
async function waitForCache(cache: ReturnType<typeof newRedisCache>): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      await cache.get(background(), "e2e-readiness")
      return
    } catch {
      await pause(25)
    }
  }
  throw new Error("Redis Cache did not become ready")
}

/** Stops and joins one Core application. */
async function stopApp(app: App, running: Promise<void>): Promise<void> {
  await app.stop()
  await running
}

/** Removes every container carrying this exact unique owner label. */
async function cleanupContainers(): Promise<void> {
  const listed = await docker(["ps", "--all", "--quiet", "--filter", `label=${OwnerLabel}`])
  const ids = listed.stdout.split("\n").filter(function present(value) {
    return value.length > 0
  })
  if (ids.length > 0) await docker(["rm", "--force", ...ids])
}

/** Executes the real Consul, Redis, Hono, limiter, and Pino scenario. */
async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "likego-saas-tenant-api-"))
  const logPath = join(directory, "requests.log")
  let app: App | null = null
  let appRun: Promise<void> | null = null
  let primary: unknown | null = null
  const cleanupFailures: unknown[] = []
  let consulVersion = "unobserved"
  let redisVersion = "unobserved"
  try {
    await cleanupContainers()
    await docker([
      "run",
      "--detach",
      "--name",
      ConsulName,
      "--label",
      OwnerLabel,
      "--tmpfs",
      "/consul/data:rw,noexec,nosuid,size=64m",
      "--publish",
      "127.0.0.1::8500",
      ConsulImage,
      "agent",
      "-dev",
      "-client=0.0.0.0",
      "-log-level=warn"
    ])
    await docker([
      "run",
      "--detach",
      "--name",
      RedisName,
      "--label",
      OwnerLabel,
      "--publish",
      "127.0.0.1::6379",
      RedisImage,
      "redis-server",
      "--save",
      "",
      "--appendonly",
      "no"
    ])
    const consulAddress = `http://127.0.0.1:${await mappedPort(ConsulName, 8500)}`
    const redisUrl = `redis://127.0.0.1:${await mappedPort(RedisName, 6379)}`
    await waitForServices(consulAddress)
    const consulReference = await docker(["inspect", "--format", "{{.Config.Image}}", ConsulName])
    const redisReference = await docker(["inspect", "--format", "{{.Config.Image}}", RedisName])
    if (consulReference.stdout !== ConsulImage || redisReference.stdout !== RedisImage) {
      throw new Error("Docker image references drifted from the exact pinned digests")
    }
    consulVersion =
      (await docker(["exec", ConsulName, "consul", "version"])).stdout.split("\n")[0] ?? "missing"
    const redisInfo = await docker(["exec", RedisName, "redis-cli", "INFO", "server"])
    redisVersion =
      redisInfo.stdout
        .split("\n")
        .find(function version(line) {
          return line.startsWith("redis_version:")
        })
        ?.slice("redis_version:".length)
        .trim() ?? "missing"
    if (!consulVersion.includes("2.0.2") || redisVersion !== "8.8.1") {
      throw new Error(`unexpected container versions: ${consulVersion}, redis ${redisVersion}`)
    }
    await putConfig(consulAddress, document("generation-1", true))
    const config = newConfig(
      source(
        consulSource({
          fetch,
          address: consulAddress,
          key: ConfigKey,
          waitMs: 1_000,
          retryInitialMs: 50,
          retryMaximumMs: 200
        })
      ),
      schema(tenantDocumentSchema)
    )
    const runtimeState = newTenantRuntimeState(consulAddress, RunId)
    const cache = newRedisCache({
      url: redisUrl,
      prefix: `likego:example:saas:${RunId}:`,
      connectTimeoutMs: 5_000,
      commandTimeoutMs: 5_000
    })
    const destination = pino.destination({ dest: logPath, sync: false })
    const logger = pino(
      {
        base: null,
        redact: ["authorization", "cookie", "token", "password", "secret"]
      },
      destination
    )
    const handler = newTenantHandler({
      config,
      cache,
      logger,
      resolveTenant(_ctx, request) {
        return request.headers.get("X-Demo-Tenant") ?? ""
      }
    })
    app = newApp(
      name("saas-tenant-api"),
      stopTimeout(15_000),
      beforeStart(async function loadRuntime(ctx): Promise<void> {
        await config.load(ctx)
        await runtimeState.publish(ctx)
      }),
      server(newPinoServer(logger, destination), cache),
      afterStop(async function closeRuntime(ctx): Promise<void> {
        const cleanup = withoutCancel(ctx)
        try {
          await runtimeState.remove(cleanup)
        } finally {
          await config.close(cleanup)
        }
      })
    )
    appRun = app.run()
    void appRun.catch(() => {})
    await Promise.all([waitForGeneration(config, "generation-1"), waitForCache(cache)])
    const call = (tenantId: string) =>
      handler(
        new Request("http://example.test/v1/tenant/config", {
          headers: {
            "X-Demo-Tenant": tenantId,
            Authorization: "Bearer must-not-log"
          }
        })
      )
    const first = await call("tenant-acme")
    const firstBody: unknown = await first.json()
    if (first.status !== 200 || JSON.stringify(firstBody).includes("tenant-beta")) {
      throw new Error("first tenant response failed isolation")
    }
    const second = await call("tenant-acme")
    if (second.status !== 200) throw new Error("second tenant request failed")
    await second.arrayBuffer()
    const beta = await call("tenant-beta")
    const betaBody: unknown = await beta.json()
    if (
      beta.status !== 200 ||
      betaBody === null ||
      typeof betaBody !== "object" ||
      !("tenantId" in betaBody) ||
      betaBody.tenantId !== "tenant-beta"
    ) {
      throw new Error("second tenant response failed isolation")
    }
    const limited = await call("tenant-beta")
    if (limited.status !== 429 || limited.headers.get("Retry-After") !== "60") {
      throw new Error("tenant limiter did not reject the second request")
    }
    await limited.arrayBuffer()

    await putConfig(consulAddress, document("generation-2", false))
    await waitForGeneration(config, "generation-2")
    const updated = await call("tenant-acme")
    const updatedBody: unknown = await updated.json()
    if (
      updated.status !== 200 ||
      updatedBody === null ||
      typeof updatedBody !== "object" ||
      !("generation" in updatedBody) ||
      updatedBody.generation !== "generation-2"
    ) {
      throw new Error("generation switch was not visible through the public API")
    }
    await stopApp(app, appRun)
    app = null
    appRun = null

    const records = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .filter(function present(line) {
        return line.length > 0
      })
      .map(function parse(line): unknown {
        return JSON.parse(line)
      })
    const cacheMiss = records.some(function miss(record) {
      return (
        record !== null &&
        typeof record === "object" &&
        "cacheHit" in record &&
        record.cacheHit === false
      )
    })
    const cacheHit = records.some(function hit(record) {
      return (
        record !== null &&
        typeof record === "object" &&
        "cacheHit" in record &&
        record.cacheHit === true
      )
    })
    const rateLimited = records.some(function limitedRecord(record) {
      return (
        record !== null &&
        typeof record === "object" &&
        "rateLimited" in record &&
        record.rateLimited === true
      )
    })
    const leakedSecret = records.some(function secret(record) {
      return JSON.stringify(record).includes("must-not-log")
    })
    if (!cacheMiss || !cacheHit || !rateLimited || leakedSecret) {
      const diagnostics = records.flatMap(function diagnostic(record): string[] {
        if (
          record === null ||
          typeof record !== "object" ||
          !("diagnostic" in record) ||
          typeof record.diagnostic !== "string"
        ) {
          return []
        }
        return [record.diagnostic]
      })
      throw new Error(
        `Pino readback failed: cacheMiss=${cacheMiss}, cacheHit=${cacheHit}, rateLimited=${rateLimited}, leakedSecret=${leakedSecret}, diagnostics=${JSON.stringify(diagnostics)}`
      )
    }

    const reservation = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(null, { status: 204 })
    })
    const programPort = reservation.port
    reservation.stop(true)
    if (programPort === undefined) throw new Error("Bun did not allocate the program port")
    const program = Bun.spawn(["bun", "run", "start:prepared"], {
      cwd: `${import.meta.dir}/..`,
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(programPort),
        CONSUL_HTTP_ADDR: consulAddress,
        REDIS_URL: redisUrl,
        CONFIG_KEY: ConfigKey
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
    let outputJoined = false
    let forced = false
    let terminationTimeout: ReturnType<typeof setTimeout> | null = null
    try {
      const deadline = Date.now() + 30_000
      let payload: unknown = null
      while (Date.now() < deadline) {
        if (programOutput.includes('LIKEGO_EXAMPLE_READY={"example":"saas-tenant-api"')) {
          const response = await fetch(`http://127.0.0.1:${programPort}/v1/tenant/config`, {
            headers: { "X-Tenant-Id": "tenant-acme" }
          })
          payload = await response.json()
          if (
            response.status === 200 &&
            payload !== null &&
            typeof payload === "object" &&
            "generation" in payload &&
            payload.generation === "generation-2"
          ) {
            break
          }
        }
        await pause(25)
      }
      if (
        payload === null ||
        typeof payload !== "object" ||
        !("generation" in payload) ||
        payload.generation !== "generation-2"
      ) {
        throw new Error(`start:prepared tenant probe failed: ${JSON.stringify(payload)}`)
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
        throw new Error(`start:prepared exited ${exitCode}: ${(await errorTask).trim()}`)
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
    const released = Bun.serve({
      hostname: "127.0.0.1",
      port: programPort,
      fetch: () => new Response(null, { status: 204 })
    })
    released.stop(true)
  } catch (error) {
    primary = error
  } finally {
    if (app !== null && appRun !== null) {
      try {
        await stopApp(app, appRun)
      } catch (error) {
        cleanupFailures.push(error)
      }
    }
    try {
      await cleanupContainers()
    } catch (error) {
      cleanupFailures.push(error)
    }
    try {
      await rm(directory, { recursive: true, force: true })
    } catch (error) {
      cleanupFailures.push(error)
    }
  }
  try {
    const remaining = await docker(["ps", "--all", "--quiet", "--filter", `label=${OwnerLabel}`])
    if (remaining.stdout !== "")
      cleanupFailures.push(new Error(`Docker resources leaked: ${remaining.stdout}`))
  } catch (error) {
    cleanupFailures.push(error)
  }
  if (primary !== null && cleanupFailures.length === 0) throw primary
  if (primary !== null || cleanupFailures.length > 0) {
    const failures = primary === null ? cleanupFailures : [primary, ...cleanupFailures]
    throw new AggregateError(failures, "SaaS tenant Docker scenario failed")
  }
  console.log(
    `LIKEGO_EXAMPLE_SAAS_TENANT_API_E2E_RESULT=${JSON.stringify({
      valid: true,
      images: { consul: ConsulImage, redis: RedisImage },
      versions: { consul: consulVersion, redis: redisVersion },
      scenarios: [
        "consul-config-load-watch",
        "consul-store-runtime-state",
        "generation-switch",
        "redis-cache-hit",
        "tenant-isolation",
        "tenant-rate-limit",
        "pino-flush-redaction",
        "start-prepared-entrypoint"
      ],
      residualContainers: 0
    })}`
  )
}

await main()
