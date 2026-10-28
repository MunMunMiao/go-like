import { expect, test } from "bun:test"

import {
  classifyDockerPairResource,
  cleanupDockerPair,
  dockerPairInventoryCommands,
  DockerInvocationLabelKey,
  DockerOwnerLabelKey,
  parseDockerPairInventoryOutput,
  verifyDockerInvocationCleanup,
  type DockerPairResource,
  type DockerResourceType
} from "../e2e/harness/docker-pairs"
import type { CommandDefinition, CommandResult, ProcessSupervisor } from "../e2e/harness/process"
import { failureRecord } from "../e2e/harness/result"

const Invocation = "invocation-current"
const Owner = "owner-registered"
const OtherOwner = "owner-other"
const ForeignInvocation = "invocation-foreign"
const RegisteredOwners = new Set([Owner])
const Format = `{{json .ID}}\t{{json (.Label "${DockerOwnerLabelKey}")}}\t{{json (.Label "${DockerInvocationLabelKey}")}}`

type Runner = ProcessSupervisor["run"]

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | null = null
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  if (resolvePromise === null) throw new Error("deferred resolver was not initialized")
  return Object.freeze({ promise, resolve: resolvePromise })
}

function result(stdout = "", overrides: Partial<CommandResult> = {}): CommandResult {
  return Object.freeze({
    exitCode: 0,
    signal: null,
    termination: "exit",
    timedOut: false,
    abortReason: null,
    durationMs: 1,
    stdout,
    stderr: "",
    cleanupFailures: Object.freeze([]),
    containment: "not-claimed",
    residual: "zero-observed",
    ...overrides
  })
}

function row(id: string, owner: string | null, invocation: string | null): string {
  return `${JSON.stringify(id)}\t${JSON.stringify(owner ?? "")}\t${JSON.stringify(invocation ?? "")}`
}

function resource(
  owner: string | null,
  invocation: string | null,
  type: DockerResourceType = "container",
  id = "resource-id"
): DockerPairResource {
  return Object.freeze({ type, id, owner, invocation })
}

function filterOf(definition: CommandDefinition): string | null {
  const index = definition.command.indexOf("--filter")
  return index < 0 ? null : (definition.command[index + 1] ?? null)
}

function typeOf(definition: CommandDefinition): DockerResourceType {
  if (definition.command[1] === "container") return "container"
  if (definition.command[1] === "network") return "network"
  return "volume"
}

function isList(definition: CommandDefinition): boolean {
  return definition.command.includes("ls")
}

function listRunner(
  records: Readonly<Record<string, readonly string[]>>,
  calls: CommandDefinition[]
): Runner {
  return async (_root: string, definition: CommandDefinition) => {
    calls.push(definition)
    if (!isList(definition)) return result()
    const key = `${typeOf(definition)}:${filterOf(definition) ?? ""}`
    return result((records[key] ?? []).join("\n"))
  }
}

async function captureFailure(action: () => Promise<void>): Promise<Error> {
  let failure: unknown = null
  try {
    await action()
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(Error)
  return failure as Error
}

function nestedMessages(error: Error): string[] {
  const messages = [error.message]
  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      if (nested instanceof Error) messages.push(...nestedMessages(nested))
    }
  }
  return messages
}

function removalCalls(calls: readonly CommandDefinition[]): readonly (readonly string[])[] {
  return calls.filter((definition) => !isList(definition)).map((definition) => definition.command)
}

test("pure Docker pair classifier proves owned, four collisions, and foreign", () => {
  expect(
    classifyDockerPairResource(resource(Owner, Invocation), Invocation, RegisteredOwners)
  ).toEqual({
    kind: "owned",
    owner: "registered",
    invocation: "current"
  })

  const collisions = [
    [OtherOwner, Invocation, "unknown", "current"],
    [null, Invocation, "missing", "current"],
    [Owner, ForeignInvocation, "registered", "foreign"],
    [Owner, null, "registered", "missing"]
  ] as const
  for (const [owner, invocation, ownerClass, invocationClass] of collisions) {
    expect(
      classifyDockerPairResource(resource(owner, invocation), Invocation, RegisteredOwners)
    ).toEqual({
      kind: "collision",
      owner: ownerClass,
      invocation: invocationClass
    })
  }

  expect(
    classifyDockerPairResource(
      resource(OtherOwner, ForeignInvocation),
      Invocation,
      RegisteredOwners
    )
  ).toEqual({ kind: "foreign", owner: "unknown", invocation: "foreign" })
})

test("metadata list commands form invocation and registered-owner union without inspect or logs", () => {
  const commands = dockerPairInventoryCommands(Invocation, [OtherOwner, Owner, Owner])
  expect(commands).toHaveLength(9)
  expect(commands.map((entry) => `${entry.filter}:${entry.type}`)).toEqual([
    "invocation:container",
    "invocation:network",
    "invocation:volume",
    "owner:container",
    "owner:network",
    "owner:volume",
    "owner:container",
    "owner:network",
    "owner:volume"
  ])
  const filters = commands.map((entry) =>
    filterOf({
      cwd: ".",
      command: entry.command,
      timeoutMs: 1
    })
  )
  expect(filters.slice(0, 3)).toEqual([
    `label=${DockerInvocationLabelKey}=${Invocation}`,
    `label=${DockerInvocationLabelKey}=${Invocation}`,
    `label=${DockerInvocationLabelKey}=${Invocation}`
  ])
  expect(filters.slice(3, 6)).toEqual([
    `label=${DockerOwnerLabelKey}=${OtherOwner}`,
    `label=${DockerOwnerLabelKey}=${OtherOwner}`,
    `label=${DockerOwnerLabelKey}=${OtherOwner}`
  ])
  expect(filters.slice(6)).toEqual([
    `label=${DockerOwnerLabelKey}=${Owner}`,
    `label=${DockerOwnerLabelKey}=${Owner}`,
    `label=${DockerOwnerLabelKey}=${Owner}`
  ])
  for (const entry of commands) {
    const text = entry.command.join(" ")
    expect(text).not.toContain("inspect")
    expect(text).not.toContain("logs")
    expect(text).not.toContain(" rm ")
    expect(entry.command.at(-1)).toBe(
      entry.type === "volume" ? Format.replace(".ID", ".Name") : Format
    )
    if (entry.type !== "volume") expect(entry.command).toContain("--no-trunc")
  }
})

test("root owner inventories are bounded, concurrent, complete, and type-serial", async () => {
  const owners = Array.from({ length: 12 }, (_, index) => `owner-${String(index).padStart(2, "0")}`)
  const ownerStarts = owners.map(() => deferred<void>())
  let releaseOwners = false
  let activeOwnerSources = 0
  let maximumActiveOwnerSources = 0
  const ownerTypes = new Map<string, DockerResourceType[]>()
  const runner: Runner = async (_root, definition) => {
    const filter = filterOf(definition)
    if (filter?.includes(DockerInvocationLabelKey) === true) return result()
    const owner = filter?.slice(filter.lastIndexOf("=") + 1)
    const ownerIndex = owner === undefined ? -1 : owners.indexOf(owner)
    if (owner === undefined || ownerIndex < 0) throw new Error("unexpected owner inventory query")
    const types = ownerTypes.get(owner) ?? []
    const type = typeOf(definition)
    types.push(type)
    ownerTypes.set(owner, types)
    if (type === "container") {
      activeOwnerSources += 1
      maximumActiveOwnerSources = Math.max(maximumActiveOwnerSources, activeOwnerSources)
      ownerStarts[ownerIndex]?.resolve()
      while (!releaseOwners) await Bun.sleep(1)
    }
    if (type === "volume") activeOwnerSources -= 1
    return result()
  }

  const verification = verifyDockerInvocationCleanup(
    "/repo",
    Invocation,
    owners,
    performance.now() + 20_000,
    runner
  )
  await Promise.all(ownerStarts.slice(0, 8).map((started) => started.promise))
  expect(maximumActiveOwnerSources).toBe(8)
  expect(ownerTypes.size).toBe(8)
  expect(owners.slice(8).every((owner) => !ownerTypes.has(owner))).toBe(true)
  releaseOwners = true
  await verification

  expect(maximumActiveOwnerSources).toBe(8)
  expect(activeOwnerSources).toBe(0)
  expect(ownerTypes.size).toBe(owners.length)
  for (const owner of owners) {
    const types = ownerTypes.get(owner) ?? []
    expect(types.length).toBeGreaterThanOrEqual(3)
    expect(types.length % 3).toBe(0)
    for (let index = 0; index < types.length; index += 3) {
      expect(types.slice(index, index + 3)).toEqual(["container", "network", "volume"])
    }
  }
})

test("quiet window ends only after a complete inventory starts beyond its boundary", async () => {
  let invocationContainerCalls = 0
  let delayedOwnerSource = false
  let collisionVisible = false
  const collision = row("late-current-collision", OtherOwner, Invocation)
  const runner: Runner = async (_root, definition) => {
    if (!isList(definition)) return result()
    const invocationFilter = filterOf(definition)?.includes(DockerInvocationLabelKey) === true
    if (invocationFilter && typeOf(definition) === "container") {
      invocationContainerCalls += 1
      return result(collisionVisible ? collision : "")
    }
    if (!invocationFilter && typeOf(definition) === "container" && invocationContainerCalls === 2) {
      delayedOwnerSource = true
      await Bun.sleep(2_100)
      collisionVisible = true
    }
    return result()
  }

  const failure = await captureFailure(() =>
    verifyDockerInvocationCleanup("/repo", Invocation, [Owner], performance.now() + 10_000, runner)
  )
  expect(delayedOwnerSource).toBe(true)
  expect(invocationContainerCalls).toBe(3)
  expect(nestedMessages(failure).join("\n")).toContain(
    "id=late-current-collision owner-label=unknown invocation-label=current classification=collision"
  )
})

test("root inventory still queries every source after concurrent duplicate observations", async () => {
  const owners = Array.from({ length: 12 }, (_, index) => `owner-${String(index).padStart(2, "0")}`)
  const calls: CommandDefinition[] = []
  const shared = row("shared-resource", owners[0] ?? null, Invocation)
  let present = true
  const runner: Runner = async (_root, definition) => {
    calls.push(definition)
    if (!isList(definition)) {
      present = false
      return result()
    }
    return result(present && typeOf(definition) === "container" ? shared : "")
  }
  const failure = await captureFailure(() =>
    verifyDockerInvocationCleanup("/repo", Invocation, owners, performance.now() + 20_000, runner)
  )

  const firstInventory = calls.slice(0, (owners.length + 1) * 3)
  expect(firstInventory).toHaveLength(39)
  expect(new Set(firstInventory.map(filterOf))).toEqual(
    new Set([
      `label=${DockerInvocationLabelKey}=${Invocation}`,
      ...owners.map((owner) => `label=${DockerOwnerLabelKey}=${owner}`)
    ])
  )
  expect(removalCalls(calls)).toEqual([["docker", "container", "rm", "--force", "shared-resource"]])
  expect(
    nestedMessages(failure).filter((message) => message.includes("id=shared-resource"))
  ).toHaveLength(1)
})

test("bounded parser returns only immutable identity and exact pair labels", () => {
  expect(
    parseDockerPairInventoryOutput(
      "container",
      `${row("full-container-id", Owner, Invocation)}\r\n${row("missing-owner", null, Invocation)}\r\n`
    )
  ).toEqual([
    { type: "container", id: "full-container-id", owner: Owner, invocation: Invocation },
    { type: "container", id: "missing-owner", owner: null, invocation: Invocation }
  ])
  expect(() => parseDockerPairInventoryOutput("network", `${"x".repeat(256 * 1024)}x`)).toThrow(
    "type=network classification=unparseable"
  )
  expect(() => parseDockerPairInventoryOutput("volume", "raw unstructured output")).toThrow(
    "type=volume classification=unparseable"
  )
  expect(() =>
    parseDockerPairInventoryOutput("container", row("safe-id", "unsafe owner", Invocation))
  ).toThrow("type=container classification=unparseable")
})

test("root inventory unions queries, dedupes candidates, and removes each owned ID once", async () => {
  const calls: CommandDefinition[] = []
  const invocationFilter = `label=${DockerInvocationLabelKey}=${Invocation}`
  const ownerFilter = `label=${DockerOwnerLabelKey}=${Owner}`
  let present = true
  const records: Readonly<Record<string, readonly string[]>> = {
    [`container:${invocationFilter}`]: [row("owned-container", Owner, Invocation)],
    [`container:${ownerFilter}`]: [row("owned-container", Owner, Invocation)]
  }
  const runner: Runner = async (_root, definition) => {
    calls.push(definition)
    if (!isList(definition)) {
      present = false
      return result()
    }
    const key = `${typeOf(definition)}:${filterOf(definition) ?? ""}`
    return result(present ? (records[key] ?? []).join("\n") : "")
  }
  const failure = await captureFailure(() =>
    verifyDockerInvocationCleanup(
      "/repo",
      Invocation,
      [Owner, Owner],
      performance.now() + 20_000,
      runner
    )
  )

  expect(removalCalls(calls)).toEqual([["docker", "container", "rm", "--force", "owned-container"]])
  const firstInventory = calls.slice(0, 6)
  expect(firstInventory.map(filterOf)).toEqual([
    invocationFilter,
    invocationFilter,
    invocationFilter,
    ownerFilter,
    ownerFilter,
    ownerFilter
  ])
  expect(nestedMessages(failure)).toContain(
    "Docker owned resource observed: type=container id=owned-container owner-label=registered invocation-label=current classification=owned"
  )
})

test("four collision classes fail and remain untouched", async () => {
  const calls: CommandDefinition[] = []
  const invocationCollisions = [
    row("same-invocation-unknown-owner", OtherOwner, Invocation),
    row("same-invocation-missing-owner", null, Invocation)
  ]
  const ownerCollisions = [
    row("registered-owner-foreign-invocation", Owner, ForeignInvocation),
    row("registered-owner-missing-invocation", Owner, null)
  ]
  const records = {
    [`container:label=${DockerInvocationLabelKey}=${Invocation}`]: invocationCollisions,
    [`container:label=${DockerOwnerLabelKey}=${Owner}`]: ownerCollisions
  }
  const failure = await captureFailure(() =>
    verifyDockerInvocationCleanup(
      "/repo",
      Invocation,
      [Owner],
      performance.now() + 10_000,
      listRunner(records, calls)
    )
  )
  expect(removalCalls(calls)).toEqual([])
  expect(calls.some((definition) => definition.command.includes("inspect"))).toBe(false)
  expect(calls.some((definition) => definition.command.includes("logs"))).toBe(false)
  const messages = nestedMessages(failure).join("\n")
  for (const id of [
    "same-invocation-unknown-owner",
    "same-invocation-missing-owner",
    "registered-owner-foreign-invocation",
    "registered-owner-missing-invocation"
  ]) {
    expect(messages).toContain(`id=${id}`)
  }
  expect(messages.match(/classification=collision/gu)).toHaveLength(4)
})

test("foreign candidates are ignored without inspect, logs, or removal", async () => {
  const calls: CommandDefinition[] = []
  const foreign = row("foreign-resource", OtherOwner, ForeignInvocation)
  const records = {
    [`network:label=${DockerInvocationLabelKey}=${Invocation}`]: [foreign],
    [`network:label=${DockerOwnerLabelKey}=${Owner}`]: [foreign]
  }
  await verifyDockerInvocationCleanup(
    "/repo",
    Invocation,
    [Owner],
    performance.now() + 10_000,
    listRunner(records, calls)
  )
  expect(removalCalls(calls)).toEqual([])
  expect(calls.some((definition) => definition.command.includes("inspect"))).toBe(false)
  expect(calls.some((definition) => definition.command.includes("logs"))).toBe(false)
})

test("normal exact-pair cleanup removes owned resources without leak failure", async () => {
  const calls: CommandDefinition[] = []
  let firstInventory = true
  const runner: Runner = async (_root, definition) => {
    calls.push(definition)
    if (!isList(definition)) return result()
    if (!firstInventory) return result()
    if (typeOf(definition) === "volume") firstInventory = false
    return result(row(`owned-${typeOf(definition)}`, Owner, Invocation))
  }

  await cleanupDockerPair("/repo", Invocation, Owner, performance.now() + 10_000, runner)
  expect(calls.filter(isList).slice(0, 3).map(filterOf)).toEqual([
    `label=${DockerOwnerLabelKey}=${Owner}`,
    `label=${DockerOwnerLabelKey}=${Owner}`,
    `label=${DockerOwnerLabelKey}=${Owner}`
  ])
  expect(removalCalls(calls)).toEqual([
    ["docker", "container", "rm", "--force", "owned-container"],
    ["docker", "network", "rm", "owned-network"],
    [
      "docker",
      "volume",
      "prune",
      "--all",
      "--force",
      "--filter",
      `label=${DockerOwnerLabelKey}=${Owner}`,
      "--filter",
      `label=${DockerInvocationLabelKey}=${Invocation}`
    ]
  ])
})

test("volume cleanup is daemon-filtered by the exact label pair instead of a reusable name", async () => {
  const calls: CommandDefinition[] = []
  let replaced = false
  const runner: Runner = async (_root, definition) => {
    calls.push(definition)
    if (!isList(definition)) {
      expect(definition.command).not.toContain("owned-volume")
      expect(definition.command).toContain(`label=${DockerOwnerLabelKey}=${Owner}`)
      expect(definition.command).toContain(`label=${DockerInvocationLabelKey}=${Invocation}`)
      replaced = true
      return result()
    }
    if (typeOf(definition) !== "volume") return result()
    if (!replaced) return result(row("owned-volume", Owner, Invocation))
    return result(row("owned-volume", OtherOwner, ForeignInvocation))
  }

  await cleanupDockerPair("/repo", Invocation, Owner, performance.now() + 10_000, runner)
  expect(removalCalls(calls)).toEqual([
    [
      "docker",
      "volume",
      "prune",
      "--all",
      "--force",
      "--filter",
      `label=${DockerOwnerLabelKey}=${Owner}`,
      "--filter",
      `label=${DockerInvocationLabelKey}=${Invocation}`
    ]
  ])
})

test("root backstop removes in container-network-volume order and still fails observed leaks", async () => {
  const calls: CommandDefinition[] = []
  let firstInventory = true
  const runner: Runner = async (_root, definition) => {
    calls.push(definition)
    if (!isList(definition)) return result()
    const invocationQuery = filterOf(definition)?.includes(DockerInvocationLabelKey) === true
    if (!firstInventory || !invocationQuery) return result()
    if (typeOf(definition) === "volume") firstInventory = false
    return result(row(`leaked-${typeOf(definition)}`, Owner, Invocation))
  }
  const failure = await captureFailure(() =>
    verifyDockerInvocationCleanup("/repo", Invocation, [Owner], performance.now() + 10_000, runner)
  )

  expect(removalCalls(calls)).toEqual([
    ["docker", "container", "rm", "--force", "leaked-container"],
    ["docker", "network", "rm", "leaked-network"],
    [
      "docker",
      "volume",
      "prune",
      "--all",
      "--force",
      "--filter",
      `label=${DockerOwnerLabelKey}=${Owner}`,
      "--filter",
      `label=${DockerInvocationLabelKey}=${Invocation}`
    ]
  ])
  const messages = nestedMessages(failure).join("\n")
  expect(messages).toContain("type=container id=leaked-container")
  expect(messages).toContain("type=network id=leaked-network")
  expect(messages).toContain("type=volume id=leaked-volume")
})

test("empty root owner registration still inventories invocation collisions", async () => {
  const calls: CommandDefinition[] = []
  const records = {
    [`container:label=${DockerInvocationLabelKey}=${Invocation}`]: [
      row("unknown-owner-collision", OtherOwner, Invocation)
    ]
  }
  const failure = await captureFailure(() =>
    verifyDockerInvocationCleanup(
      "/repo",
      Invocation,
      [],
      performance.now() + 10_000,
      listRunner(records, calls)
    )
  )
  expect(
    calls.every((definition) => filterOf(definition)?.includes(DockerInvocationLabelKey))
  ).toBe(true)
  expect(removalCalls(calls)).toEqual([])
  expect(nestedMessages(failure).join("\n")).toContain(
    "id=unknown-owner-collision owner-label=unknown invocation-label=current classification=collision"
  )
})

test("normal cleanup ignores sibling owners outside its exact-owner inventory", async () => {
  const calls: CommandDefinition[] = []
  const runner: Runner = async (_root, definition) => {
    calls.push(definition)
    if (calls.length === 4) await Bun.sleep(2_100)
    return result()
  }
  await cleanupDockerPair("/repo", Invocation, Owner, performance.now() + 10_000, runner)
  expect(calls).toHaveLength(9)
  expect(calls.some((definition) => filterOf(definition)?.includes(DockerInvocationLabelKey))).toBe(
    false
  )
  expect(calls.every((definition) => filterOf(definition)?.endsWith(`=${Owner}`))).toBe(true)
})

test("normal cleanup reports a safe owned residual after removal failure", async () => {
  const calls: CommandDefinition[] = []
  const owned = row("stuck-container", Owner, Invocation)
  const runner: Runner = async (_root, definition) => {
    calls.push(definition)
    if (isList(definition)) {
      return result(typeOf(definition) === "container" ? owned : "")
    }
    return result("raw-remove-stdout", { exitCode: 23, stderr: "raw-remove-stderr" })
  }
  const failure = await captureFailure(() =>
    cleanupDockerPair("/repo", Invocation, Owner, performance.now() + 10_000, runner)
  )
  const messages = nestedMessages(failure).join("\n")
  expect(messages).toContain(
    "Docker owned resource remains: type=container id=stuck-container owner-label=registered invocation-label=current classification=owned"
  )
  expect(messages).toContain(
    "Docker pair removal failed: type=container id=stuck-container owner-label=registered invocation-label=current classification=owned"
  )
  expect(messages).not.toContain("raw-remove-stdout")
  expect(messages).not.toContain("raw-remove-stderr")
})

test("metadata inventory rejects exit-zero process cleanup failures and residuals", async () => {
  const unsafeResults = [
    {
      cleanupFailures: Object.freeze([
        failureRecord("process-residual-present", "process-cleanup", "sensitive cleanup evidence")
      ])
    },
    { residual: "present" as const },
    { residual: "inconclusive" as const }
  ] as const

  for (const overrides of unsafeResults) {
    let runs = 0
    const runner: Runner = async () => {
      runs += 1
      return result("sensitive metadata output", overrides)
    }
    const failure = await captureFailure(() =>
      verifyDockerInvocationCleanup(
        "/repo",
        Invocation,
        [Owner],
        performance.now() + 10_000,
        runner
      )
    )
    expect(failure.message).toBe(
      "Docker pair command failed: type=container operation=metadata-list classification=unavailable"
    )
    expect(failure.message).not.toContain("sensitive")
    expect(runs).toBe(1)
  }
})

test("removal rejects exit-zero process cleanup failures and residuals", async () => {
  const unsafeResults = [
    {
      cleanupFailures: Object.freeze([
        failureRecord("process-residual-present", "process-cleanup", "sensitive cleanup evidence")
      ])
    },
    { residual: "present" as const },
    { residual: "inconclusive" as const }
  ] as const

  for (const overrides of unsafeResults) {
    let removalRuns = 0
    const owned = row("stuck-container", Owner, Invocation)
    const runner: Runner = async (_root, definition) => {
      if (isList(definition)) {
        return result(typeOf(definition) === "container" ? owned : "")
      }
      removalRuns += 1
      return result("sensitive remove output", overrides)
    }
    const failure = await captureFailure(() =>
      cleanupDockerPair("/repo", Invocation, Owner, performance.now() + 10_000, runner)
    )
    const messages = nestedMessages(failure).join("\n")
    expect(messages).toContain(
      "Docker pair removal failed: type=container id=stuck-container owner-label=registered invocation-label=current classification=owned"
    )
    expect(messages).toContain(
      "Docker owned resource remains: type=container id=stuck-container owner-label=registered invocation-label=current classification=owned"
    )
    expect(messages).not.toContain("sensitive")
    expect(removalRuns).toBe(1)
  }
})

test("unsafe owner and invocation labels fail before runner execution", async () => {
  for (const [invocation, owners] of [
    ["unsafe invocation", [Owner]],
    [Invocation, ["--filter=all"]],
    [Invocation, [""]]
  ] as const) {
    let runs = 0
    const runner: Runner = async () => {
      runs += 1
      return result()
    }
    await expect(
      verifyDockerInvocationCleanup("/repo", invocation, owners, performance.now() + 10_000, runner)
    ).rejects.toThrow("invalid Docker")
    expect(runs).toBe(0)
  }
})

test("runner failures expose only safe type/operation classification", async () => {
  const secret = "raw-stdout-secret"
  const rawArgv = "raw-argv-secret"
  const thrownRunner: Runner = async (_root, definition) => {
    throw new Error(`${secret} ${rawArgv} ${definition.command.join(" ")}`)
  }
  const thrownFailure = await captureFailure(() =>
    verifyDockerInvocationCleanup(
      "/repo",
      Invocation,
      [Owner],
      performance.now() + 10_000,
      thrownRunner
    )
  )
  expect(thrownFailure.message).toBe(
    "Docker pair command failed: type=container operation=metadata-list classification=unavailable"
  )
  expect(thrownFailure.message).not.toContain(secret)
  expect(thrownFailure.message).not.toContain(rawArgv)
  expect(thrownFailure.message).not.toContain("--filter")

  const failedResultRunner: Runner = async () => result(secret, { exitCode: 23, stderr: rawArgv })
  const resultFailure = await captureFailure(() =>
    verifyDockerInvocationCleanup(
      "/repo",
      Invocation,
      [Owner],
      performance.now() + 10_000,
      failedResultRunner
    )
  )
  expect(resultFailure.message).toBe(
    "Docker pair command failed: type=container operation=metadata-list classification=unavailable"
  )
  expect(resultFailure.message).not.toContain(secret)
  expect(resultFailure.message).not.toContain(rawArgv)
})
