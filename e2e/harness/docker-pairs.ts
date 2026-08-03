import { runCommand, type CommandResult, type ProcessSupervisor } from "./process"

export const DockerOwnerLabelKey = "io.likego.e2e.owner"
export const DockerInvocationLabelKey = "io.likego.e2e.invocation"

export type DockerResourceType = "container" | "network" | "volume"
export type DockerPairClassificationKind = "owned" | "collision" | "foreign"
export type DockerOwnerLabelClassification = "registered" | "unknown" | "missing"
export type DockerInvocationLabelClassification = "current" | "foreign" | "missing"

export interface DockerPairResource {
  readonly type: DockerResourceType
  /** Full container/network ID, or the immutable volume name. */
  readonly id: string
  readonly owner: string | null
  readonly invocation: string | null
}

export interface DockerPairClassification {
  readonly kind: DockerPairClassificationKind
  readonly owner: DockerOwnerLabelClassification
  readonly invocation: DockerInvocationLabelClassification
}

export interface DockerPairInventoryCommand {
  readonly type: DockerResourceType
  readonly filter: "invocation" | "owner"
  readonly command: readonly string[]
}

interface DockerPairInventorySource {
  readonly filter: "invocation" | "owner"
  readonly commands: readonly DockerPairInventoryCommand[]
}

const DockerResourceTypes = Object.freeze([
  "container",
  "network",
  "volume"
] as const satisfies readonly DockerResourceType[])
const DockerPairListTimeoutMs = 10_000
const DockerPairRemovalTimeoutMs = 10_000
const DockerPairQuietMs = 2_000
const DockerPairPollMs = 100
/** Bounds simultaneous registered-owner metadata sources; each source remains type-serial. */
const DockerPairOwnerInventoryConcurrency = 8
const DockerPairMaximumOutputCharacters = 256 * 1024
const DockerPairMaximumRows = 4_096
const DockerPairMaximumLineCharacters = 1_024
const DockerLabelValuePattern = /^[a-z0-9][a-z0-9_.-]{0,127}$/u
const DockerResourceIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/u

function validLabelValue(value: string, label: "owner" | "invocation"): string {
  if (!DockerLabelValuePattern.test(value)) {
    throw new Error(`invalid Docker ${label} label value`)
  }
  return value
}

function registeredOwnerSet(owners: Iterable<string>): ReadonlySet<string> {
  const registered = new Set<string>()
  for (const owner of owners) registered.add(validLabelValue(owner, "owner"))
  return registered
}

function validResourceType(value: DockerResourceType): DockerResourceType {
  if (!DockerResourceTypes.includes(value)) {
    throw new Error("invalid Docker resource type")
  }
  return value
}

function validResourceId(value: string): string {
  if (!DockerResourceIdPattern.test(value)) {
    throw new Error("invalid Docker resource identifier")
  }
  return value
}

function identityTemplate(type: DockerResourceType): string {
  return type === "volume" ? ".Name" : ".ID"
}

function metadataFormat(type: DockerResourceType): string {
  return `{{json ${identityTemplate(type)}}}\t{{json (.Label "${DockerOwnerLabelKey}")}}\t{{json (.Label "${DockerInvocationLabelKey}")}}`
}

function listCommand(type: DockerResourceType, filter: string): readonly string[] {
  const format = metadataFormat(type)
  if (type === "container") {
    return Object.freeze([
      "docker",
      "container",
      "ls",
      "--all",
      "--no-trunc",
      "--filter",
      filter,
      "--format",
      format
    ])
  }
  if (type === "network") {
    return Object.freeze([
      "docker",
      "network",
      "ls",
      "--no-trunc",
      "--filter",
      filter,
      "--format",
      format
    ])
  }
  return Object.freeze(["docker", "volume", "ls", "--filter", filter, "--format", format])
}

function dockerPairInventorySource(
  filter: "invocation" | "owner",
  value: string
): DockerPairInventorySource {
  return Object.freeze({
    filter,
    commands: Object.freeze(
      DockerResourceTypes.map(function inventoryCommand(type) {
        return Object.freeze({ type, filter, command: listCommand(type, value) })
      })
    )
  })
}

function dockerPairInventorySources(
  invocation: string,
  registeredOwners: Iterable<string>
): readonly DockerPairInventorySource[] {
  const currentInvocation = validLabelValue(invocation, "invocation")
  const owners = Array.from(registeredOwnerSet(registeredOwners)).sort()
  return Object.freeze([
    dockerPairInventorySource(
      "invocation",
      `label=${DockerInvocationLabelKey}=${currentInvocation}`
    ),
    ...owners.map((owner) =>
      dockerPairInventorySource("owner", `label=${DockerOwnerLabelKey}=${owner}`)
    )
  ])
}

/**
 * Returns metadata-only list commands for the union of the current invocation and every
 * registered child owner. No command inspects a resource or reads its logs.
 */
export function dockerPairInventoryCommands(
  invocation: string,
  registeredOwners: Iterable<string>
): readonly DockerPairInventoryCommand[] {
  return Object.freeze(
    dockerPairInventorySources(invocation, registeredOwners).flatMap((source) => source.commands)
  )
}

function parsedString(value: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  return typeof parsed === "string" ? parsed : null
}

function inventoryParseError(type: DockerResourceType): Error {
  return new Error(`Docker pair inventory invalid: type=${type} classification=unparseable`)
}

/** Parses one bounded metadata-only Docker list result without retaining untrusted raw output. */
export function parseDockerPairInventoryOutput(
  type: DockerResourceType,
  output: string
): readonly DockerPairResource[] {
  const resourceType = validResourceType(type)
  if (output.length > DockerPairMaximumOutputCharacters) throw inventoryParseError(resourceType)
  if (output.length === 0) return Object.freeze([])
  const lines = output.split(/\r?\n/u)
  if (lines.at(-1) === "") lines.pop()
  if (lines.length > DockerPairMaximumRows) throw inventoryParseError(resourceType)
  const resources: DockerPairResource[] = []
  for (const line of lines) {
    if (line.length === 0 || line.length > DockerPairMaximumLineCharacters) {
      throw inventoryParseError(resourceType)
    }
    const fields = line.split("\t")
    if (fields.length !== 3) throw inventoryParseError(resourceType)
    const id = parsedString(fields[0] ?? "")
    const owner = parsedString(fields[1] ?? "")
    const invocation = parsedString(fields[2] ?? "")
    if (id === null || owner === null || invocation === null) {
      throw inventoryParseError(resourceType)
    }
    let resourceId: string
    try {
      resourceId = validResourceId(id)
      if (owner.length > 0) validLabelValue(owner, "owner")
      if (invocation.length > 0) validLabelValue(invocation, "invocation")
    } catch {
      throw inventoryParseError(resourceType)
    }
    resources.push(
      Object.freeze({
        type: resourceType,
        id: resourceId,
        owner: owner.length === 0 ? null : owner,
        invocation: invocation.length === 0 ? null : invocation
      })
    )
  }
  return Object.freeze(resources)
}

/** Classifies one observation using only exact owner/invocation label equality. */
export function classifyDockerPairResource(
  resource: DockerPairResource,
  currentInvocation: string,
  registeredOwners: ReadonlySet<string>
): DockerPairClassification {
  const owner: DockerOwnerLabelClassification =
    resource.owner === null
      ? "missing"
      : registeredOwners.has(resource.owner)
        ? "registered"
        : "unknown"
  const invocation: DockerInvocationLabelClassification =
    resource.invocation === null
      ? "missing"
      : resource.invocation === currentInvocation
        ? "current"
        : "foreign"
  const kind: DockerPairClassificationKind =
    owner === "registered" && invocation === "current"
      ? "owned"
      : owner === "registered" || invocation === "current"
        ? "collision"
        : "foreign"
  return Object.freeze({ kind, owner, invocation })
}

function commandTimeout(
  deadline: number,
  maximumMs: number,
  operation: string,
  reserveMs = 0
): number {
  const remaining = Math.floor(deadline - performance.now()) - reserveMs
  if (remaining < 1) {
    throw new Error(
      `Docker pair deadline exhausted: operation=${operation} classification=unavailable`
    )
  }
  return Math.min(maximumMs, remaining)
}

function successfulCommand(result: CommandResult): boolean {
  return (
    !result.timedOut &&
    result.termination === "exit" &&
    result.exitCode === 0 &&
    result.cleanupFailures.length === 0 &&
    result.residual !== "present" &&
    result.residual !== "inconclusive"
  )
}

async function runDockerCommand(
  root: string,
  type: DockerResourceType,
  operation: "metadata-list" | "remove",
  command: readonly string[],
  timeoutMs: number,
  runner: ProcessSupervisor["run"]
): Promise<CommandResult> {
  let result: CommandResult
  try {
    result = await runner(root, { cwd: ".", command, timeoutMs })
  } catch {
    throw new Error(
      `Docker pair command failed: type=${type} operation=${operation} classification=unavailable`
    )
  }
  if (!successfulCommand(result)) {
    throw new Error(
      `Docker pair command failed: type=${type} operation=${operation} classification=unavailable`
    )
  }
  return result
}

function resourceKey(resource: DockerPairResource): string {
  return `${resource.type}\u0000${resource.id}`
}

function inconsistentCandidate(resource: DockerPairResource): Error {
  return new Error(
    `Docker pair candidate changed: type=${resource.type} id=${resource.id} owner-label=inconsistent invocation-label=inconsistent classification=collision`
  )
}

function dockerOwnerInventoryCommands(owner: string): readonly DockerPairInventoryCommand[] {
  const filter = `label=${DockerOwnerLabelKey}=${validLabelValue(owner, "owner")}`
  return Object.freeze(
    DockerResourceTypes.map(function ownerInventory(type) {
      return Object.freeze({ type, filter: "owner" as const, command: listCommand(type, filter) })
    })
  )
}

function recordInventoryResources(
  candidates: Map<string, DockerPairResource>,
  resources: readonly DockerPairResource[]
): void {
  for (const resource of resources) {
    const key = resourceKey(resource)
    const previous = candidates.get(key)
    if (previous === undefined) {
      candidates.set(key, resource)
    } else if (previous.owner !== resource.owner || previous.invocation !== resource.invocation) {
      throw inconsistentCandidate(resource)
    }
  }
}

async function inventoryDockerPairSource(
  root: string,
  source: DockerPairInventorySource,
  deadline: number,
  runner: ProcessSupervisor["run"],
  candidates: Map<string, DockerPairResource>
): Promise<void> {
  for (const [index, definition] of source.commands.entries()) {
    const timeoutMs = commandTimeout(
      deadline,
      DockerPairListTimeoutMs,
      "metadata-list",
      source.commands.length - index - 1
    )
    const result = await runDockerCommand(
      root,
      definition.type,
      "metadata-list",
      definition.command,
      timeoutMs,
      runner
    )
    recordInventoryResources(
      candidates,
      parseDockerPairInventoryOutput(definition.type, result.stdout)
    )
  }
}

async function inventoryOwnerSources(
  root: string,
  sources: readonly DockerPairInventorySource[],
  deadline: number,
  runner: ProcessSupervisor["run"],
  candidates: Map<string, DockerPairResource>
): Promise<void> {
  let nextSource = 0
  const failures: Array<{ readonly error: unknown }> = []
  async function inventoryWorker(): Promise<void> {
    while (failures.length === 0) {
      const source = sources[nextSource]
      nextSource += 1
      if (source === undefined) return
      try {
        await inventoryDockerPairSource(root, source, deadline, runner, candidates)
      } catch (error) {
        failures.push(Object.freeze({ error }))
      }
    }
  }
  const concurrency = Math.min(DockerPairOwnerInventoryConcurrency, sources.length)
  await Promise.all(Array.from({ length: concurrency }, inventoryWorker))
  const firstFailure = failures[0]
  if (firstFailure !== undefined) throw firstFailure.error
}

async function inventoryDockerPairs(
  root: string,
  sources: readonly DockerPairInventorySource[],
  deadline: number,
  runner: ProcessSupervisor["run"]
): Promise<readonly DockerPairResource[]> {
  const candidates = new Map<string, DockerPairResource>()
  const invocationSource = sources[0]?.filter === "invocation" ? sources[0] : null
  if (invocationSource !== null) {
    await inventoryDockerPairSource(root, invocationSource, deadline, runner, candidates)
  }
  const ownerSources = invocationSource === null ? sources : sources.slice(1)
  await inventoryOwnerSources(root, ownerSources, deadline, runner, candidates)
  return Object.freeze(Array.from(candidates.values()))
}

interface ClassifiedResource {
  readonly resource: DockerPairResource
  readonly classification: DockerPairClassification
}

function classifyInventory(
  resources: readonly DockerPairResource[],
  invocation: string,
  registeredOwners: ReadonlySet<string>
): {
  readonly owned: readonly ClassifiedResource[]
  readonly collisions: readonly ClassifiedResource[]
} {
  const owned: ClassifiedResource[] = []
  const collisions: ClassifiedResource[] = []
  for (const resource of resources) {
    const classification = classifyDockerPairResource(resource, invocation, registeredOwners)
    if (classification.kind === "foreign") continue
    const classified = Object.freeze({ resource, classification })
    if (classification.kind === "owned") owned.push(classified)
    else collisions.push(classified)
  }
  function compare(left: ClassifiedResource, right: ClassifiedResource): number {
    const typeDifference =
      DockerResourceTypes.indexOf(left.resource.type) -
      DockerResourceTypes.indexOf(right.resource.type)
    return typeDifference === 0 ? left.resource.id.localeCompare(right.resource.id) : typeDifference
  }
  owned.sort(compare)
  collisions.sort(compare)
  return Object.freeze({ owned: Object.freeze(owned), collisions: Object.freeze(collisions) })
}

interface DockerPairRemovalCommand {
  readonly type: DockerResourceType
  readonly ids: readonly string[]
  readonly command: readonly string[]
}

function removalCommands(
  owned: readonly ClassifiedResource[]
): readonly DockerPairRemovalCommand[] {
  const ids = new Map<DockerResourceType, Set<string>>(
    DockerResourceTypes.map((type) => [type, new Set<string>()])
  )
  const volumePairs = new Map<string, { readonly owner: string; readonly invocation: string }>()
  for (const entry of owned) {
    ids.get(entry.resource.type)?.add(entry.resource.id)
    if (
      entry.resource.type === "volume" &&
      entry.resource.owner !== null &&
      entry.resource.invocation !== null
    ) {
      volumePairs.set(`${entry.resource.owner}\u0000${entry.resource.invocation}`, {
        owner: entry.resource.owner,
        invocation: entry.resource.invocation
      })
    }
  }
  const commands: DockerPairRemovalCommand[] = []
  for (const type of ["container", "network"] as const) {
    const resourceIds = Object.freeze(Array.from(ids.get(type) ?? []).sort())
    if (resourceIds.length === 0) continue
    const command =
      type === "container"
        ? ["docker", "container", "rm", "--force", ...resourceIds]
        : ["docker", "network", "rm", ...resourceIds]
    commands.push(Object.freeze({ type, ids: resourceIds, command: Object.freeze(command) }))
  }
  const volumeIds = Object.freeze(Array.from(ids.get("volume") ?? []).sort())
  for (const pair of Array.from(volumePairs.values()).sort((left, right) =>
    `${left.owner}\u0000${left.invocation}`.localeCompare(`${right.owner}\u0000${right.invocation}`)
  )) {
    const pairIds = Object.freeze(
      owned
        .filter(
          (entry) =>
            entry.resource.type === "volume" &&
            entry.resource.owner === pair.owner &&
            entry.resource.invocation === pair.invocation
        )
        .map((entry) => entry.resource.id)
        .sort()
    )
    commands.push(
      Object.freeze({
        type: "volume" as const,
        ids: pairIds.length === 0 ? volumeIds : pairIds,
        command: Object.freeze([
          "docker",
          "volume",
          "prune",
          "--all",
          "--force",
          "--filter",
          `label=${DockerOwnerLabelKey}=${pair.owner}`,
          "--filter",
          `label=${DockerInvocationLabelKey}=${pair.invocation}`
        ])
      })
    )
  }
  return Object.freeze(commands)
}

function classifiedResourceError(prefix: string, entry: ClassifiedResource): Error {
  const { resource, classification } = entry
  return new Error(
    `${prefix}: type=${resource.type} id=${resource.id} owner-label=${classification.owner} invocation-label=${classification.invocation} classification=${classification.kind}`
  )
}

function removalError(command: DockerPairRemovalCommand): Error {
  return new Error(
    `Docker pair removal failed: type=${command.type} id=${command.ids.join(",")} owner-label=registered invocation-label=current classification=owned`
  )
}

function recordClassified(
  target: Map<string, ClassifiedResource>,
  values: readonly ClassifiedResource[]
): void {
  for (const value of values) target.set(resourceKey(value.resource), value)
}

async function cleanupDockerPairs(
  root: string,
  invocation: string,
  owners: Iterable<string>,
  deadline: number,
  observedOwnedIsFailure: boolean,
  inventoryScope: "exact-owner" | "union",
  runner: ProcessSupervisor["run"]
): Promise<void> {
  const currentInvocation = validLabelValue(invocation, "invocation")
  const registeredOwners = registeredOwnerSet(owners)
  if (!Number.isFinite(deadline)) throw new Error("invalid Docker pair cleanup deadline")
  const registeredOwnerValues = Array.from(registeredOwners)
  if (inventoryScope === "exact-owner" && registeredOwnerValues.length !== 1) {
    throw new Error("normal Docker pair cleanup requires one registered owner")
  }
  const sources =
    inventoryScope === "exact-owner"
      ? [
          Object.freeze({
            filter: "owner" as const,
            commands: dockerOwnerInventoryCommands(registeredOwnerValues[0] ?? "")
          })
        ]
      : dockerPairInventorySources(currentInvocation, registeredOwners)

  const observedOwned = new Map<string, ClassifiedResource>()
  const observedCollisions = new Map<string, ClassifiedResource>()
  const remainingOwned = new Map<string, ClassifiedResource>()
  const cleanupFailures: Error[] = []
  let quietSince: number | null = null
  let finalInventoryOnly = false
  let finalInventoryRequired = false

  while (true) {
    const inventoryStartedAt = performance.now()
    let resources: readonly DockerPairResource[]
    try {
      resources = await inventoryDockerPairs(root, sources, deadline, runner)
    } catch (error) {
      if (
        observedOwned.size === 0 &&
        observedCollisions.size === 0 &&
        cleanupFailures.length === 0
      ) {
        throw error
      }
      cleanupFailures.push(
        new Error("Docker pair final inventory failed: classification=unavailable")
      )
      finalInventoryRequired = false
      break
    }
    const classified = classifyInventory(resources, currentInvocation, registeredOwners)
    recordClassified(observedOwned, classified.owned)
    recordClassified(observedCollisions, classified.collisions)
    if (finalInventoryOnly) {
      recordClassified(remainingOwned, classified.owned)
      finalInventoryRequired = false
      break
    }

    if (classified.owned.length > 0) {
      quietSince = null
      const failuresBeforeRemoval = cleanupFailures.length
      for (const command of removalCommands(classified.owned)) {
        try {
          const timeoutMs = commandTimeout(deadline, DockerPairRemovalTimeoutMs, "remove")
          await runDockerCommand(root, command.type, "remove", command.command, timeoutMs, runner)
        } catch {
          cleanupFailures.push(removalError(command))
        }
      }
      if (cleanupFailures.length > failuresBeforeRemoval) {
        finalInventoryOnly = true
        finalInventoryRequired = true
        continue
      }
      const sleepMs = Math.min(
        DockerPairPollMs,
        Math.max(1, Math.floor(deadline - performance.now()))
      )
      if (deadline - performance.now() < sleepMs) {
        cleanupFailures.push(
          new Error("Docker pair deadline exhausted: operation=poll classification=unavailable")
        )
        break
      }
      await Bun.sleep(sleepMs)
      continue
    }

    const now = performance.now()
    quietSince ??= now
    // A scan that began before the quiet boundary cannot serve as the final classification:
    // a later matching resource may become visible after that scan already queried its source.
    const quietElapsedBeforeInventory = Math.max(0, inventoryStartedAt - quietSince)
    const quietRemaining = DockerPairQuietMs - quietElapsedBeforeInventory
    if (quietRemaining <= 0) break
    const sleepMs = Math.min(DockerPairPollMs, Math.ceil(quietRemaining))
    if (deadline - performance.now() < sleepMs) {
      cleanupFailures.push(
        new Error(
          "Docker pair deadline exhausted: operation=quiet-window classification=unavailable"
        )
      )
      break
    }
    await Bun.sleep(sleepMs)
  }

  const failures: Error[] = []
  if (observedOwnedIsFailure) {
    for (const entry of observedOwned.values()) {
      failures.push(classifiedResourceError("Docker owned resource observed", entry))
    }
  }
  for (const entry of observedCollisions.values()) {
    failures.push(classifiedResourceError("Docker label collision observed", entry))
  }
  if (finalInventoryRequired) {
    failures.push(new Error("Docker pair final inventory unavailable: classification=unavailable"))
  }
  for (const entry of remainingOwned.values()) {
    failures.push(classifiedResourceError("Docker owned resource remains", entry))
  }
  failures.push(...cleanupFailures)
  if (failures.length > 0) throw new AggregateError(failures, "Docker pair cleanup failed")
}

/** Removes only the exact current-invocation/current-owner pair during normal worker cleanup. */
export async function cleanupDockerPair(
  root: string,
  invocation: string,
  owner: string,
  deadline: number,
  runner: ProcessSupervisor["run"] = runCommand
): Promise<void> {
  const validOwner = validLabelValue(owner, "owner")
  await cleanupDockerPairs(root, invocation, [validOwner], deadline, false, "exact-owner", runner)
}

/**
 * Performs the root registered-owner backstop. Any owned observation or collision fails even
 * when all authorized owned resources were removed successfully.
 */
export async function verifyDockerInvocationCleanup(
  root: string,
  invocation: string,
  registeredOwners: Iterable<string>,
  deadline: number,
  runner: ProcessSupervisor["run"] = runCommand
): Promise<void> {
  await cleanupDockerPairs(root, invocation, registeredOwners, deadline, true, "union", runner)
}
