import { access, mkdir, readFile, rm } from "node:fs/promises"
import { resolve } from "node:path"

import { evaluateIPv6AliasEvidence, type IdentityLifecycleEvidence } from "./alias-evidence"
import { inspectPacketCapture, type MDNSPacketCaptureEvidence } from "./packet-capture"

const DockerOwner = process.env.GO_LIKE_E2E_OWNER
if (DockerOwner === undefined || !/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(DockerOwner))
  throw new Error("invalid GO_LIKE_E2E_OWNER")

interface CommandEnvironment {
  readonly [name: string]: string | undefined
}

interface CommandResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

interface JSONObject {
  readonly [name: string]: unknown
}

interface ProtectedContainer {
  readonly id: string
  readonly name: string
  readonly running: boolean
  readonly restartCount: number
}

interface NormalPhaseEvidence {
  readonly family: "ipv4" | "ipv6"
  readonly observer: JSONObject
  readonly collision: JSONObject
  readonly packets: MDNSPacketCaptureEvidence
}

interface CrashPhaseEvidence {
  readonly observer: JSONObject
  readonly publisherBeforeKill: JSONObject
  readonly publisherExitCode: number
  readonly packets: MDNSPacketCaptureEvidence
  readonly killWithoutGoodbye: boolean
}

/** Copies the current process environment and applies exact test variables. */
function environment(values: CommandEnvironment): CommandEnvironment {
  const output: { [name: string]: string | undefined } = {}
  for (const [name, value] of Object.entries(process.env)) output[name] = value
  for (const [name, value] of Object.entries(values)) output[name] = value
  return output
}

/** Normalizes an unknown thrown boundary value. */
function failure(value: unknown, message: string): Error {
  return value instanceof Error ? value : new Error(message)
}

/** Fails one exact real-E2E invariant. */
function verify(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/** Reports whether a value is a plain JSON object evidence shape. */
function isJSONObject(value: unknown): value is JSONObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Reads one immutable string-array field from a JSON evidence boundary. */
function stringArray(value: unknown, name: string): readonly string[] {
  verify(Array.isArray(value), `${name} must be an array`)
  const output: string[] = []
  for (const item of value) {
    verify(typeof item === "string", `${name} must contain only strings`)
    output.push(item)
  }
  return Object.freeze(output)
}

/** Reads exact lifecycle counts from the observer's raw watcher evidence. */
function identityLifecycle(value: unknown): IdentityLifecycleEvidence {
  verify(isJSONObject(value), "IPv6 identity lifecycle evidence must be an object")
  const identityCount = value.identityCount
  const createCount = value.createCount
  const updateCount = value.updateCount
  const deleteCount = value.deleteCount
  verify(
    typeof identityCount === "number" && Number.isInteger(identityCount),
    "IPv6 identityCount must be an integer"
  )
  verify(
    typeof createCount === "number" && Number.isInteger(createCount),
    "IPv6 createCount must be an integer"
  )
  verify(
    typeof updateCount === "number" && Number.isInteger(updateCount),
    "IPv6 updateCount must be an integer"
  )
  verify(
    typeof deleteCount === "number" && Number.isInteger(deleteCount),
    "IPv6 deleteCount must be an integer"
  )
  return Object.freeze({
    identityCount,
    createCount,
    updateCount,
    deleteCount
  })
}

/** Runs one Docker command without a shell and under a fixed hard timeout. */
async function command(
  args: readonly string[],
  env: CommandEnvironment,
  allowFailure = false,
  timeoutMs = 45_000
): Promise<CommandResult> {
  const child = Bun.spawn(Array.from(args), {
    cwd: resolve(import.meta.dir, "../../../../.."),
    env,
    stdout: "pipe",
    stderr: "pipe"
  })
  let timedOut = false
  const timer = setTimeout(
    /** Terminates only the bounded Docker CLI client; project cleanup remains in finally. */
    function terminate(): void {
      timedOut = true
      child.kill()
    },
    timeoutMs
  )
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ])
  clearTimeout(timer)
  const output = Object.freeze({ code, stdout: stdout.trim(), stderr: stderr.trim() })
  if (timedOut) throw new Error(`${args.join(" ")} timed out after ${timeoutMs}ms`)
  if (!allowFailure && code !== 0) throw new Error(`${args.join(" ")} failed: ${output.stderr}`)
  return output
}

/** Runs one compose command against an exact phase file and project. */
function compose(
  project: string,
  file: string,
  env: CommandEnvironment,
  args: readonly string[],
  allowFailure = false
): Promise<CommandResult> {
  const commandArgs = ["docker", "compose", "--project-name", project, "--file", file]
  for (const argument of args) commandArgs.push(argument)
  return command(commandArgs, env, allowFailure)
}

/** Reads one JSON object artifact or rejects primitive evidence. */
async function json(path: string): Promise<JSONObject> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"))
  if (!isJSONObject(value)) {
    throw new TypeError(`${path} must contain a JSON object`)
  }
  return value
}

/** Sleeps for one short bounded coordination interval. */
function delay(milliseconds: number): Promise<void> {
  return new Promise<void>(function wait(resolve): void {
    setTimeout(resolve, milliseconds)
  })
}

/** Waits until one cross-container artifact is visible on the host. */
async function waitForArtifact(path: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await access(path)
      return
    } catch {
      await delay(25)
    }
  }
  throw new Error(`timed out waiting for ${path}`)
}

/** Waits for exact container exit codes and rejects a partial or failed phase. */
async function waitContainers(
  names: readonly string[],
  env: CommandEnvironment,
  expected: readonly number[]
): Promise<readonly number[]> {
  const args = ["docker", "wait"]
  for (const name of names) args.push(name)
  const result = await command(args, env)
  const codes =
    result.stdout.length === 0
      ? []
      : result.stdout.split("\n").map(function code(value): number {
          return Number(value.trim())
        })
  verify(codes.length === expected.length, "docker wait returned an incomplete exit-code vector")
  for (let index = 0; index < expected.length; index += 1) {
    verify(
      codes[index] === expected[index],
      `${names[index] ?? "container"} exited ${String(codes[index])}`
    )
  }
  return Object.freeze(codes)
}

/** Produces readable phase failure evidence from compose logs. */
async function phaseFailure(
  error: unknown,
  project: string,
  file: string,
  env: CommandEnvironment
): Promise<Error> {
  const logs = await compose(project, file, env, ["logs", "--no-color"], true)
  const cause = failure(error, "registry-mdns Docker phase failed")
  const details = logs.stdout.length === 0 ? logs.stderr : logs.stdout
  return new Error(`${cause.message}${details.length === 0 ? "" : `\n${details}`}`, { cause })
}

/** Combines an operation failure with independent cleanup failures. */
function combine(primary: Error | null, cleanup: readonly Error[], message: string): void {
  const failures: Error[] = []
  if (primary !== null) failures.push(primary)
  for (const error of cleanup) failures.push(error)
  if (failures.length === 0) return
  if (failures.length === 1) throw failures[0]
  throw new AggregateError(failures, message)
}

/** Removes only one labeled compose project and proves its containers/network disappeared. */
async function cleanupProject(
  project: string,
  file: string,
  run: string,
  artifacts: string,
  env: CommandEnvironment
): Promise<void> {
  const failures: Error[] = []
  try {
    const down = await compose(
      project,
      file,
      env,
      ["down", "--volumes", "--remove-orphans", "--timeout", "3"],
      true
    )
    if (down.code !== 0)
      failures.push(new Error(`registry-mdns Docker cleanup failed: ${down.stderr}`))
  } catch (error) {
    failures.push(failure(error, "registry-mdns compose cleanup failed"))
  }
  const containers = await command(
    ["docker", "ps", "--all", "--quiet", "--filter", `label=go-like.run=${run}`],
    env,
    true
  )
  if (containers.code !== 0 || containers.stdout !== "")
    failures.push(new Error("registry-mdns containers remain"))
  const networks = await command(
    ["docker", "network", "ls", "--quiet", "--filter", `label=go-like.run=${run}`],
    env,
    true
  )
  if (networks.code !== 0 || networks.stdout !== "")
    failures.push(new Error("registry-mdns networks remain"))
  try {
    await rm(artifacts, { recursive: true, force: true })
  } catch (error) {
    failures.push(failure(error, "registry-mdns artifact cleanup failed"))
  }
  combine(null, failures, "registry-mdns project cleanup failed")
}

/** Validates one stopped-observer kernel socket audit. */
function validateSocketAudit(value: unknown, name: string): void {
  verify(
    typeof value === "object" && value !== null && !Array.isArray(value),
    `${name} audit is absent`
  )
  verify(Reflect.get(value, "socketFDs") === 0, `${name} retained socket descriptors`)
  verify(Reflect.get(value, "udp4Rows") === 0, `${name} retained /proc/net/udp port 5353`)
  verify(Reflect.get(value, "udp6Rows") === 0, `${name} retained /proc/net/udp6 port 5353`)
}

/** Validates one complete normal observer result. */
function validateNormalObserver(value: JSONObject, family: "ipv4" | "ipv6"): void {
  verify(
    value.valid === true && value.mode === "normal" && value.family === family,
    "normal observer identity is invalid"
  )
  for (const name of [
    "created",
    "updated",
    "restored",
    "rescued",
    "deleted",
    "domainIsolated",
    "completePayload",
    "stoppedObserverNoReceive"
  ])
    verify(value[name] === true, `normal observer omitted ${name}`)
  verify(
    Array.isArray(value.advertisedEndpoints) &&
      value.advertisedEndpoints.length === 1 &&
      typeof value.advertisedEndpoints[0] === "string",
    "normal observer omitted its advertised endpoint evidence"
  )
  if (family === "ipv6") {
    verify(
      new URL(value.advertisedEndpoints[0]).hostname.startsWith("[fd"),
      "IPv6 publisher did not advertise its Docker ULA"
    )
  }
  const cleanup = value.cleanup
  verify(
    typeof cleanup === "object" && cleanup !== null && !Array.isArray(cleanup),
    "normal cleanup evidence is absent"
  )
  validateSocketAudit(Reflect.get(cleanup, "afterStop"), "after-stop")
  validateSocketAudit(Reflect.get(cleanup, "finalAudit"), "final")
}

/** Validates one family-specific normal packet capture. */
function validateNormalPackets(value: MDNSPacketCaptureEvidence, family: "ipv4" | "ipv6"): void {
  verify(value.valid, `${family} packet capture did not satisfy wire invariants`)
  verify(
    value.ipTTLValues.length === 1 && value.ipTTLValues[0] === 255,
    `${family} IP TTL/hop limit is not 255`
  )
  verify(
    value.recordTTLValues.includes(120) && value.recordTTLValues.includes(0),
    `${family} RR TTL 120/0 evidence is absent`
  )
  verify(
    value.legacyNamespaceAbsent,
    `${family} packet capture contains the legacy Micro namespace`
  )
  verify(
    value.completeGraphs[family].positiveTTL120 && value.completeGraphs[family].goodbyeTTL0,
    `${family} packet capture omitted a complete positive or goodbye RR graph`
  )
  verify(
    value.cacheFlushCounts[family].invalid === 0,
    `${family} packet capture contains an invalid cache-flush class`
  )
  verify(
    value.cacheFlushCounts[family].shared > 0 && value.cacheFlushCounts[family].unique > 0,
    `${family} packet capture omitted shared or unique RR evidence`
  )
  const counts = value.recordTypeCounts[family]
  verify(
    counts.PTR > 0 && counts.SRV > 0 && counts.TXT > 0,
    `${family} packet capture omitted PTR/SRV/TXT`
  )
  if (family === "ipv4") {
    verify(
      value.ipv4ResponseCount > 0 && value.ipv6ResponseCount === 0,
      "IPv4 capture family evidence is invalid"
    )
    verify(counts.A > 0, "IPv4 capture omitted A records")
  } else {
    verify(
      value.ipv6ResponseCount > 0 && value.ipv4ResponseCount === 0,
      "IPv6 capture family evidence is invalid"
    )
    verify(counts.AAAA > 0, "IPv6 capture omitted AAAA records")
    verify(
      value.sourceAddresses.some(function linkLocal(address): boolean {
        return address.startsWith("fe80:")
      }),
      "IPv6 capture omitted a link-local multicast source address"
    )
  }
}

/** Executes one normal four-process multicast lifecycle and captures its wire evidence. */
async function runNormal(
  root: string,
  run: string,
  family: "ipv4" | "ipv6",
  ipv6Segment: string
): Promise<NormalPhaseEvidence> {
  const file = `packages/registry/mdns/test/e2e/compose.${family}.yaml`
  const project = `go-like-mdns-${run}`
  const artifacts = resolve(root, "packages/registry/mdns/.artifacts/docker", run)
  await mkdir(artifacts, { recursive: true })
  const env = environment({
    GO_LIKE_ARTIFACTS: artifacts,
    GO_LIKE_IPV6_SEGMENT: ipv6Segment,
    GO_LIKE_MODE: "normal",
    GO_LIKE_ROOT: root,
    GO_LIKE_RUN: run
  })
  let primary: Error | null = null
  const cleanup: Error[] = []
  let evidence: NormalPhaseEvidence | null = null
  try {
    await compose(project, file, env, ["up", "--detach"])
    const containers = [
      `${project}-observer-1`,
      `${project}-publisher-1`,
      `${project}-cooperator-1`,
      `${project}-collider-1`
    ]
    await waitContainers(containers, env, [0, 0, 0, 0])
    await compose(project, file, env, ["stop", "--timeout", "3", "capture"])
    await waitContainers([`${project}-capture-1`], env, [0])
    const observer = await json(resolve(artifacts, "observer-result.json"))
    const collision = await json(resolve(artifacts, "collider-result.json"))
    validateNormalObserver(observer, family)
    verify(
      collision.valid === true && collision.code === "GO_LIKE_REGISTRY_PROTOCOL",
      "collision did not fail closed"
    )
    const packets = await inspectPacketCapture(resolve(artifacts, `${family}.pcap`))
    validateNormalPackets(packets, family)
    evidence = Object.freeze({ family, observer, collision, packets })
  } catch (error) {
    primary = await phaseFailure(error, project, file, env)
  } finally {
    try {
      await cleanupProject(project, file, run, artifacts, env)
    } catch (error) {
      cleanup.push(failure(error, "normal registry-mdns cleanup failed"))
    }
  }
  combine(primary, cleanup, `${family} registry-mdns phase failed with cleanup errors`)
  if (evidence === null) throw new Error(`${family} registry-mdns phase produced no evidence`)
  return evidence
}

/** Reads the crashed publisher's PID-1 descriptor and kernel UDP table state. */
async function auditPublisher(container: string, env: CommandEnvironment): Promise<JSONObject> {
  const result = await command(
    [
      "docker",
      "exec",
      container,
      "node",
      "/workspace/packages/registry/mdns/test/e2e/socket-audit.ts"
    ],
    env
  )
  const value: unknown = JSON.parse(result.stdout)
  verify(isJSONObject(value), "publisher socket audit is invalid")
  verify(
    Number(Reflect.get(value, "socketFDs")) >= 1,
    "publisher had no live socket descriptor before SIGKILL"
  )
  verify(
    Number(Reflect.get(value, "udp4Rows")) >= 1,
    "publisher had no UDP/5353 kernel row before SIGKILL"
  )
  return value
}

/** Executes a true SIGKILL crash and proves TTL expiry without a goodbye. */
async function runCrash(root: string, run: string): Promise<CrashPhaseEvidence> {
  const file = "packages/registry/mdns/test/e2e/compose.ipv4.yaml"
  const project = `go-like-mdns-${run}`
  const artifacts = resolve(root, "packages/registry/mdns/.artifacts/docker", run)
  await mkdir(artifacts, { recursive: true })
  const env = environment({
    GO_LIKE_ARTIFACTS: artifacts,
    GO_LIKE_IPV6_SEGMENT: "10fe",
    GO_LIKE_MODE: "crash",
    GO_LIKE_ROOT: root,
    GO_LIKE_RUN: run
  })
  let primary: Error | null = null
  const cleanup: Error[] = []
  let evidence: CrashPhaseEvidence | null = null
  try {
    await compose(project, file, env, ["up", "--detach", "capture", "observer", "publisher"])
    await waitForArtifact(resolve(artifacts, "publisher-crash-ready"))
    await waitForArtifact(resolve(artifacts, "observer-cached"))
    const publisher = `${project}-publisher-1`
    const observer = `${project}-observer-1`
    const publisherBeforeKill = await auditPublisher(publisher, env)
    await command(["docker", "kill", "--signal", "KILL", publisher], env)
    const publisherCodes = await waitContainers([publisher], env, [137])
    await waitContainers([observer], env, [0])
    await compose(project, file, env, ["stop", "--timeout", "3", "capture"])
    await waitContainers([`${project}-capture-1`], env, [0])
    const observerResult = await json(resolve(artifacts, "observer-result.json"))
    verify(
      observerResult.valid === true &&
        observerResult.mode === "crash" &&
        observerResult.family === "ipv4" &&
        observerResult.createObserved === true &&
        observerResult.expiryDeleteObserved === true,
      "crash observer did not prove create-to-expiry-delete"
    )
    const crashCleanup = observerResult.cleanup
    verify(
      typeof crashCleanup === "object" && crashCleanup !== null,
      "crash cleanup evidence is absent"
    )
    validateSocketAudit(Reflect.get(crashCleanup, "after"), "crash observer")
    const packets = await inspectPacketCapture(resolve(artifacts, "ipv4.pcap"))
    verify(
      packets.responsePacketCount > 0 &&
        packets.ipTTLValues.length === 1 &&
        packets.ipTTLValues[0] === 255 &&
        packets.recordTTLValues.includes(2) &&
        packets.managedTXT,
      "crash capture omitted the live TTL=2 managed announcement"
    )
    verify(!packets.goodbyeTTL0, "SIGKILL crash unexpectedly emitted a TTL=0 goodbye")
    evidence = Object.freeze({
      observer: observerResult,
      publisherBeforeKill,
      publisherExitCode: publisherCodes[0] ?? -1,
      packets,
      killWithoutGoodbye: !packets.goodbyeTTL0
    })
  } catch (error) {
    primary = await phaseFailure(error, project, file, env)
  } finally {
    try {
      await cleanupProject(project, file, run, artifacts, env)
    } catch (error) {
      cleanup.push(failure(error, "crash registry-mdns cleanup failed"))
    }
  }
  combine(primary, cleanup, "crash registry-mdns phase failed with cleanup errors")
  if (evidence === null) throw new Error("crash registry-mdns phase produced no evidence")
  return evidence
}

/** Snapshots every protected id-system container without changing it. */
async function protectedContainers(
  env: CommandEnvironment
): Promise<readonly ProtectedContainer[]> {
  const listed = await command(
    ["docker", "ps", "--all", "--quiet", "--filter", "label=com.docker.compose.project=id-system"],
    env
  )
  const containers: ProtectedContainer[] = []
  const ids = listed.stdout.length === 0 ? [] : listed.stdout.split("\n")
  for (const id of ids) {
    const inspected = await command(
      [
        "docker",
        "inspect",
        "--format",
        "{{.Id}}|{{.Name}}|{{.State.Running}}|{{.RestartCount}}",
        id
      ],
      env
    )
    const parts = inspected.stdout.split("|")
    const inspectedId = parts[0]
    const rawName = parts[1]
    const running = parts[2]
    const restartCount = parts[3]
    if (
      inspectedId === undefined ||
      rawName === undefined ||
      running === undefined ||
      restartCount === undefined
    ) {
      throw new Error("protected container inspection is malformed")
    }
    containers.push(
      Object.freeze({
        id: inspectedId,
        name: rawName.startsWith("/") ? rawName.slice(1) : rawName,
        running: running === "true",
        restartCount: Number(restartCount)
      })
    )
  }
  containers.sort(function byID(left, right): number {
    return left.id.localeCompare(right.id)
  })
  return Object.freeze(containers)
}

/** Verifies that every protected container keeps its exact pre-test state. */
function validateProtected(
  before: readonly ProtectedContainer[],
  after: readonly ProtectedContainer[]
): void {
  verify(
    JSON.stringify(after) === JSON.stringify(before),
    "registry-mdns tests changed a protected id-system container"
  )
}

/** Executes all real mDNS phases. */
async function main(): Promise<void> {
  const root = resolve(import.meta.dir, "../../../../..")
  const invocation = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`
  const env = environment({})
  const protectedBefore = await protectedContainers(env)
  let primary: Error | null = null
  let ipv4: NormalPhaseEvidence | null = null
  let crash: CrashPhaseEvidence | null = null
  let ipv6: NormalPhaseEvidence | null = null
  try {
    ipv4 = await runNormal(root, `${invocation}-ipv4-normal`, "ipv4", "10fd")
    crash = await runCrash(root, `${invocation}-ipv4-crash`)
    const segment = `2${crypto.randomUUID().replaceAll("-", "").slice(0, 3)}`
    ipv6 = await runNormal(root, `${invocation}-ipv6-normal`, "ipv6", segment)
  } catch (error) {
    primary = failure(error, "registry-mdns Docker E2E failed")
  }
  const protectedAfter = await protectedContainers(env)
  try {
    validateProtected(protectedBefore, protectedAfter)
  } catch (error) {
    const protection = failure(error, "protected-container verification failed")
    if (primary === null) primary = protection
    else
      primary = new AggregateError(
        [primary, protection],
        "registry-mdns failed and changed protected containers"
      )
  }
  if (primary !== null) throw primary
  if (ipv4 === null || crash === null || ipv6 === null)
    throw new Error("registry-mdns Docker E2E omitted a phase")
  const ipv6AdvertisedEndpoints = stringArray(
    ipv6.observer.advertisedEndpoints,
    "IPv6 advertised endpoints"
  )
  const ipv6IdentityLifecycle = identityLifecycle(ipv6.observer.identityLifecycle)
  const ipv6Alias = evaluateIPv6AliasEvidence({
    advertisedEndpoints: ipv6AdvertisedEndpoints,
    packetSourceAddresses: ipv6.packets.sourceAddresses,
    lifecycle: ipv6IdentityLifecycle
  })
  verify(ipv6Alias.aliasObserved, "IPv6 ULA and link-local addresses split one service identity")
}

await main()
