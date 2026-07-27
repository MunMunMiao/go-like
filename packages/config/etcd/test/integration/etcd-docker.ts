import { etcdSource } from "../../src/index"
import { background, withTimeout } from "@likego/context"

const Image =
  "gcr.io/etcd-development/etcd:v3.7.1@sha256:a9983dd6d9283138ab926daa307c6c25623636703ecf5645d5df4d666ce9eba2"
const EtcdVersion = "3.7.1"
const Name = `likego-config-etcd-${process.pid}-${Date.now()}`
const DockerOwner = process.env.LIKEGO_E2E_OWNER
if (DockerOwner === undefined || !/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(DockerOwner))
  throw new Error("invalid LIKEGO_E2E_OWNER")
const DockerOwnerLabel = `io.likego.e2e.owner=${DockerOwner}`

interface CommandResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/** Runs one direct subprocess without shell interpolation. */
async function command(argv: readonly string[]): Promise<CommandResult> {
  const process = Bun.spawn(Array.from(argv), { stdout: "pipe", stderr: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text()
  ])
  return Object.freeze({ exitCode, stdout, stderr })
}

/** Runs one required command and returns trimmed standard output. */
async function required(argv: readonly string[]): Promise<string> {
  const result = await command(argv)
  if (result.exitCode !== 0) {
    throw new Error(`command failed (${argv[0]}): ${result.stderr.trim()}`)
  }
  return result.stdout.trim()
}

/** Waits one short integration-test interval. */
function delay(timeoutMs: number): Promise<void> {
  return new Promise<void>(function wait(resolve) {
    setTimeout(resolve, timeoutMs)
  })
}

/** Posts one etcd v3 JSON gateway request and parses its JSON response. */
async function post(address: string, path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${address}${path}`, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST"
  })
  if (!response.ok) throw new Error(`etcd integration request failed with HTTP ${response.status}`)
  return response.json()
}

/** Reads one own data property from a gateway response. */
function property(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined
  return Object.getOwnPropertyDescriptor(value, key)?.value
}

/** Extracts one required decimal header revision. */
function headerRevision(value: unknown): string {
  const revision = property(property(value, "header"), "revision")
  if (typeof revision !== "string" || !/^[1-9][0-9]*$/.test(revision)) {
    throw new Error("etcd integration response is missing a revision")
  }
  return revision
}

/** Waits until the fixed-digest container exposes a healthy JSON gateway. */
async function waitHealthy(address: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${address}/health`)
      if (response.ok && (await response.text()).includes('"health":"true"')) return
    } catch {
      // The listener is expected to refuse connections during its short startup window.
    }
    await delay(100)
  }
  throw new Error("etcd integration container did not become healthy")
}

/** Parses the exact etcd binary version reported inside the running container. */
function etcdVersion(output: string): string {
  const line = output.split("\n").find((value) => value.startsWith("etcd Version: "))
  const version = line?.slice("etcd Version: ".length).trim()
  if (version === undefined || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("etcd integration container did not report a semantic version")
  }
  return version
}

let started = false
let evidence: Readonly<Record<string, unknown>> | null = null
let primary: { readonly value: unknown } | null = null
try {
  await required([
    "docker",
    "run",
    "-d",
    "--name",
    Name,
    "--label",
    DockerOwnerLabel,
    "-p",
    "127.0.0.1::2379",
    Image,
    "/usr/local/bin/etcd",
    "--name",
    "config-etcd",
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
    "config-etcd=http://0.0.0.0:2380"
  ])
  started = true
  const binding = await required(["docker", "port", Name, "2379/tcp"])
  const port = binding.slice(binding.lastIndexOf(":") + 1)
  if (!/^[0-9]+$/.test(port)) throw new Error("Docker returned an invalid etcd host port")
  const address = `http://127.0.0.1:${port}`
  await waitHealthy(address)
  const observedVersion = etcdVersion(
    await required(["docker", "exec", Name, "/usr/local/bin/etcd", "--version"])
  )
  if (observedVersion !== EtcdVersion) {
    throw new Error(`expected etcd ${EtcdVersion}, received ${observedVersion}`)
  }

  const key = "integration/config"
  const encodedKey = btoa(key)
  await post(address, "/v3/kv/put", {
    key: encodedKey,
    value: btoa(JSON.stringify({ version: 1 }))
  })
  const source = etcdSource({
    fetch(request) {
      return fetch(request)
    },
    address,
    key,
    retryInitialMs: 10,
    retryMaximumMs: 50
  })
  const initial = await source.load(background())
  if (initial.value.version !== 1) throw new Error("initial etcd configuration did not load")
  const watcher = await source.watch?.(background(), initial.revision)
  if (watcher === undefined) throw new Error("etcd source watcher is missing")

  const [updateCtx, cancelUpdate] = withTimeout(background(), 3_000)
  const updated = watcher.next(updateCtx)
  await delay(100)
  await post(address, "/v3/kv/put", {
    key: encodedKey,
    value: btoa(JSON.stringify({ version: 2 }))
  })
  await updated.finally(cancelUpdate)
  const updateSnapshot = await source.load(background())
  if (updateSnapshot.value.version !== 2) throw new Error("etcd update was not observed")

  const [deleteCtx, cancelDelete] = withTimeout(background(), 3_000)
  const deleted = watcher.next(deleteCtx)
  await delay(100)
  await post(address, "/v3/kv/deleterange", { key: encodedKey })
  await deleted.finally(cancelDelete)
  const missing = await source.load(background())
  if (Object.keys(missing.value).length !== 0) throw new Error("etcd delete was not observed")

  const compactedAt = headerRevision(
    await post(address, "/v3/kv/compaction", { revision: missing.revision, physical: true })
  )
  const compacted = await source.watch?.(background(), "1")
  if (compacted === undefined) throw new Error("compaction watcher is missing")
  const [compactCtx, cancelCompact] = withTimeout(background(), 3_000)
  await compacted.next(compactCtx).finally(cancelCompact)
  await compacted.stop(background())
  await watcher.stop(background())

  const finalRange = property(await post(address, "/v3/kv/range", { key: encodedKey }), "kvs")
  if (finalRange !== undefined) throw new Error("etcd integration key remained after delete")
  evidence = Object.freeze({
    valid: true,
    image: Image,
    etcdVersion: observedVersion,
    initial: initial.revision,
    update: updateSnapshot.revision,
    deleted: missing.revision,
    compactedAt,
    resourcesClean: true,
    scenarios: ["config-etcd-load-watch-delete-compaction"],
    scenarioEvidence: {
      "config-etcd-load-watch-delete-compaction": {
        initialLoaded: true,
        updateObserved: true,
        deleteObserved: true,
        compactionRelisted: true
      }
    },
    cleanup: { remoteKeys: 0, watchersStopped: true, containerRemoved: true }
  })
} catch (value) {
  primary = Object.freeze({ value })
}

const cleanupFailures: unknown[] = []
if (started) {
  const removal = await command(["docker", "rm", "-f", Name])
  if (removal.exitCode !== 0) {
    cleanupFailures.push(new Error(`etcd integration cleanup failed: ${removal.stderr.trim()}`))
  }
}
const residual = await command([
  "docker",
  "ps",
  "--all",
  "--filter",
  `name=^/${Name}$`,
  "--format",
  "{{.Names}}"
])
if (residual.exitCode !== 0) {
  cleanupFailures.push(
    new Error(`etcd integration cleanup query failed: ${residual.stderr.trim()}`)
  )
} else if (residual.stdout.trim() !== "") {
  cleanupFailures.push(new Error("etcd integration container cleanup failed"))
}
if (primary !== null || cleanupFailures.length > 0) {
  const failures = primary === null ? cleanupFailures : [primary.value, ...cleanupFailures]
  if (failures.length === 1) throw failures[0]
  throw new AggregateError(failures, "etcd configuration integration and cleanup failed")
}
if (evidence === null) throw new Error("etcd integration completed without scenario evidence")
console.log(`LIKEGO_CONFIG_ETCD_DOCKER=${JSON.stringify(evidence)}`)
