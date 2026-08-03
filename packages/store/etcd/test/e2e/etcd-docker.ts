import { background } from "@likego/context"
import { cursor, expiresIn, ifAbsent, ifRevision, limit, prefix } from "@likego/store"

import { encodeText, prefixRangeEnd } from "../../src/codec"
import { newEtcdStore, type EtcdStore } from "../../src/index"

const Image =
  "gcr.io/etcd-development/etcd:v3.7.1@sha256:a9983dd6d9283138ab926daa307c6c25623636703ecf5645d5df4d666ce9eba2"
const name = `likego-store-etcd-${crypto.randomUUID()}`
const DockerOwner = process.env.LIKEGO_E2E_OWNER
if (DockerOwner === undefined || !/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(DockerOwner))
  throw new Error("invalid LIKEGO_E2E_OWNER")
const DockerOwnerLabel = `io.likego.e2e.owner=${DockerOwner}`

interface CommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

/** Runs one Docker CLI command and captures its complete result. */
async function command(...args: readonly string[]): Promise<CommandResult> {
  const process = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" })
  const stdout = new Response(process.stdout).text()
  const stderr = new Response(process.stderr).text()
  const exitCode = await process.exited
  return Object.freeze({ stdout: await stdout, stderr: await stderr, exitCode })
}

/** Runs one required Docker CLI command or fails with its bounded diagnostic. */
async function required(...args: readonly string[]): Promise<string> {
  const result = await command(...args)
  if (result.exitCode !== 0) {
    throw new Error(`docker ${args[0] ?? "command"} failed: ${result.stderr.trim()}`)
  }
  return result.stdout.trim()
}

/** Resolves the container's current ephemeral IPv4 client binding. */
async function publishedAddress(): Promise<string> {
  const binding = await required("port", name, "2379/tcp")
  const port = binding.slice(binding.lastIndexOf(":") + 1)
  ensure(/^[0-9]+$/.test(port), "Docker did not publish an etcd port")
  return `http://127.0.0.1:${port}`
}

/** Fails one integration assertion with a stable prefix. */
function ensure(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`etcd Docker integration failed: ${message}`)
}

/** Waits one short retry turn. */
function turn(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 100))
}

/** Waits until the real etcd HTTP endpoint becomes ready. */
async function waitReady(address: string, stage: "initial" | "restart"): Promise<void> {
  const deadline = performance.now() + 30_000
  let last = "no response"
  while (performance.now() < deadline) {
    try {
      const response = await fetch(`${address}/health`)
      if (response.ok) return
      last = `HTTP ${response.status}`
    } catch (value) {
      last = value instanceof Error ? value.message : "non-Error rejection"
      await turn()
      continue
    }
    await turn()
  }
  throw new Error(`real etcd did not become ready after ${stage}: ${last}`)
}

/** Parses the exact etcd binary version reported inside the running container. */
function observedEtcdVersion(output: string): string {
  const line = output.split("\n").find((value) => value.startsWith("etcd Version: "))
  const version = line?.slice("etcd Version: ".length).trim()
  ensure(
    version !== undefined && /^\d+\.\d+\.\d+$/.test(version),
    "container did not report an etcd semantic version"
  )
  return version
}

/** Executes one raw etcd JSON gateway request. */
async function gateway(
  address: string,
  path: string,
  body: Readonly<Record<string, unknown>>
): Promise<Record<string, unknown>> {
  const response = await fetch(`${address}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  })
  const value: unknown = await response.json()
  if (!response.ok || typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`real etcd gateway request ${path} failed with HTTP ${response.status}`)
  }
  return Object.fromEntries(Object.entries(value))
}

/** Reads one own raw gateway property. */
function property(value: Record<string, unknown>, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value
}

/** Reads one exact raw KV lease or null when its key is absent. */
async function rawLease(address: string, key: string): Promise<string | null> {
  const response = await gateway(address, "/v3/kv/range", { key: encodeText(key) })
  const kvs = property(response, "kvs")
  if (kvs === undefined) return null
  if (!Array.isArray(kvs) || kvs.length !== 1) throw new Error("real etcd returned invalid kvs")
  const row = kvs[0]
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    throw new Error("real etcd returned an invalid KV")
  }
  const lease = Object.getOwnPropertyDescriptor(row, "lease")?.value
  if (typeof lease !== "string") throw new Error("real etcd KV omitted lease")
  return lease
}

/** Reports whether one exact raw etcd lease remains allocated. */
async function hasLease(address: string, lease: string): Promise<boolean> {
  const response = await gateway(address, "/v3/lease/leases", {})
  const leases = property(response, "leases")
  if (leases === undefined) return false
  if (!Array.isArray(leases)) throw new Error("real etcd returned invalid leases")
  for (const candidate of leases) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw new Error("real etcd returned an invalid lease row")
    }
    if (Object.getOwnPropertyDescriptor(candidate, "ID")?.value === lease) return true
  }
  return false
}

/** Waits until one raw lease and its attached key are gone. */
async function waitLeaseExpiry(address: string, key: string, lease: string): Promise<void> {
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    if ((await rawLease(address, key)) === null && !(await hasLease(address, lease))) return
    await turn()
  }
  throw new Error("real etcd lease did not expire")
}

/** Reads every key under one raw prefix. */
async function rawPrefixCount(address: string, selectedPrefix: string): Promise<number> {
  const response = await gateway(address, "/v3/kv/range", {
    key: encodeText(selectedPrefix),
    range_end: prefixRangeEnd(selectedPrefix)
  })
  const count = property(response, "count")
  return count === undefined ? 0 : Number(count)
}

let primary: Error | null = null
let address = ""
let removed = false
let etcdVersion = "unobserved"
try {
  await required("pull", Image)
  await required(
    "run",
    "-d",
    "--name",
    name,
    "--label",
    DockerOwnerLabel,
    "-p",
    "127.0.0.1::2379",
    Image,
    "/usr/local/bin/etcd",
    "--name",
    "store-etcd",
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
    "store-etcd=http://0.0.0.0:2380"
  )
  address = await publishedAddress()
  await waitReady(address, "initial")
  etcdVersion = observedEtcdVersion(
    await required("exec", name, "/usr/local/bin/etcd", "--version")
  )

  const namespace = `integration/${crypto.randomUUID()}/`
  const persistentKey = `${namespace}persistent`
  const store = newEtcdStore({ fetch, address })
  const absentKey = `${namespace}if-absent`
  const peer = newEtcdStore({ fetch, address })
  const absentAttempts = await Promise.allSettled([
    store.write(background(), { key: absentKey, value: new Uint8Array([1]) }, ifAbsent()),
    peer.write(background(), { key: absentKey, value: new Uint8Array([2]) }, ifAbsent())
  ])
  const absentSuccesses = absentAttempts.filter((result) => result.status === "fulfilled")
  const absentFailures = absentAttempts.filter((result) => result.status === "rejected")
  const absentFailure = absentFailures[0]
  ensure(absentSuccesses.length === 1, "concurrent ifAbsent admitted multiple writers")
  ensure(
    absentFailures.length === 1 &&
      absentFailure?.status === "rejected" &&
      typeof absentFailure.reason === "object" &&
      absentFailure.reason !== null &&
      "code" in absentFailure.reason &&
      absentFailure.reason.code === "LIKEGO_STORE_CONFLICT" &&
      "expectedRevision" in absentFailure.reason &&
      absentFailure.reason.expectedRevision === null,
    "concurrent ifAbsent did not return an absence conflict"
  )
  await store.delete(background(), absentKey)
  const initial = await store.write(background(), {
    key: persistentKey,
    value: new TextEncoder().encode("first"),
    metadata: { owner: "docker" }
  })
  ensure(
    (await store.read(background(), persistentKey))?.metadata.owner === "docker",
    "CRUD read failed"
  )
  const updated = await store.write(
    background(),
    { key: persistentKey, value: new TextEncoder().encode("second") },
    ifRevision(initial.revision)
  )
  let conflict: unknown = null
  try {
    await store.delete(background(), persistentKey, ifRevision(initial.revision))
  } catch (value) {
    conflict = value
  }
  ensure(
    typeof conflict === "object" &&
      conflict !== null &&
      "code" in conflict &&
      conflict.code === "LIKEGO_STORE_CONFLICT",
    "stale CAS was not rejected"
  )

  const prefixKeys = [`${namespace}a`, `${namespace}b`, `${namespace}c`]
  for (const key of prefixKeys) {
    await store.write(background(), { key, value: new Uint8Array([1]) })
  }
  const firstPage = await store.list(background(), prefix(namespace), limit(2))
  ensure(firstPage.records.length === 2 && firstPage.cursor !== null, "first prefix page failed")
  const secondPage = await store.list(
    background(),
    prefix(namespace),
    limit(2),
    cursor(firstPage.cursor)
  )
  ensure(secondPage.records.length === 2 && secondPage.cursor === null, "second prefix page failed")

  const expiringKey = `${namespace}expiring`
  await store.write(
    background(),
    { key: expiringKey, value: new Uint8Array([2]) },
    expiresIn(1_000)
  )
  const expiringLease = await rawLease(address, expiringKey)
  ensure(expiringLease !== null && expiringLease !== "0", "TTL write did not attach a lease")
  await waitLeaseExpiry(address, expiringKey, expiringLease)
  ensure((await store.read(background(), expiringKey)) === null, "expired key remained visible")

  const revokedKey = `${namespace}revoked`
  await store.write(
    background(),
    { key: revokedKey, value: new Uint8Array([3]) },
    expiresIn(10_000)
  )
  const revokedLease = await rawLease(address, revokedKey)
  ensure(revokedLease !== null && revokedLease !== "0", "delete fixture omitted its lease")
  ensure(await store.delete(background(), revokedKey), "TTL delete returned false")
  ensure(!(await hasLease(address, revokedLease)), "delete did not proactively revoke its lease")

  const reopened = newEtcdStore({ fetch, address })
  ensure(
    (await reopened.read(background(), persistentKey))?.revision === updated.revision,
    "new client lost persistent data"
  )

  await required("restart", name)
  address = await publishedAddress()
  await waitReady(address, "restart")
  const restarted = newEtcdStore({ fetch, address })
  ensure(
    (await restarted.read(background(), persistentKey))?.revision === updated.revision,
    "restart lost persistent data"
  )
  for (const key of [persistentKey, ...prefixKeys]) await restarted.delete(background(), key)

  ensure((await rawPrefixCount(address, namespace)) === 0, "test namespace retained keys")
  const remainingLeases = await gateway(address, "/v3/lease/leases", {})
  const leaseRows = property(remainingLeases, "leases")
  ensure(
    leaseRows === undefined || (Array.isArray(leaseRows) && leaseRows.length === 0),
    "test retained leases"
  )
} catch (value) {
  primary = value instanceof Error ? value : new Error("etcd Docker integration failed")
} finally {
  const removal = await command("rm", "-f", name)
  removed = removal.exitCode === 0
  if (!removed && primary === null) {
    primary = new Error(`Docker cleanup failed: ${removal.stderr.trim()}`)
  }
}

if (removed) {
  const inspection = await command("inspect", name)
  if (inspection.exitCode === 0 && primary === null) {
    primary = new Error("Docker container remained after cleanup")
  }
}
if (primary !== null) throw primary
