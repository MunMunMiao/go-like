import { background } from "@likego/context"
import { cursor, expiresIn, ifAbsent, ifRevision, limit, prefix } from "@likego/store"

import { newConsulStore, type ConsulFetch, type ConsulStore } from "../../src/index"

const Image =
  "hashicorp/consul:2.0.2@sha256:7dcf35d6b2682831094f1680aa58be214134969505acce0a9b280249581aa7d2"
const RunId = crypto.randomUUID()
const LabelKey = "likego.store-consul.integration"
const Label = `${LabelKey}=${RunId}`
const PrimaryName = `likego-store-consul-${RunId}`
const AclName = `likego-store-consul-acl-${RunId}`
const AclToken = `likego-store-consul-test-token-${RunId}`
const ProviderRoot = `likego-store/${RunId}`
const SecondaryRoot = `likego-store-secondary/${RunId}`
const ExternalKey = `outside-likego-store/${RunId}`
const KeyRoot = "records/"
const DockerOwner = process.env.LIKEGO_E2E_OWNER
if (DockerOwner === undefined || !/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(DockerOwner))
  throw new Error("invalid LIKEGO_E2E_OWNER")
const DockerOwnerLabel = `io.likego.e2e.owner=${DockerOwner}`
const PrimaryVolume = `likego-store-consul-data-${RunId}`

interface CommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

interface ConsulKvRow {
  readonly Key: string
  readonly ModifyIndex: number
  readonly Session?: string | null
}

interface ConsulSessionRow {
  readonly ID: string
  readonly Name: string
}

interface RequestEvidence {
  readonly url: string
  readonly redirect: RequestRedirect
  readonly token: string | null
}

/** Runs one argv-safe Docker command and captures all output. */
async function docker(args: readonly string[], allowFailure = false): Promise<CommandResult> {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" })
  const stdoutPromise = new Response(child.stdout).text()
  const stderrPromise = new Response(child.stderr).text()
  const exitCode = await child.exited
  const stdout = (await stdoutPromise).trim()
  const stderr = (await stderrPromise).trim()
  if (exitCode !== 0 && !allowFailure) {
    const safeArgs = args.map(function redact(value) {
      return value.replaceAll(AclToken, "<redacted>")
    })
    throw new Error(
      `docker ${safeArgs.join(" ")} failed (${exitCode}): ${stderr.replaceAll(AclToken, "<redacted>")}`
    )
  }
  return Object.freeze({ stdout, stderr, exitCode })
}

/** Waits one bounded real-time polling interval. */
function pause(timeoutMs: number): Promise<void> {
  return new Promise<void>(function wait(resolve): void {
    setTimeout(resolve, timeoutMs)
  })
}

/** Returns the current random host mapping for one Consul HTTP port. */
async function mappedAddress(name: string): Promise<string> {
  const result = await docker(["port", name, "8500/tcp"])
  const first = result.stdout.split("\n")[0]
  const match = first === undefined ? null : /:([0-9]+)$/u.exec(first)
  if (match?.[1] === undefined) throw new Error(`invalid Consul port mapping: ${result.stdout}`)
  return `http://127.0.0.1:${match[1]}`
}

/** Creates one header-only raw Consul Request and returns its Response. */
function consulRequest(
  address: string,
  path: string,
  method = "GET",
  body: string | null = null,
  token?: string
): Promise<Response> {
  const headers = new Headers()
  if (token !== undefined) headers.set("X-Consul-Token", token)
  return fetch(
    new Request(new URL(path, address), {
      method,
      headers,
      body,
      redirect: "error"
    })
  )
}

/** Waits for leader election and one strong-consistency KV response. */
async function ready(address: string, token?: string): Promise<void> {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    try {
      const leader = await consulRequest(address, "/v1/status/leader", "GET", null, token)
      const elected = leader.ok && (await leader.text()).length > 2
      if (elected) {
        const probe = await consulRequest(
          address,
          "/v1/kv/__likego_store_docker_readiness__?consistent",
          "GET",
          null,
          token
        )
        await probe.arrayBuffer()
        if (probe.ok || probe.status === 404) return
      }
    } catch {
      // Connection refusal is expected while Consul starts or elects its single-node leader.
    }
    await pause(100)
  }
  throw new Error("Consul did not become ready within 45 seconds")
}

/** Starts the persistent single-server Consul used by restart evidence. */
async function startPrimary(): Promise<string> {
  await docker(["volume", "create", "--label", Label, "--label", DockerOwnerLabel, PrimaryVolume])
  await docker([
    "run",
    "--detach",
    "--name",
    PrimaryName,
    "--label",
    Label,
    "--label",
    DockerOwnerLabel,
    "--volume",
    `${PrimaryVolume}:/consul/data`,
    "--publish",
    "127.0.0.1::8500",
    Image,
    "agent",
    "-server",
    "-bootstrap-expect=1",
    "-client=0.0.0.0",
    `-node=${PrimaryName}`,
    "-log-level=warn"
  ])
  const address = await mappedAddress(PrimaryName)
  await ready(address)
  return address
}

/** Starts an isolated default-deny ACL Consul dev agent. */
async function startAcl(): Promise<string> {
  const hcl = `acl { enabled = true default_policy = "deny" enable_token_persistence = true tokens { initial_management = "${AclToken}" agent = "${AclToken}" } }`
  await docker([
    "run",
    "--detach",
    "--name",
    AclName,
    "--label",
    Label,
    "--label",
    DockerOwnerLabel,
    "--tmpfs",
    "/consul/data:rw,noexec,nosuid,size=64m",
    "--publish",
    "127.0.0.1::8500",
    Image,
    "agent",
    "-dev",
    "-client=0.0.0.0",
    "-log-level=warn",
    "-hcl",
    hcl
  ])
  const address = await mappedAddress(AclName)
  await ready(address, AclToken)
  return address
}

/** Creates one provider Store over the real standard Fetch implementation. */
function store(
  address: string,
  token?: string,
  evidence?: RequestEvidence[],
  root = ProviderRoot
): ConsulStore {
  const injected: ConsulFetch = async function fetchConsul(request): Promise<Response> {
    evidence?.push(
      Object.freeze({
        url: request.url,
        redirect: request.redirect,
        token: request.headers.get("X-Consul-Token")
      })
    )
    return fetch(request)
  }
  return token === undefined
    ? newConsulStore({ fetch: injected, address, root })
    : newConsulStore({ fetch: injected, address, root, token })
}

/** Maps one logical integration key into one provider-owned physical root. */
function physicalKey(root: string, key: string): string {
  return `${root}/${key}`
}

/** Reads exact raw KV rows or returns an empty array for Consul 404. */
async function rawRows(
  address: string,
  key: string,
  recurse = false,
  token?: string
): Promise<readonly ConsulKvRow[]> {
  const query = recurse ? "?recurse=true&consistent" : "?consistent"
  const response = await consulRequest(
    address,
    `/v1/kv/${key.split("/").map(encodeURIComponent).join("/")}${query}`,
    "GET",
    null,
    token
  )
  if (response.status === 404) {
    await response.arrayBuffer()
    return Object.freeze([])
  }
  if (!response.ok) throw new Error(`raw Consul KV read returned ${response.status}`)
  const value: unknown = await response.json()
  if (!Array.isArray(value)) throw new Error("raw Consul KV response was not an array")
  const rows: ConsulKvRow[] = []
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("raw Consul KV row was malformed")
    }
    const keyValue = Object.getOwnPropertyDescriptor(item, "Key")?.value
    const index = Object.getOwnPropertyDescriptor(item, "ModifyIndex")?.value
    const session = Object.getOwnPropertyDescriptor(item, "Session")?.value
    if (
      typeof keyValue !== "string" ||
      !Number.isSafeInteger(index) ||
      typeof index !== "number" ||
      (session !== undefined && session !== null && typeof session !== "string")
    ) {
      throw new Error("raw Consul KV row fields were malformed")
    }
    rows.push(Object.freeze({ Key: keyValue, ModifyIndex: index, Session: session ?? null }))
  }
  return Object.freeze(rows)
}

/** Writes one exact raw Consul KV value and verifies its boolean response. */
async function writeRawKey(
  address: string,
  key: string,
  value: string,
  token?: string
): Promise<void> {
  const encoded = key.split("/").map(encodeURIComponent).join("/")
  const response = await consulRequest(address, `/v1/kv/${encoded}`, "PUT", value, token)
  if (!response.ok || (await response.text()).trim() !== "true") {
    throw new Error("raw Consul KV write failed")
  }
}

/** Deletes one exact or recursive raw Consul KV prefix. */
async function deleteRawKey(
  address: string,
  key: string,
  recurse: boolean,
  token?: string
): Promise<void> {
  const encoded = key.split("/").map(encodeURIComponent).join("/")
  const query = recurse ? "?recurse=true" : ""
  const response = await consulRequest(address, `/v1/kv/${encoded}${query}`, "DELETE", null, token)
  if (!response.ok || (await response.text()).trim() !== "true") {
    throw new Error("raw Consul KV delete failed")
  }
}

/** Reads all Consul sessions as exact ID/name pairs. */
async function sessions(address: string, token?: string): Promise<readonly ConsulSessionRow[]> {
  const response = await consulRequest(address, "/v1/session/list", "GET", null, token)
  if (!response.ok) throw new Error(`Consul session list returned ${response.status}`)
  const value: unknown = await response.json()
  if (!Array.isArray(value)) throw new Error("Consul session list was not an array")
  const rows: ConsulSessionRow[] = []
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("Consul session row was malformed")
    }
    const id = Object.getOwnPropertyDescriptor(item, "ID")?.value
    const name = Object.getOwnPropertyDescriptor(item, "Name")?.value
    if (typeof id !== "string" || typeof name !== "string") {
      throw new Error("Consul session row fields were malformed")
    }
    rows.push(Object.freeze({ ID: id, Name: name }))
  }
  return Object.freeze(rows)
}

/** Returns only sessions created by this provider's stable name prefix. */
async function providerSessions(
  address: string,
  token?: string
): Promise<readonly ConsulSessionRow[]> {
  return Object.freeze(
    (await sessions(address, token)).filter(function managed(row) {
      return row.Name.startsWith("likego-store:")
    })
  )
}

/** Destroys one exact raw Consul session and verifies its boolean response. */
async function destroyRawSession(address: string, id: string, token?: string): Promise<void> {
  const response = await consulRequest(
    address,
    `/v1/session/destroy/${encodeURIComponent(id)}`,
    "PUT",
    null,
    token
  )
  if (!response.ok || (await response.text()).trim() !== "true") {
    throw new Error("raw Consul session destroy failed")
  }
}

/** Removes every exact integration root and provider session in one isolated container. */
async function cleanRemote(address: string, token?: string): Promise<void> {
  for (const session of await providerSessions(address, token)) {
    await destroyRawSession(address, session.ID, token)
  }
  await deleteRawKey(address, `${ProviderRoot}/`, true, token)
  await deleteRawKey(address, `${SecondaryRoot}/`, true, token)
  await deleteRawKey(address, ExternalKey, false, token)
}

/** Waits until both one TTL key and its exact behavior-delete Session disappear. */
async function waitForTtlRemoval(address: string, key: string, session: string): Promise<number> {
  const started = Date.now()
  const deadline = started + 30_000
  while (Date.now() < deadline) {
    const keyGone = (await rawRows(address, key)).length === 0
    const sessionGone = !(await sessions(address)).some(function exact(row) {
      return row.ID === session
    })
    if (keyGone && sessionGone) return Date.now() - started
    await pause(250)
  }
  throw new Error("Consul behavior-delete TTL did not remove KV and Session within 30 seconds")
}

/** Verifies real root isolation, CRUD, pagination, CAS, TTL, conflicting flags, and restart. */
async function primaryScenarios(address: string): Promise<Readonly<Record<string, unknown>>> {
  const provider = store(address)
  await writeRawKey(address, ExternalKey, "outside-provider-root")
  const externalKvIgnored = (await provider.list(background())).records.length === 0
  if (!externalKvIgnored) throw new Error("external Consul KV leaked into the provider root")

  const isolatedKey = `${KeyRoot}isolated`
  const secondary = store(address, undefined, undefined, SecondaryRoot)
  await provider.write(background(), { key: isolatedKey, value: new TextEncoder().encode("one") })
  await provider.write(background(), {
    key: `${KeyRoot}isolated-next`,
    value: new TextEncoder().encode("next")
  })
  await secondary.write(background(), {
    key: isolatedKey,
    value: new TextEncoder().encode("two")
  })
  const primaryIsolated = new TextDecoder().decode(
    (await provider.read(background(), isolatedKey))?.value
  )
  const secondaryIsolated = new TextDecoder().decode(
    (await secondary.read(background(), isolatedKey))?.value
  )
  const differentRootsIsolated = primaryIsolated === "one" && secondaryIsolated === "two"
  if (!differentRootsIsolated) throw new Error("different Consul Store roots were not isolated")
  const isolatedPage = await provider.list(background(), prefix(KeyRoot), limit(1))
  if (isolatedPage.cursor === null) throw new Error("root-bound pagination cursor missing")
  let crossRootCursorRejected = false
  try {
    await secondary.list(background(), prefix(KeyRoot), cursor(isolatedPage.cursor))
  } catch (error) {
    crossRootCursorRejected = error instanceof TypeError
  }
  if (!crossRootCursorRejected) throw new Error("pagination cursor crossed Consul Store roots")
  await provider.delete(background(), isolatedKey)
  await provider.delete(background(), `${KeyRoot}isolated-next`)
  await secondary.delete(background(), isolatedKey)

  const corruptKey = physicalKey(ProviderRoot, `${KeyRoot}corrupt`)
  await writeRawKey(address, corruptKey, "not-a-likego-envelope")
  let corruptOwnedDataFailedClosed = false
  try {
    await provider.list(background(), prefix(KeyRoot))
  } catch (error) {
    corruptOwnedDataFailedClosed =
      typeof error === "object" &&
      error !== null &&
      Object.getOwnPropertyDescriptor(error, "code")?.value === "LIKEGO_CONSUL_STORE_PROTOCOL"
  }
  await deleteRawKey(address, corruptKey, false)
  if (!corruptOwnedDataFailedClosed) {
    throw new Error("corrupt KV inside the provider root did not fail closed")
  }

  const absentKey = `${KeyRoot}if-absent`
  const peer = store(address)
  const absentAttempts = await Promise.allSettled([
    provider.write(
      background(),
      { key: absentKey, value: new TextEncoder().encode("first") },
      ifAbsent()
    ),
    peer.write(
      background(),
      { key: absentKey, value: new TextEncoder().encode("second") },
      ifAbsent()
    )
  ])
  const absentSuccesses = absentAttempts.filter((result) => result.status === "fulfilled")
  const absentFailures = absentAttempts.filter((result) => result.status === "rejected")
  const absentFailure = absentFailures[0]
  const concurrentIfAbsent =
    absentSuccesses.length === 1 &&
    absentFailures.length === 1 &&
    absentFailure?.status === "rejected" &&
    typeof absentFailure.reason === "object" &&
    absentFailure.reason !== null &&
    Object.getOwnPropertyDescriptor(absentFailure.reason, "code")?.value ===
      "LIKEGO_STORE_CONFLICT" &&
    Object.getOwnPropertyDescriptor(absentFailure.reason, "expectedRevision")?.value === null
  if (!concurrentIfAbsent) {
    throw new Error("real Consul CAS=0 did not admit exactly one ifAbsent writer")
  }
  await provider.delete(background(), absentKey)

  const crudKey = `${KeyRoot}crud`
  const created = await provider.write(background(), {
    key: crudKey,
    value: new TextEncoder().encode("created"),
    metadata: { region: "east" }
  })
  const updated = await provider.write(
    background(),
    { key: crudKey, value: new TextEncoder().encode("updated") },
    ifRevision(created.revision)
  )
  let staleConflict = false
  try {
    await provider.write(
      background(),
      { key: crudKey, value: new TextEncoder().encode("stale") },
      ifRevision(created.revision)
    )
  } catch (error) {
    staleConflict =
      typeof error === "object" &&
      error !== null &&
      Object.getOwnPropertyDescriptor(error, "code")?.value === "LIKEGO_STORE_CONFLICT"
  }
  const read = await provider.read(background(), crudKey)
  if (new TextDecoder().decode(read?.value) !== "updated") {
    throw new Error("real Consul CRUD round-trip failed")
  }

  const prefixRoot = `${KeyRoot}list/`
  for (const key of [`${prefixRoot}😀`, `${prefixRoot}a`, `${prefixRoot}中`, `${prefixRoot}A`]) {
    await provider.write(background(), { key, value: new TextEncoder().encode(key) })
  }
  const first = await provider.list(background(), prefix(prefixRoot), limit(2))
  if (first.cursor === null) throw new Error("real Consul first page cursor missing")
  const second = await provider.list(
    background(),
    prefix(prefixRoot),
    limit(2),
    cursor(first.cursor)
  )
  const ordered = first.records.concat(second.records).map(function key(record) {
    return record.key
  })
  const expectedOrder = [`${prefixRoot}A`, `${prefixRoot}a`, `${prefixRoot}中`, `${prefixRoot}😀`]
  if (JSON.stringify(ordered) !== JSON.stringify(expectedOrder) || second.cursor !== null) {
    throw new Error(`real Consul prefix pagination drifted: ${ordered.join(",")}`)
  }
  const stalePage = await provider.list(background(), prefix(prefixRoot), limit(1))
  if (stalePage.cursor === null) throw new Error("real Consul stale cursor setup failed")
  const insertedKey = `${prefixRoot}new`
  await provider.write(background(), {
    key: insertedKey,
    value: new TextEncoder().encode(insertedKey)
  })
  let staleRejected = false
  try {
    await provider.list(background(), prefix(prefixRoot), limit(1), cursor(stalePage.cursor))
  } catch (error) {
    staleRejected = error instanceof TypeError && error.message.includes("cursor is stale")
  }
  if (!staleRejected) throw new Error("real Consul accepted a cursor from an older KV index")
  await provider.delete(background(), insertedKey)
  for (const key of expectedOrder) await provider.delete(background(), key)
  await provider.delete(background(), crudKey, ifRevision(updated.revision))

  const naturalKey = `${KeyRoot}ttl-natural`
  await provider.write(
    background(),
    { key: naturalKey, value: Uint8Array.of(1) },
    expiresIn(10_000)
  )
  const naturalRows = await rawRows(address, physicalKey(ProviderRoot, naturalKey))
  const naturalSession = naturalRows[0]?.Session
  if (typeof naturalSession !== "string" || naturalSession.length === 0) {
    throw new Error("real Consul TTL record did not acquire a Session")
  }

  const earlyKey = `${KeyRoot}ttl-client-independence`
  await provider.write(background(), { key: earlyKey, value: Uint8Array.of(2) }, expiresIn(10_000))
  const earlySession = (await rawRows(address, physicalKey(ProviderRoot, earlyKey)))[0]?.Session
  if (typeof earlySession !== "string") throw new Error("early TTL Session missing")
  const clientIndependencePreservedTtl =
    (await rawRows(address, physicalKey(ProviderRoot, earlyKey))).length === 1 &&
    (await sessions(address)).some(function retained(row) {
      return row.ID === earlySession
    })
  const cleanupStore = store(address)
  if (!(await cleanupStore.delete(background(), earlyKey))) {
    throw new Error("explicit TTL delete was not accepted")
  }
  const earlyClean =
    (await rawRows(address, physicalKey(ProviderRoot, earlyKey))).length === 0 &&
    !(await sessions(address)).some(function retained(row) {
      return row.ID === earlySession
    })

  const directName = `likego-store:direct-conflict-${RunId}`
  const create = await consulRequest(
    address,
    "/v1/session/create",
    "PUT",
    JSON.stringify({
      Name: directName,
      Behavior: "delete",
      TTL: "10000ms",
      LockDelay: "0s",
      NodeChecks: []
    })
  )
  if (!create.ok) throw new Error(`direct Session create returned ${create.status}`)
  const direct: unknown = await create.json()
  const directSession =
    typeof direct === "object" && direct !== null
      ? Object.getOwnPropertyDescriptor(direct, "ID")?.value
      : null
  if (typeof directSession !== "string") throw new Error("direct Session ID missing")
  const conflictKey = physicalKey(ProviderRoot, `${KeyRoot}cas-acquire-conflict`)
  const encodedConflict = conflictKey.split("/").map(encodeURIComponent).join("/")
  const conflict = await consulRequest(
    address,
    `/v1/kv/${encodedConflict}?cas=0&acquire=${encodeURIComponent(directSession)}`,
    "PUT",
    "value"
  )
  const conflictBody = await conflict.text()
  const conflictObserved = conflict.status === 400 && conflictBody.includes("Conflicting flags:")
  await destroyRawSession(address, directSession)

  const expiryReader = store(address)
  const hiddenDeadline = Date.now() + 12_000
  while (
    Date.now() < hiddenDeadline &&
    (await expiryReader.read(background(), naturalKey)) !== null
  ) {
    await pause(100)
  }
  const logicallyExpired = (await expiryReader.read(background(), naturalKey)) === null
  const ttlRemovalMs = await waitForTtlRemoval(
    address,
    physicalKey(ProviderRoot, naturalKey),
    naturalSession
  )

  const restartKey = `${KeyRoot}restart`
  const restartWriter = store(address)
  const restartRecord = await restartWriter.write(background(), {
    key: restartKey,
    value: new TextEncoder().encode("survives-restart")
  })
  await docker(["restart", PrimaryName])
  const restartedAddress = await mappedAddress(PrimaryName)
  await ready(restartedAddress)
  const restartReader = store(restartedAddress)
  const restarted = await restartReader.read(background(), restartKey)
  const restartPreserved =
    new TextDecoder().decode(restarted?.value) === "survives-restart" &&
    restarted?.revision === restartRecord.revision
  await restartReader.delete(background(), restartKey, ifRevision(restartRecord.revision))

  return Object.freeze({
    address: restartedAddress,
    externalKvIgnored,
    differentRootsIsolated,
    crossRootCursorRejected,
    corruptOwnedDataFailedClosed,
    concurrentIfAbsent,
    crudRoundTrip: true,
    modifyIndexAdvanced: updated.revision !== created.revision,
    staleConflict,
    staleCursorRejected: staleRejected,
    prefixOrder: ordered,
    clientIndependencePreservedTtl,
    explicitDeleteRemovedExactSession: earlyClean,
    casAcquireStatus: conflict.status,
    casAcquireConflictObserved: conflictObserved,
    logicallyExpired,
    ttlRemovalMs,
    restartPreserved
  })
}

/** Verifies real ACL deny/allow, header-only token use, TTL cleanup, and redaction boundaries. */
async function aclScenarios(address: string): Promise<Readonly<Record<string, unknown>>> {
  const anonymous = store(address)
  let deniedStatus = 0
  try {
    await anonymous.read(background(), `${KeyRoot}denied`)
  } catch (error) {
    if (typeof error === "object" && error !== null) {
      const status = Object.getOwnPropertyDescriptor(error, "status")?.value
      if (typeof status === "number") deniedStatus = status
    }
  }
  const traces: RequestEvidence[] = []
  const authorized = store(address, AclToken, traces)
  const key = `${KeyRoot}acl`
  await authorized.write(background(), { key, value: Uint8Array.of(1) })
  const authorizedRead = (await authorized.read(background(), key)) !== null
  await authorized.delete(background(), key)
  const ttlKey = `${KeyRoot}acl-ttl`
  await authorized.write(background(), { key: ttlKey, value: Uint8Array.of(2) }, expiresIn(10_000))
  const ttlDeleted = await authorized.delete(background(), ttlKey)
  const tokenOnlyInHeader =
    traces.length > 0 &&
    traces.every(function header(trace) {
      return trace.token === AclToken
    }) &&
    traces.every(function url(trace) {
      return !trace.url.includes(AclToken)
    }) &&
    traces.every(function redirect(trace) {
      return trace.redirect === "error"
    })
  return Object.freeze({
    deniedStatus,
    authorizedRead,
    ttlDeleted,
    tokenOnlyInHeader
  })
}

/** Adds one failure once without replacing an earlier scenario failure. */
function addFailure(failures: unknown[], value: unknown): void {
  if (!failures.includes(value)) failures.push(value)
}

/** Runs every real Consul scenario and proves final remote/container cleanup. */
async function main(): Promise<void> {
  const baseline = await docker(["ps", "--all", "--quiet", "--filter", `label=${Label}`])
  if (baseline.stdout !== "") throw new Error("integration label was not clean before startup")
  const engine = await docker(["version", "--format", "{{.Server.Version}}"])
  let primaryAddress = ""
  let aclAddress = ""
  let primaryEvidence: Readonly<Record<string, unknown>> = Object.freeze({})
  let aclEvidence: Readonly<Record<string, unknown>> = Object.freeze({})
  let binaryVersion = "unobserved"
  let imageReference = "unobserved"
  let imageId = "unobserved"
  let primaryFailure: unknown | null = null
  const cleanupFailures: unknown[] = []
  let primaryKvResidual = -1
  let primarySessionResidual = -1
  let aclKvResidual = -1
  let aclSessionResidual = -1
  try {
    primaryAddress = await startPrimary()
    const version = await docker(["exec", PrimaryName, "consul", "version"])
    binaryVersion = version.stdout.split("\n")[0] ?? "missing"
    const inspect = await docker([
      "inspect",
      PrimaryName,
      "--format",
      "{{.Config.Image}}|{{.Image}}"
    ])
    const split = inspect.stdout.split("|")
    imageReference = split[0] ?? "missing"
    imageId = split[1] ?? "missing"
    if (!binaryVersion.includes("Consul v2.0.2") || imageReference !== Image) {
      throw new Error("pinned Consul version or image reference did not match")
    }
    primaryEvidence = await primaryScenarios(primaryAddress)
    const restarted = Object.getOwnPropertyDescriptor(primaryEvidence, "address")?.value
    if (typeof restarted === "string") primaryAddress = restarted
    await cleanRemote(primaryAddress)
    primaryKvResidual =
      (await rawRows(primaryAddress, `${ProviderRoot}/`, true)).length +
      (await rawRows(primaryAddress, `${SecondaryRoot}/`, true)).length +
      (await rawRows(primaryAddress, ExternalKey)).length
    primarySessionResidual = (await providerSessions(primaryAddress)).length
    if (primaryKvResidual !== 0 || primarySessionResidual !== 0) {
      throw new Error("primary Consul retained KV or provider Session residue")
    }

    aclAddress = await startAcl()
    aclEvidence = await aclScenarios(aclAddress)
    await cleanRemote(aclAddress, AclToken)
    aclKvResidual =
      (await rawRows(aclAddress, `${ProviderRoot}/`, true, AclToken)).length +
      (await rawRows(aclAddress, `${SecondaryRoot}/`, true, AclToken)).length +
      (await rawRows(aclAddress, ExternalKey, false, AclToken)).length
    aclSessionResidual = (await providerSessions(aclAddress, AclToken)).length
    if (aclKvResidual !== 0 || aclSessionResidual !== 0) {
      throw new Error("ACL Consul retained KV or provider Session residue")
    }
  } catch (error) {
    primaryFailure = error
  } finally {
    if (primaryAddress !== "") {
      try {
        await cleanRemote(primaryAddress)
      } catch (error) {
        addFailure(cleanupFailures, error)
      }
    }
    if (aclAddress !== "") {
      try {
        await cleanRemote(aclAddress, AclToken)
      } catch (error) {
        addFailure(cleanupFailures, error)
      }
    }
    for (const name of [AclName, PrimaryName]) {
      const removed = await docker(["rm", "--force", name], true)
      if (removed.exitCode !== 0 && !removed.stderr.includes("No such container")) {
        addFailure(cleanupFailures, new Error(`failed to remove integration container ${name}`))
      }
    }
    const removedVolume = await docker(["volume", "rm", PrimaryVolume], true)
    if (removedVolume.exitCode !== 0 && !removedVolume.stderr.includes("no such volume")) {
      addFailure(cleanupFailures, new Error(`failed to remove integration volume ${PrimaryVolume}`))
    }
  }
  const remaining = await docker(["ps", "--all", "--quiet", "--filter", `label=${Label}`])
  const containerResidual = remaining.stdout === "" ? 0 : remaining.stdout.split("\n").length
  if (containerResidual !== 0) {
    addFailure(cleanupFailures, new Error(`integration containers leaked: ${remaining.stdout}`))
  }
  if (primaryFailure !== null || cleanupFailures.length !== 0) {
    const failures =
      primaryFailure === null ? cleanupFailures : [primaryFailure, ...cleanupFailures]
    throw new AggregateError(failures, "Consul Store Docker integration failed")
  }
}

await main()
