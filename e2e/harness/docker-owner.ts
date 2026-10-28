import { randomUUID } from "node:crypto"

import { runCheckedCommand, runCommand, type ProcessSupervisor } from "./process"
import { availableTimeout, ProcessTerminationReserveMs } from "./result"

export interface DockerSnapshot {
  readonly containers: ReadonlySet<string>
  readonly networks: ReadonlySet<string>
  readonly volumes: ReadonlySet<string>
}

const DockerInventoryTimeoutMs = 10_000
const DockerCleanupQuietMs = 2_000
const DockerCleanupPollMs = 100
const DockerOwnerLabel = "io.go-like.e2e.owner"
const DockerOwnerPattern = /^[a-z0-9][a-z0-9_.-]{0,127}$/

/** Rejects missing or argv-unsafe Docker owner values before any resource can be created. */
function validDockerOwner(owner: string): string {
  if (!DockerOwnerPattern.test(owner)) throw new Error("invalid GO_LIKE_E2E_OWNER")
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
  timeoutMs: number,
  runner: ProcessSupervisor["run"]
): Promise<ReadonlySet<string>> {
  const result = await runCheckedCommand(root, command, timeoutMs, runner)
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
  timeoutMs: number,
  runner: ProcessSupervisor["run"]
): Promise<DockerSnapshot> {
  const commands = dockerInventoryCommands(owner)
  const snapshots = await Promise.all([
    dockerNames(root, commands[0], timeoutMs, runner),
    dockerNames(root, commands[1], timeoutMs, runner),
    dockerNames(root, commands[2], timeoutMs, runner)
  ])
  return Object.freeze({ containers: snapshots[0], networks: snapshots[1], volumes: snapshots[2] })
}

/** Fails and cleans when a Docker suite leaves any exact-owner resource behind. */
export async function verifyDockerOwnerCleanup(
  root: string,
  owner: string,
  deadline: number,
  runner: ProcessSupervisor["run"] = runCommand
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
    const observed = await dockerSnapshot(root, owner, inventoryTimeout, runner)
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
        await runCheckedCommand(root, containerCommand, timeoutMs, runner)
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
        return runCheckedCommand(root, command, dependencyTimeout, runner)
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
      remaining = await dockerSnapshot(root, owner, finalInventoryTimeout, runner)
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
