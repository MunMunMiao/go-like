import { randomUUID } from "node:crypto"
import { resolve } from "node:path"

interface SuiteDefinition {
  readonly id: string
  readonly cwd: string
  readonly command: readonly string[]
  readonly docker: boolean
  readonly timeoutMs: number
}

interface CommandResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

interface CommandDefinition {
  readonly cwd: string
  readonly command: readonly string[]
  readonly timeoutMs: number
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined
  readonly signal?: AbortSignal | undefined
  readonly forwardOutput?: boolean | undefined
}

interface StreamCapture {
  readonly done: Promise<void>
  readonly cancel: (reason: unknown) => Promise<void>
  readonly text: () => string
}

type TimedSettlement<T> =
  | { readonly kind: "fulfilled"; readonly value: T }
  | { readonly kind: "rejected"; readonly reason: unknown }
  | { readonly kind: "aborted"; readonly reason: unknown }
  | { readonly kind: "timeout" }

export interface DockerSnapshot {
  readonly containers: ReadonlySet<string>
  readonly networks: ReadonlySet<string>
  readonly volumes: ReadonlySet<string>
}

const ProcessTerminationReserveMs = 7_000
const DockerCleanupReserveMs = 45_000
const DockerInventoryTimeoutMs = 10_000
const DockerCleanupQuietMs = 2_000
const DockerCleanupPollMs = 100
const DockerOwnerLabel = "io.likego.e2e.owner"
const DockerOwnerPattern = /^[a-z0-9][a-z0-9_.-]{0,127}$/

const Definitions: readonly SuiteDefinition[] = Object.freeze([
  {
    id: "runner-process",
    cwd: ".",
    command: ["bun", "test", "--isolate", "--no-orphans", "e2e/runner-process.test.ts"],
    docker: false,
    timeoutMs: 30000
  },
  {
    id: "store-file-process",
    cwd: ".",
    command: ["bun", "e2e/scripts/store-file-process.ts"],
    docker: false,
    timeoutMs: 60000
  },
  {
    id: "vanilla-node",
    cwd: ".",
    command: ["node", "e2e/scripts/web-framework-native.ts", "vanilla"],
    docker: false,
    timeoutMs: 30000
  },
  {
    id: "hono-node",
    cwd: ".",
    command: ["node", "e2e/scripts/web-framework-native.ts", "hono"],
    docker: false,
    timeoutMs: 30000
  },
  {
    id: "elysia-node",
    cwd: ".",
    command: ["node", "e2e/scripts/web-framework-native.ts", "elysia"],
    docker: false,
    timeoutMs: 30000
  },
  {
    id: "h3-node",
    cwd: ".",
    command: ["node", "e2e/scripts/web-framework-native.ts", "h3"],
    docker: false,
    timeoutMs: 30000
  },
  {
    id: "web-node-native",
    cwd: "packages/web",
    command: ["bun", "run", "test:e2e"],
    docker: false,
    timeoutMs: 60000
  },
  {
    id: "transport-http-node",
    cwd: "packages/transport/http",
    command: ["bun", "run", "test:e2e"],
    docker: false,
    timeoutMs: 60000
  },
  {
    id: "cron-native",
    cwd: "packages/croner",
    command: ["bun", "run", "test:e2e"],
    docker: false,
    timeoutMs: 60000
  },
  {
    id: "bullmq-docker",
    cwd: "packages/bullmq",
    command: ["bun", "run", "test:e2e"],
    docker: true,
    timeoutMs: 180000
  },
  {
    id: "nats-core-docker",
    cwd: "packages/nats",
    command: ["bun", "run", "test:e2e:core"],
    docker: true,
    timeoutMs: 180000
  },
  {
    id: "nats-jetstream-docker",
    cwd: "packages/nats",
    command: ["bun", "run", "test:e2e:jetstream"],
    docker: true,
    timeoutMs: 180000
  },
  {
    id: "config-consul-docker",
    cwd: "packages/config/consul",
    command: ["bun", "run", "test:e2e"],
    docker: true,
    timeoutMs: 180000
  },
  {
    id: "config-etcd-docker",
    cwd: "packages/config/etcd",
    command: ["bun", "run", "test:e2e"],
    docker: true,
    timeoutMs: 180000
  },
  {
    id: "store-consul-docker",
    cwd: "packages/store/consul",
    command: ["bun", "run", "test:e2e"],
    docker: true,
    timeoutMs: 300000
  },
  {
    id: "store-etcd-docker",
    cwd: "packages/store/etcd",
    command: ["bun", "run", "test:e2e"],
    docker: true,
    timeoutMs: 240000
  },
  {
    id: "registry-consul-docker",
    cwd: "packages/registry/consul",
    command: ["bun", "run", "test:e2e"],
    docker: true,
    timeoutMs: 300000
  },
  {
    id: "registry-etcd-docker",
    cwd: "packages/registry/etcd",
    command: ["bun", "run", "test:e2e"],
    docker: true,
    timeoutMs: 300000
  },
  {
    id: "registry-kubernetes-docker",
    cwd: "packages/registry/kubernetes",
    command: ["bun", "run", "test:e2e"],
    docker: true,
    timeoutMs: 420000
  },
  {
    id: "registry-zookeeper-docker",
    cwd: "packages/registry/zookeeper",
    command: ["bun", "run", "test:e2e"],
    docker: true,
    timeoutMs: 420000
  },
  {
    id: "registry-transport-consul-docker",
    cwd: ".",
    command: ["bun", "e2e/scripts/registry-transport-consul-docker.ts"],
    docker: true,
    timeoutMs: 180000
  },
  {
    id: "registry-mdns-docker",
    cwd: "packages/registry/mdns",
    command: ["bun", "run", "test:e2e"],
    docker: true,
    timeoutMs: 240000
  },
  {
    id: "otel-docker",
    cwd: "packages/otel",
    command: ["bun", "run", "test:e2e"],
    docker: true,
    timeoutMs: 300000
  },
  {
    id: "broker-rabbitmq-docker",
    cwd: "packages/broker/rabbitmq",
    command: ["bun", "run", "test:e2e"],
    docker: true,
    timeoutMs: 420000
  },
  {
    id: "cache-redis-docker",
    cwd: "packages/cache/redis",
    command: ["bun", "run", "test:e2e"],
    docker: true,
    timeoutMs: 420000
  },
  {
    id: "config-kubernetes-docker",
    cwd: "packages/config/kubernetes",
    command: ["bun", "run", "test:e2e"],
    docker: true,
    timeoutMs: 420000
  },
  {
    id: "config-vault-docker",
    cwd: "packages/config/vault",
    command: ["bun", "run", "test:e2e"],
    docker: true,
    timeoutMs: 300000
  },
  {
    id: "store-vault-docker",
    cwd: "packages/store/vault",
    command: ["bun", "run", "test:e2e"],
    docker: true,
    timeoutMs: 300000
  },
  {
    id: "transport-http-node-security",
    cwd: "packages/transport/http",
    command: ["bun", "run", "test:e2e:node-security"],
    docker: true,
    timeoutMs: 300000
  },
  {
    id: "examples",
    cwd: ".",
    command: ["bun", "run", "--filter", "@likego/example-*", "--sequential", "test:e2e"],
    docker: true,
    timeoutMs: 2_700_000
  }
])

/** Settles one promise within a caller-owned deadline without leaving an unhandled rejection. */
async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<TimedSettlement<T>> {
  return await new Promise<TimedSettlement<T>>(function settle(resolveSettlement) {
    let settled = false
    function finish(settlement: TimedSettlement<T>): void {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal?.removeEventListener("abort", aborted)
      resolveSettlement(Object.freeze(settlement))
    }
    function aborted(): void {
      finish({ kind: "aborted", reason: signal?.reason })
    }
    const timeout = setTimeout(function timedOut() {
      finish({ kind: "timeout" })
    }, timeoutMs)
    signal?.addEventListener("abort", aborted, { once: true })
    if (signal?.aborted === true) aborted()
    promise.then(
      function fulfilled(value) {
        finish({ kind: "fulfilled", value })
      },
      function rejected(reason: unknown) {
        finish({ kind: "rejected", reason })
      }
    )
  })
}

/** Captures a subprocess pipe while retaining a cancellation path for inherited descriptors. */
function captureStream(
  stream: ReadableStream<Uint8Array>,
  forward?: (chunk: Uint8Array) => void
): StreamCapture {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let output = ""
  const done = (async function read(): Promise<void> {
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        forward?.(chunk.value)
        output += decoder.decode(chunk.value, { stream: true })
      }
      output += decoder.decode()
    } finally {
      reader.releaseLock()
    }
  })()
  return Object.freeze({
    done,
    async cancel(reason: unknown): Promise<void> {
      await reader.cancel(reason)
    },
    text(): string {
      return output
    }
  })
}

/** Returns whether a POSIX process group still owns at least one process. */
function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0)
    return true
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH")
  }
}

/** Sends one argv-safe signal to the complete detached child tree. */
function signalProcessTree(child: Bun.Subprocess, signal: "SIGTERM" | "SIGKILL"): void {
  if (process.platform === "win32") {
    const force = signal === "SIGKILL" ? ["/F"] : []
    Bun.spawnSync(["taskkill", "/PID", String(child.pid), "/T", ...force], {
      stdout: "ignore",
      stderr: "ignore"
    })
    return
  }
  try {
    process.kill(-child.pid, signal)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return
    child.kill(signal)
  }
}

/** Terminates an argv-spawned process tree, escalating after a bounded POSIX grace period. */
async function terminateProcessTree(child: Bun.Subprocess): Promise<void> {
  if (process.platform === "win32") {
    signalProcessTree(child, "SIGKILL")
    return
  }
  signalProcessTree(child, "SIGTERM")
  const deadline = performance.now() + 2_000
  while (processGroupExists(child.pid) && performance.now() < deadline) {
    await Bun.sleep(25)
  }
  if (processGroupExists(child.pid)) signalProcessTree(child, "SIGKILL")
}

/** Cancels inherited output pipes without allowing cancellation itself to become unbounded. */
async function cancelCaptures(captures: readonly StreamCapture[], reason: unknown): Promise<void> {
  const cancellation = Promise.allSettled(
    captures.map(function cancel(capture) {
      return capture.cancel(reason)
    })
  )
  await settleWithin(cancellation, 1_000)
}

/** Runs one argv-safe detached child tree with a hard owner timeout. */
export async function runCommand(
  root: string,
  definition: CommandDefinition
): Promise<CommandResult> {
  if (definition.signal?.aborted === true) throw definition.signal.reason
  const child = Bun.spawn(definition.command.slice(), {
    cwd: resolve(root, definition.cwd),
    stdout: "pipe",
    stderr: "pipe",
    env: processEnv(definition.environment),
    detached: true
  })
  const stdout = captureStream(
    child.stdout,
    definition.forwardOutput ? (chunk) => process.stdout.write(chunk) : undefined
  )
  const stderr = captureStream(
    child.stderr,
    definition.forwardOutput ? (chunk) => process.stderr.write(chunk) : undefined
  )
  let exitCode: number | null = null
  const exited = child.exited.then(function observed(code) {
    exitCode = code
    return code
  })
  const complete = Promise.all([exited, stdout.done, stderr.done]).then(
    function commandComplete(values) {
      return values[0]
    }
  )
  const settlement = await settleWithin(complete, definition.timeoutMs, definition.signal)
  if (settlement.kind === "fulfilled") {
    if (process.platform !== "win32" && processGroupExists(child.pid)) {
      await terminateProcessTree(child)
      throw new Error("command exited while descendant processes remained")
    }
    return Object.freeze({
      exitCode: settlement.value,
      stdout: stdout.text(),
      stderr: stderr.text(),
      timedOut: false
    })
  }

  const reason =
    settlement.kind === "timeout"
      ? new Error(`command exceeded ${definition.timeoutMs}ms`)
      : settlement.kind === "aborted"
        ? settlement.reason
        : new Error("command output capture failed", { cause: settlement.reason })
  try {
    await terminateProcessTree(child)
  } catch (cleanupFailure) {
    try {
      signalProcessTree(child, "SIGKILL")
    } catch {
      // Direct termination remains available when group termination fails.
    }
    try {
      child.kill("SIGKILL")
    } catch {
      // The process may have exited between cleanup attempts.
    }
    try {
      process.stderr.write(
        `LikeGo runCommand process-tree cleanup failed: ${String(cleanupFailure)}\n`
      )
    } catch {
      // Cleanup diagnostics must not replace the settled command reason.
    }
  }
  const drained = await settleWithin(complete, 2_000)
  if (drained.kind !== "fulfilled") {
    await cancelCaptures([stdout, stderr], reason)
    await settleWithin(complete, 1_000)
  }
  if (settlement.kind === "rejected" || settlement.kind === "aborted") throw reason
  return Object.freeze({
    exitCode: exitCode ?? -1,
    stdout: stdout.text(),
    stderr: stderr.text(),
    timedOut: true
  })
}

/** Runs one command that must finish successfully inside its complete process-tree boundary. */
export async function runCheckedCommand(
  root: string,
  command: readonly string[],
  timeoutMs: number
): Promise<CommandResult> {
  const result = await runCommand(root, { cwd: ".", command, timeoutMs })
  if (result.timedOut) throw new Error(`command exceeded ${timeoutMs}ms`)
  if (result.exitCode !== 0) {
    throw new Error(
      `${command[0] ?? "command"} exited ${result.exitCode}: ${result.stderr.slice(-4_000)}`
    )
  }
  return result
}

/** Captures the current environment plus explicit child-only overrides. */
function processEnv(
  overrides: Readonly<Record<string, string | undefined>> = Object.freeze({})
): Readonly<Record<string, string | undefined>> {
  return Object.freeze(
    Object.fromEntries([...Object.entries(process.env), ...Object.entries(overrides)])
  )
}

/** Returns one timeout that fits before a shared suite deadline and its reserved cleanup window. */
function availableTimeout(
  deadline: number,
  reserveMs: number,
  maximumMs: number,
  label: string
): number {
  const available = Math.floor(deadline - performance.now()) - reserveMs
  if (available < 1)
    throw new Error(`${label} has no time remaining inside the suite owner deadline`)
  return Math.min(maximumMs, available)
}

/** Rejects missing or argv-unsafe Docker owner values before any resource can be created. */
function validDockerOwner(owner: string): string {
  if (!DockerOwnerPattern.test(owner)) throw new Error("invalid LIKEGO_E2E_OWNER")
  return owner
}

/** Creates one invocation-unique Docker owner value. */
export function newDockerOwner(suite: string): string {
  return validDockerOwner(`${suite}-${randomUUID()}`)
}

/** Returns exact-label Docker inventory commands for one invocation owner. */
export function dockerInventoryCommands(
  owner: string
): readonly [readonly string[], readonly string[], readonly string[]] {
  const filter = `label=${DockerOwnerLabel}=${validDockerOwner(owner)}`
  return [
    ["docker", "ps", "--all", "--filter", filter, "--format", "{{.Names}}"],
    ["docker", "network", "ls", "--filter", filter, "--format", "{{.Name}}"],
    ["docker", "volume", "ls", "--filter", filter, "--format", "{{.Name}}"]
  ]
}

/** Returns cleanup commands in dependency order: containers, networks, then volumes. */
export function dockerRemovalCommands(snapshot: DockerSnapshot): readonly (readonly string[])[] {
  const commands: string[][] = []
  const containers = Array.from(snapshot.containers).sort()
  const networks = Array.from(snapshot.networks).sort()
  const volumes = Array.from(snapshot.volumes).sort()
  if (containers.length > 0) commands.push(["docker", "rm", "--force", "--volumes", ...containers])
  if (networks.length > 0) commands.push(["docker", "network", "rm", ...networks])
  if (volumes.length > 0) commands.push(["docker", "volume", "rm", ...volumes])
  return Object.freeze(
    commands.map(function freezeCommand(command) {
      return Object.freeze(command)
    })
  )
}

/** Runs one bounded Docker inventory command and returns exact-label resource names. */
async function dockerNames(
  root: string,
  command: readonly string[],
  timeoutMs: number
): Promise<ReadonlySet<string>> {
  const result = await runCheckedCommand(root, command, timeoutMs)
  const names = result.stdout
    .split(/\r?\n/)
    .map(function trim(value) {
      return value.trim()
    })
    .filter(function nonempty(value) {
      return value.length > 0
    })
  return new Set(names)
}

/** Snapshots resources carrying one exact invocation owner label. */
async function dockerSnapshot(
  root: string,
  owner: string,
  timeoutMs: number
): Promise<DockerSnapshot> {
  const commands = dockerInventoryCommands(owner)
  const snapshots = await Promise.all([
    dockerNames(root, commands[0], timeoutMs),
    dockerNames(root, commands[1], timeoutMs),
    dockerNames(root, commands[2], timeoutMs)
  ])
  return Object.freeze({ containers: snapshots[0], networks: snapshots[1], volumes: snapshots[2] })
}

/** Fails and cleans when a Docker suite leaves any exact-owner resource behind. */
export async function verifyDockerOwnerCleanup(
  root: string,
  owner: string,
  deadline: number
): Promise<void> {
  const containers = new Set<string>()
  const networks = new Set<string>()
  const volumes = new Set<string>()
  const cleanupFailures: unknown[] = []
  let quietSince: number | null = null
  let remaining: DockerSnapshot = {
    containers: new Set<string>(),
    networks: new Set<string>(),
    volumes: new Set<string>()
  }
  while (true) {
    const inventoryTimeout = availableTimeout(
      deadline,
      25_000,
      DockerInventoryTimeoutMs,
      "Docker cleanup inventory"
    )
    const observed = await dockerSnapshot(root, owner, inventoryTimeout)
    remaining = observed
    const observedContainers = Array.from(observed.containers).sort()
    const observedNetworks = Array.from(observed.networks).sort()
    const observedVolumes = Array.from(observed.volumes).sort()
    if (
      observedContainers.length === 0 &&
      observedNetworks.length === 0 &&
      observedVolumes.length === 0
    ) {
      const now = performance.now()
      quietSince ??= now
      const quietRemaining = DockerCleanupQuietMs - (now - quietSince)
      if (quietRemaining <= 0) break
      const pauseMs = availableTimeout(
        deadline,
        ProcessTerminationReserveMs,
        Math.min(DockerCleanupPollMs, Math.ceil(quietRemaining)),
        "Docker cleanup quiet window"
      )
      await Bun.sleep(pauseMs)
      continue
    }
    quietSince = null
    for (const name of observedContainers) containers.add(name)
    for (const name of observedNetworks) networks.add(name)
    for (const name of observedVolumes) volumes.add(name)
    const failuresBeforeCleanup = cleanupFailures.length
    const commands = dockerRemovalCommands(observed)
    const containerCommand = observedContainers.length === 0 ? null : commands[0]
    if (containerCommand === undefined)
      throw new Error("Docker cleanup plan omitted owned containers")
    const dependentCommands = containerCommand === null ? commands : commands.slice(1)
    if (containerCommand !== null) {
      try {
        const timeoutMs = availableTimeout(deadline, 20_000, 10_000, "Docker container cleanup")
        await runCheckedCommand(root, containerCommand, timeoutMs)
      } catch (error) {
        cleanupFailures.push(error)
      }
    }
    const dependencyTimeout = availableTimeout(
      deadline,
      12_000,
      10_000,
      "Docker network and volume cleanup"
    )
    const dependencyCleanup = await Promise.allSettled(
      dependentCommands.map(function cleanup(command) {
        return runCheckedCommand(root, command, dependencyTimeout)
      })
    )
    for (const outcome of dependencyCleanup) {
      if (outcome.status === "rejected") cleanupFailures.push(outcome.reason)
    }
    if (cleanupFailures.length > failuresBeforeCleanup) {
      const finalInventoryTimeout = availableTimeout(
        deadline,
        ProcessTerminationReserveMs,
        8_000,
        "Docker post-cleanup inventory"
      )
      remaining = await dockerSnapshot(root, owner, finalInventoryTimeout)
      break
    }
  }
  const leakedContainers = Array.from(containers).sort()
  const leakedNetworks = Array.from(networks).sort()
  const leakedVolumes = Array.from(volumes).sort()
  const remainingContainers = Array.from(remaining.containers).sort()
  const remainingNetworks = Array.from(remaining.networks).sort()
  const remainingVolumes = Array.from(remaining.volumes).sort()
  if (leakedContainers.length > 0 || leakedNetworks.length > 0 || leakedVolumes.length > 0) {
    const message = `Docker suite leaked resources: containers=${leakedContainers.join(",")} networks=${leakedNetworks.join(",")} volumes=${leakedVolumes.join(",")}`
    if (
      cleanupFailures.length > 0 ||
      remainingContainers.length > 0 ||
      remainingNetworks.length > 0 ||
      remainingVolumes.length > 0
    ) {
      const failures = cleanupFailures.slice()
      if (
        remainingContainers.length > 0 ||
        remainingNetworks.length > 0 ||
        remainingVolumes.length > 0
      ) {
        failures.push(
          new Error(
            `Docker owner cleanup incomplete: containers=${remainingContainers.join(",")} networks=${remainingNetworks.join(",")} volumes=${remainingVolumes.join(",")}`
          )
        )
      }
      throw new AggregateError(failures, message)
    }
    throw new Error(message)
  }
  if (cleanupFailures.length > 0)
    throw new AggregateError(cleanupFailures, "Docker cleanup commands failed")
  if (
    remainingContainers.length > 0 ||
    remainingNetworks.length > 0 ||
    remainingVolumes.length > 0
  ) {
    throw new Error(
      `Docker owner cleanup incomplete: containers=${remainingContainers.join(",")} networks=${remainingNetworks.join(",")} volumes=${remainingVolumes.join(",")}`
    )
  }
}

export function suiteDefinitions(): readonly SuiteDefinition[] {
  return Definitions
}

export async function runSuite(root: string, suite: string, signal?: AbortSignal): Promise<void> {
  const definition = Definitions.find((candidate) => candidate.id === suite)
  if (definition === undefined) throw new Error(`unknown E2E suite ${suite}`)
  const deadline = performance.now() + definition.timeoutMs
  const owner = definition.docker ? newDockerOwner(suite) : null
  let failure: Error | null = null
  try {
    const timeoutMs = availableTimeout(
      deadline,
      definition.docker ? DockerCleanupReserveMs : ProcessTerminationReserveMs,
      definition.timeoutMs,
      `${suite} command`
    )
    const result = await runCommand(root, {
      cwd: definition.cwd,
      command: definition.command,
      timeoutMs,
      environment: owner === null ? undefined : { LIKEGO_E2E_OWNER: owner },
      signal,
      forwardOutput: true
    })
    const output = `${result.stdout}\n${result.stderr}`
    if (result.timedOut) throw new Error(`${suite} exceeded ${timeoutMs}ms`)
    if (result.exitCode !== 0) {
      throw new Error(`${suite} exited ${result.exitCode}: ${output.slice(-12_000)}`)
    }
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error))
  } finally {
    if (owner !== null) {
      try {
        await verifyDockerOwnerCleanup(root, owner, deadline)
      } catch (cleanupError) {
        const cause = cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError))
        failure =
          failure === null
            ? cause
            : new AggregateError([failure, cause], `${suite} failed and leaked Docker resources`)
      }
    }
  }
  if (failure !== null) throw failure
}
