import { background } from "@likego/context"
import type { Config, ConfigObject } from "@likego/config"
import type { ServiceInstance } from "@likego/registry"
import { newEtcdRegistry, type EtcdRegistry } from "@likego/registry-etcd"

import { newEtcdAlertTriageLedger, newEtcdTriageConfig, newTriageReadiness } from "../src/config"
import { newTriageAlert } from "../src/service"

const Image =
  "gcr.io/etcd-development/etcd:v3.7.1@sha256:a9983dd6d9283138ab926daa307c6c25623636703ecf5645d5df4d666ce9eba2"
const RunId = crypto.randomUUID()
const Name = `likego-example-security-etcd-${RunId}`
const OwnerLabel = `io.likego.e2e.owner=cybersecurity-alert-triage-${RunId}`
const ConfigKey = `likego/examples/security/${RunId}/config`

interface CommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

/** Runs one argv-only Docker operation and returns its complete output. */
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
  if (!allowFailure && exitCode !== 0) {
    throw new Error(`docker ${args.join(" ")} failed (${exitCode}): ${result.stderr}`)
  }
  return result
}

/** Waits until the fixed-digest etcd process exposes its real health endpoint. */
async function waitHealthy(address: string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${address}/health`)
      if (response.ok && (await response.text()).includes('"health":"true"')) return
    } catch {
      // Docker publishes the host port before etcd necessarily accepts connections.
    }
    await Bun.sleep(100)
  }
  throw new Error("real etcd did not become healthy within 30 seconds")
}

/** Writes one complete JSON rule document through the etcd v3 JSON gateway. */
async function putConfig(address: string): Promise<void> {
  const response = await fetch(`${address}/v3/kv/put`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      key: btoa(ConfigKey),
      value: btoa(
        JSON.stringify({
          triage: {
            highFailedAttempts: 5,
            criticalFailedAttempts: 10,
            highMalwareConfidence: 60,
            criticalMalwareConfidence: 90
          }
        })
      )
    })
  })
  await response.arrayBuffer()
  if (!response.ok) throw new Error(`etcd config write returned ${response.status}`)
}

/** Runs Config, Registry and Store against one actual etcd process. */
async function main(): Promise<void> {
  let config: Config<ConfigObject> | null = null
  let registry: EtcdRegistry | null = null
  let registered: ServiceInstance | null = null
  const cleanupFailures: unknown[] = []
  let primary: unknown | null = null
  try {
    await docker([
      "run",
      "--detach",
      "--name",
      Name,
      "--label",
      OwnerLabel,
      "--publish",
      "127.0.0.1::2379",
      Image,
      "/usr/local/bin/etcd",
      "--name",
      "security-example",
      "--data-dir",
      "/etcd-data",
      "--listen-client-urls",
      "http://0.0.0.0:2379",
      "--advertise-client-urls",
      "http://0.0.0.0:2379",
      "--listen-peer-urls",
      "http://0.0.0.0:2380",
      "--initial-advertise-peer-urls",
      "http://0.0.0.0:2380",
      "--initial-cluster",
      "security-example=http://0.0.0.0:2380"
    ])
    const binding = await docker(["port", Name, "2379/tcp"])
    const match = /:([0-9]+)$/u.exec(binding.stdout.split("\n")[0] ?? "")
    if (match?.[1] === undefined) throw new Error("Docker returned an invalid etcd port")
    const address = `http://127.0.0.1:${match[1]}`
    await waitHealthy(address)
    const reference = await docker(["inspect", "--format", "{{.Config.Image}}", Name])
    if (reference.stdout !== Image) throw new Error("etcd image reference drifted from its digest")
    await putConfig(address)

    const options = Object.freeze({ address, configKey: ConfigKey })
    config = newEtcdTriageConfig(options)
    await config.load(background())
    const decision = await newTriageAlert(
      config,
      newTriageReadiness(config),
      newEtcdAlertTriageLedger(options)
    )(background(), {
      alertId: `alert-${RunId}`,
      source: "identity",
      failedAttempts: 10,
      malwareConfidence: 0,
      privileged: false
    })
    if (decision.severity !== "critical")
      throw new Error("etcd-backed triage returned wrong result")

    registry = newEtcdRegistry({
      fetch,
      address,
      prefix: `/likego/examples/security/${RunId}/registry/`,
      ttlMs: 2_000
    })
    registered = Object.freeze({
      id: `security-${RunId}`,
      name: "cybersecurity-alert-triage",
      version: "v1",
      metadata: Object.freeze({ environment: "e2e" }),
      endpoints: Object.freeze(["http://127.0.0.1:3000/"])
    })
    await registry.register(background(), registered)
    const instances = await registry.getService(background(), registered.name)
    if (instances.length !== 1 || instances[0]?.id !== registered.id) {
      throw new Error("etcd Registry fresh readback failed")
    }
    await registry.deregister(background(), registered)
    registered = null
    if ((await registry.getService(background(), "cybersecurity-alert-triage")).length !== 0) {
      throw new Error("etcd Registry deregistration readback failed")
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
        ETCD_ADDRESS: address,
        ETCD_CONFIG_KEY: ConfigKey
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
      while (
        Date.now() < deadline &&
        !programOutput.includes('LIKEGO_EXAMPLE_READY={"example":"cybersecurity-alert-triage"')
      ) {
        await Bun.sleep(25)
      }
      if (!programOutput.includes('LIKEGO_EXAMPLE_READY={"example":"cybersecurity-alert-triage"')) {
        throw new Error("start:prepared did not report readiness")
      }
      const ready = await fetch(`http://127.0.0.1:${programPort}/readyz`)
      await ready.arrayBuffer()
      if (ready.status !== 200) throw new Error(`start:prepared readiness returned ${ready.status}`)
      const response = await fetch(`http://127.0.0.1:${programPort}/v1/security/alerts/triage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          alertId: `entry-${RunId}`,
          source: "identity",
          failedAttempts: 10,
          malwareConfidence: 0,
          privileged: false
        })
      })
      const payload: unknown = await response.json()
      if (
        response.status !== 201 ||
        payload === null ||
        typeof payload !== "object" ||
        !("severity" in payload) ||
        payload.severity !== "critical"
      ) {
        throw new Error(`start:prepared triage probe failed: ${JSON.stringify(payload)}`)
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
    if (registry !== null && registered !== null) {
      try {
        await registry.deregister(background(), registered)
      } catch (error) {
        cleanupFailures.push(error)
      }
    }
    if (config !== null) {
      try {
        await config.close(background())
      } catch (error) {
        cleanupFailures.push(error)
      }
    }
    const removed = await docker(["rm", "--force", "--volumes", Name], true)
    if (removed.exitCode !== 0 && !removed.stderr.includes("No such container")) {
      cleanupFailures.push(new Error("etcd container cleanup failed"))
    }
  }
  const remaining = await docker(["ps", "--all", "--quiet", "--filter", `label=${OwnerLabel}`])
  if (remaining.stdout !== "") cleanupFailures.push(new Error("owner-labeled container remains"))
  if (primary !== null || cleanupFailures.length > 0) {
    const failures = primary === null ? cleanupFailures : [primary, ...cleanupFailures]
    throw new AggregateError(failures, "cybersecurity etcd example failed")
  }
  process.stdout.write(
    `LIKEGO_EXAMPLE_SECURITY_ETCD_E2E_RESULT=${JSON.stringify({
      valid: true,
      image: Image,
      config: true,
      registry: true,
      store: true,
      startPreparedEntrypoint: true
    })}\n`
  )
}

await main()
