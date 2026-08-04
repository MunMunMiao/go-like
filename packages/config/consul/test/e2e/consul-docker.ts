import { background, withTimeout } from "@go-like/context"
import {
  newConfig,
  source as configSource,
  type Config,
  type ConfigObject,
  type ConfigValue
} from "@go-like/config"
import { consulSource, type ConsulFetch } from "../../src/index"

const Image =
  "hashicorp/consul:2.0.2@sha256:7dcf35d6b2682831094f1680aa58be214134969505acce0a9b280249581aa7d2"
const Version = "2.0.2"
const RunId = crypto.randomUUID()
const Name = `go-like-config-consul-${RunId}`
const Label = `go-like.config-consul.integration=${RunId}`
const DockerOwner = process.env.GO_LIKE_E2E_OWNER
if (DockerOwner === undefined || !/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(DockerOwner))
  throw new Error("invalid GO_LIKE_E2E_OWNER")
const DockerOwnerLabel = `io.go-like.e2e.owner=${DockerOwner}`

interface CommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

interface ConfigRuntime {
  readonly config: Config
}

/** Runs one argv-safe Docker command and returns its complete observed result. */
async function command(args: readonly string[], allowFailure = false): Promise<CommandResult> {
  const process = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" })
  const stdoutPromise = new Response(process.stdout).text()
  const stderrPromise = new Response(process.stderr).text()
  const exitCode = await process.exited
  const stdout = (await stdoutPromise).trim()
  const stderr = (await stderrPromise).trim()
  if (exitCode !== 0 && !allowFailure) {
    throw new Error(`docker ${args.join(" ")} failed (${exitCode}): ${stderr}`)
  }
  return Object.freeze({ stdout, stderr, exitCode })
}

/** Creates one fresh pinned Consul container on the scenario's fixed loopback port. */
async function startContainer(port: number): Promise<void> {
  await command([
    "run",
    "--detach",
    "--name",
    Name,
    "--label",
    Label,
    "--label",
    DockerOwnerLabel,
    "--tmpfs",
    "/consul/data:rw,noexec,nosuid,size=64m",
    "--publish",
    `127.0.0.1:${port}:8500`,
    Image,
    "agent",
    "-dev",
    "-client=0.0.0.0"
  ])
}

/** Waits for one short readiness retry interval. */
function pause(timeoutMs: number): Promise<void> {
  return new Promise<void>(function wait(resolve) {
    setTimeout(resolve, timeoutMs)
  })
}

/** Counts active JavaScript timeout resources for watcher-cleanup evidence. */
function activeTimerCount(): number {
  return process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length
}

/** Reserves and releases one OS-selected loopback port for the Docker restart scenario. */
function availablePort(): number {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      /** Ignores data during the zero-acceptance reservation window. */
      data() {}
    }
  })
  const port = listener.port
  listener.stop(true)
  return port
}

/** Polls both leader election and a consistent KV read until the dev agent is ready. */
async function waitForConsul(address: string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const leader = await fetch(`${address}/v1/status/leader`)
      const elected = leader.ok && (await leader.text()).length > 2
      if (elected) {
        const kv = await fetch(`${address}/v1/kv/__go-like_readiness?consistent`)
        await kv.arrayBuffer()
        if ((kv.ok || kv.status === 404) && kv.headers.has("X-Consul-Index")) return
      }
    } catch {
      // The container is expected to refuse connections while its dev agent starts.
    }
    await pause(100)
  }
  throw new Error("Consul container did not become ready within 30 seconds")
}

/** Writes one complete JSON document into the exact real Consul KV key. */
async function putConfig(address: string, value: string): Promise<void> {
  const response = await fetch(`${address}/v1/kv/app/config`, { method: "PUT", body: value })
  if (!response.ok || (await response.text()) !== "true") throw new Error("Consul KV write failed")
}

/** Advances the queried key so the pinned restart scenario can observe a lower replacement index. */
async function advanceConsulIndex(address: string, writes: number): Promise<void> {
  for (let index = 0; index < writes; index += 1) {
    await putConfig(address, `{"release":1,"feature":{"enabled":false},"indexSeed":${index}}`)
  }
}

/** Narrows one published configuration value to its object alternative. */
function configObject(value: ConfigValue | undefined): value is ConfigObject {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value)
}

/** Waits for automatic Config publication of one exact release value. */
async function waitForRelease(config: Config, release: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  const current = config.value("release")
  while (Date.now() < deadline) {
    if (current.load() === release) return
    await pause(25)
  }
  throw new Error(`Config did not publish release ${release} within ${timeoutMs} milliseconds`)
}

/** Closes the Config-owned Consul watcher within an independent cleanup Context. */
async function closeConfig(runtime: ConfigRuntime): Promise<void> {
  const [ctx, cancel] = withTimeout(background(), 10_000)
  try {
    await runtime.config.close(ctx)
  } finally {
    cancel()
  }
}

/** Adds one cleanup failure once without replacing the primary scenario failure. */
function addFailure(failures: unknown[], failure: unknown): void {
  if (!failures.includes(failure)) failures.push(failure)
}

/** Runs the real Docker lifecycle and prints one machine-readable evidence object. */
async function main(): Promise<void> {
  const baselineTimers = activeTimerCount()
  const events: string[] = []
  let configRuntime: ConfigRuntime | null = null
  let fetchAttempts = 0
  let fetchFailures = 0
  let activeFetches = 0
  let activeBlockingFetches = 0
  let primaryFailure: unknown | null = null
  const cleanupFailures: unknown[] = []
  const retryStatuses: number[] = []
  const indexObservations: string[] = []
  const publications: number[] = []
  /** Records the real standard Fetch outcomes observed by the adapter capability boundary. */
  const webFetch: ConsulFetch = async function fetchRequest(request) {
    fetchAttempts += 1
    activeFetches += 1
    const blocking = new URL(request.url).searchParams.has("index")
    if (blocking) activeBlockingFetches += 1
    try {
      const response = await fetch(request)
      const requestIndex = new URL(request.url).searchParams.get("index") ?? "load"
      const responseIndex = response.headers.get("X-Consul-Index") ?? "missing"
      indexObservations.push(`${requestIndex}->${response.status}:${responseIndex}`)
      if (!response.ok) retryStatuses.push(response.status)
      return response
    } catch (error) {
      fetchFailures += 1
      throw error
    } finally {
      activeFetches -= 1
      if (blocking) activeBlockingFetches -= 1
    }
  }
  const port = availablePort()
  const address = `http://127.0.0.1:${port}`
  const version = await command(["version", "--format", "{{.Server.Version}}"])
  const baseline = await command(["ps", "--all", "--quiet", "--filter", `label=${Label}`])
  if (baseline.stdout !== "") throw new Error("integration label was not clean before startup")
  try {
    await startContainer(port)
    events.push("container-started")
    const portResult = await command(["port", Name, "8500/tcp"])
    if (!portResult.stdout.endsWith(`:${port}`)) {
      throw new Error(`unexpected published Consul port: ${portResult.stdout}`)
    }
    await waitForConsul(address)
    events.push("consul-ready")
    const versionResult = await command(["exec", Name, "consul", "version"])
    if (!versionResult.stdout.includes("Consul v2.0.2")) {
      throw new Error(`unexpected Consul binary version: ${versionResult.stdout}`)
    }
    events.push("binary-version-verified")

    await advanceConsulIndex(address, 64)
    await putConfig(address, '{"release":1,"feature":{"enabled":false}}')
    events.push("kv-initial-written")
    const source = consulSource({
      fetch: webFetch,
      address,
      key: "app/config",
      waitMs: 5_000,
      retryInitialMs: 100,
      retryMaximumMs: 500
    })
    const initialSource = await source.load(background())
    const config = newConfig(configSource(source))
    const release = config.value("release")
    const feature = config.value("feature")
    /** Records automatic kernel publication order through the Kratos-style Value observer. */
    function observePublication(_key: string, current: { load(): ConfigValue | null }): void {
      const release = current.load()
      if (typeof release === "number") publications.push(release)
    }
    await config.load(background())
    configRuntime = Object.freeze({ config })
    await waitForRelease(config, 1, 10_000)
    const initialFeature = feature.load()
    if (
      release.load() !== 1 ||
      !configObject(initialFeature) ||
      typeof initialSource.revision !== "string"
    ) {
      throw new Error("initial composed Config value is incorrect")
    }
    publications.push(1)
    config.watch("release", observePublication)
    events.push("config-initial-published")

    await pause(150)
    await command(["stop", "--timeout", "1", Name])
    events.push("consul-stopped")
    await command(["rm", "--force", Name])
    await pause(1_500)
    if (feature.load() !== initialFeature || release.load() !== 1) {
      throw new Error("Config did not preserve exact last-good value during outage")
    }
    events.push("last-good-preserved")
    await startContainer(port)
    await waitForConsul(address)
    events.push("consul-recovered")
    await putConfig(address, '{"release":2,"feature":{"enabled":true}}')
    events.push("kv-reseeded")
    try {
      await waitForRelease(config, 2, 20_000)
    } catch (error) {
      throw new Error(
        `composed Config did not recover: attempts=${fetchAttempts} failures=${fetchFailures} statuses=${retryStatuses.join(",")} indexes=${indexObservations.join(",")}`,
        { cause: error }
      )
    }
    const reconciledFeature = feature.load()
    if (release.load() !== 2 || reconciledFeature === initialFeature) {
      throw new Error("recovered Config did not publish the replacement Consul value")
    }
    events.push("config-outage-reconciliation-published")

    await pause(150)
    await putConfig(address, '{"release":3,"feature":{"enabled":true}}')
    events.push("kv-updated")
    await waitForRelease(config, 3, 10_000)
    const updatedFeature = feature.load()
    if (release.load() !== 3 || !configObject(updatedFeature) || updatedFeature.enabled !== true) {
      throw new Error("automatically updated Config value is incorrect")
    }
    const updatedSource = await source.load(background())
    if (updatedSource.revision === initialSource.revision) {
      throw new Error("composed Consul revision did not advance")
    }
    if (
      publications.length < 3 ||
      publications[0] !== 1 ||
      !publications.includes(2) ||
      publications.at(-1) !== 3
    ) {
      throw new Error(`unexpected automatic Config publications: ${publications.join(",")}`)
    }
    events.push("config-blocking-change-published")
  } catch (error) {
    primaryFailure = error
  } finally {
    if (configRuntime !== null) {
      try {
        await closeConfig(configRuntime)
        events.push("config-closed")
      } catch (error) {
        addFailure(cleanupFailures, error)
      }
    }
    await command(["rm", "--force", Name], true)
  }
  const remaining = await command(["ps", "--all", "--quiet", "--filter", `label=${Label}`])
  if (remaining.stdout !== "")
    addFailure(cleanupFailures, new Error(`integration container leaked: ${remaining.stdout}`))
  const pendingTimers = Math.max(0, activeTimerCount() - baselineTimers)
  if (pendingTimers !== 0) {
    addFailure(
      cleanupFailures,
      new Error(`Consul watcher leaked ${pendingTimers} timeout resources`)
    )
  }
  if (activeFetches !== 0 || activeBlockingFetches !== 0) {
    addFailure(
      cleanupFailures,
      new Error(
        `Consul watcher leaked Fetch operations: active=${activeFetches} blocking=${activeBlockingFetches}`
      )
    )
  }
  if (primaryFailure !== null) {
    if (cleanupFailures.length === 0) throw primaryFailure
    throw new AggregateError(
      [primaryFailure, ...cleanupFailures],
      "Consul integration and cleanup failed"
    )
  }
  if (cleanupFailures.length === 1) throw cleanupFailures[0]
  if (cleanupFailures.length > 1)
    throw new AggregateError(cleanupFailures, "Consul integration cleanup failed")
  events.push("container-clean")
  if (!events.includes("config-closed")) {
    throw new Error("Consul Config cleanup did not complete")
  }
  const outageFailureCount =
    fetchFailures +
    retryStatuses.filter(function retryable(status) {
      return status >= 500
    }).length
  if (outageFailureCount === 0)
    throw new Error("Consul outage did not produce an observed retryable Fetch failure")
}

await main()
