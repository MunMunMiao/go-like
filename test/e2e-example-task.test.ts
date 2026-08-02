import { expect, test } from "bun:test"
import { chmod, mkdir, readdir, rename, symlink, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"

import {
  runExampleTask,
  type ExampleTaskChild,
  type ExampleTaskChildResult,
  type ExampleTaskClock,
  type ExampleTaskOptions,
  type ExampleTaskSpawnOptions
} from "../e2e/example-task"
import {
  digestDockerEnvironment,
  snapshotDockerEnvironment
} from "../e2e/harness/docker-environment"
import {
  closeDurableJsonDirectory,
  openDurableJsonDirectory,
  writeDurableJson
} from "../e2e/harness/durable-json"
import {
  createGracefulControl,
  createRegistrationAck,
  digestInvocationCapability,
  digestInvocationNonce,
  type AuthenticatedControlBinding,
  type ExampleResult,
  type ResourceEvent,
  type InvocationCapability,
  type ProcessIdentity,
  type RegistrationAck
} from "../e2e/harness/example-protocol"
import {
  OwnedDockerEnvironmentKey,
  type ScenarioDockerAuthority
} from "../e2e/harness/owned-docker"
import {
  createTempDirectory,
  createTempSubdirectories,
  removeTempDirectory,
  type TempDirectory
} from "../e2e/harness/temp"

const Posix = process.platform !== "win32"
const Id = "example-task-fixture"
const PackageName = `@likego/example-${Id}`
const Invocation = "example-task-invocation"
const Owner = "example-task-fixture-owner"
const Nonce = "12".repeat(32)
const WrongNonce = "34".repeat(32)
const RootPid = 4_101
const RootStartIdentity = "synthetic:root:1"
const WorkerStartIdentity = "synthetic:worker:1"
const Principal = typeof process.getuid === "function" ? `uid:${process.getuid()}` : "uid:501"
const StartedAt = "2026-07-31T08:00:00.000Z"
const ScenarioArgv = Object.freeze(["bun", "scenario.ts", "--flag", "safe"])
const FixtureWaitTimeoutMs = 10_000

interface Fixture {
  readonly temp: TempDirectory
  readonly root: string
  readonly cwd: string
  readonly capabilityPath: string
  readonly paths: Readonly<Record<string, string>>
  readonly capability: InvocationCapability
  readonly frame: readonly string[]
}

interface SpawnRecord {
  readonly argv: readonly string[]
  readonly options: ExampleTaskSpawnOptions
}

interface SpawnHarness {
  readonly records: SpawnRecord[]
  readonly child: ExampleTaskChild
  readonly settle: (result?: Partial<ExampleTaskChildResult>) => void
  readonly kills: string[]
}

interface AckController {
  readonly requestId: Promise<string>
  readonly acknowledge: (value?: RegistrationAck) => Promise<RegistrationAck>
  readonly binding: (requestId: string) => AuthenticatedControlBinding
}

function identity(pid: number, startIdentity: string, principal = Principal): ProcessIdentity {
  return Object.freeze({ pid, ppid: 1, pgid: pid, startIdentity, principal })
}

function rootIdentity(capability: InvocationCapability): ProcessIdentity {
  return identity(capability.rootPid, capability.rootStartIdentity, capability.rootPrincipal)
}

function workerIdentity(): ProcessIdentity {
  return identity(process.pid, WorkerStartIdentity)
}

function stream(...chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller): void {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    }
  })
}

function childResult(overrides: Partial<ExampleTaskChildResult> = {}): ExampleTaskChildResult {
  return Object.freeze({
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    abortReason: null,
    durationMs: 7,
    cleanupFailures: Object.freeze([]),
    ...overrides
  })
}

function spawnHarness(
  stdout: ReadableStream<Uint8Array> | null = stream("safe stdout\n"),
  stderr: ReadableStream<Uint8Array> | null = stream("safe stderr\n")
): SpawnHarness {
  const records: SpawnRecord[] = []
  const kills: string[] = []
  const settlement = Promise.withResolvers<ExampleTaskChildResult>()
  return Object.freeze({
    records,
    kills,
    child: Object.freeze({
      stdout,
      stderr,
      settled: settlement.promise,
      kill(signal: "SIGTERM"): void {
        kills.push(signal)
      }
    }),
    settle(result: Partial<ExampleTaskChildResult> = {}): void {
      settlement.resolve(childResult(result))
    }
  })
}

async function fixture(): Promise<Fixture> {
  const temp = await createTempDirectory("likego-example-task-")
  const created = await createTempSubdirectories(temp, [
    ["invocation"],
    ["invocation", "participants"],
    ["invocation", "registrations"],
    ["invocation", "acks"],
    ["invocation", "results"],
    ["invocation", "graceful"],
    ["invocation", "resources"],
    ["packages"],
    ["packages", Id]
  ])
  const [root, participants, registrations, acks, results, graceful, resources, , cwd] = created
  if (
    root === undefined ||
    participants === undefined ||
    registrations === undefined ||
    acks === undefined ||
    results === undefined ||
    graceful === undefined ||
    resources === undefined ||
    cwd === undefined
  ) {
    throw new Error("example task fixture directories were not created")
  }
  const capabilityPath = join(root, "capability.json")
  const capability: InvocationCapability = Object.freeze({
    schemaVersion: 1,
    invocation: Invocation,
    nonceDigest: digestInvocationNonce(Nonce),
    rootPid: RootPid,
    rootStartIdentity: RootStartIdentity,
    rootPrincipal: Principal,
    resultDirRealpath: root,
    dockerEnvironmentDigest: digestDockerEnvironment(snapshotDockerEnvironment()),
    resourceEventTestHook: "none",
    dockerDiagnosticsPolicy: "metadata-only",
    allowedExamples: Object.freeze([
      Object.freeze({
        id: Id,
        packageName: PackageName,
        cwdRealpath: cwd,
        childOwner: Owner
      })
    ])
  })
  await writeFile(capabilityPath, `${JSON.stringify(capability)}\n`, {
    mode: 0o600
  })
  await writeFile(join(cwd, "package.json"), `${JSON.stringify({ name: PackageName })}\n`, {
    mode: 0o600
  })
  return Object.freeze({
    temp,
    root,
    cwd,
    capabilityPath,
    paths: Object.freeze({
      participants,
      registrations,
      acks,
      results,
      graceful,
      resources
    }),
    capability,
    frame: Object.freeze([...ScenarioArgv, "--worker", capabilityPath, Nonce])
  })
}

async function cleanup(selected: Fixture): Promise<void> {
  await removeTempDirectory(selected.temp)
}

function baseOptions(selected: Fixture, spawned: SpawnHarness): ExampleTaskOptions {
  return Object.freeze({
    spawn(argv: readonly string[], options: ExampleTaskSpawnOptions): ExampleTaskChild {
      spawned.records.push(Object.freeze({ argv: Object.freeze(argv.slice()), options }))
      return spawned.child
    },
    currentIdentity: async () => workerIdentity(),
    assertRootIdentity: async () => rootIdentity(selected.capability),
    readPackageName: async () => PackageName,
    pollIntervalMs: 2,
    registrationTimeoutMs: FixtureWaitTimeoutMs,
    gracefulPollTimeoutMs: 60_000,
    cleanupTimeoutMs: FixtureWaitTimeoutMs,
    cleanupDocker: async () => {},
    forwardStdout: () => {},
    forwardStderr: () => {}
  })
}

async function waitForFixture(
  label: string,
  ready: () => boolean | Promise<boolean>
): Promise<void> {
  const deadline = performance.now() + FixtureWaitTimeoutMs
  while (performance.now() < deadline) {
    if (await ready()) return
    await Bun.sleep(2)
  }
  throw new Error(`${label} did not occur within the fixture wait timeout`)
}

async function registrationRequest(selected: Fixture): Promise<string> {
  const path = join(selected.paths.registrations ?? "", `${Id}.json`)
  await waitForFixture(
    "registration request publication",
    async () => await Bun.file(path).exists()
  )
  const value = (await Bun.file(path).json()) as {
    readonly requestId?: unknown
  }
  if (typeof value.requestId === "string") return value.requestId
  throw new Error("fixture registration request is invalid")
}

async function publishControl(
  directory: string | undefined,
  component: string,
  value: unknown
): Promise<void> {
  if (directory === undefined) throw new Error("fixture control directory is unavailable")
  const durable = await openDurableJsonDirectory(directory)
  try {
    await writeDurableJson(durable, component, value, { readOnly: true })
  } finally {
    await closeDurableJsonDirectory(durable)
  }
}

function binding(selected: Fixture, requestId: string): AuthenticatedControlBinding {
  return Object.freeze({
    invocation: selected.capability.invocation,
    capabilityDigest: digestInvocationCapability(selected.capability),
    id: Id,
    workerPid: process.pid,
    workerStartIdentity: WorkerStartIdentity,
    childOwner: Owner,
    requestId
  })
}

function resourceEvent(
  selected: Fixture,
  overrides: Partial<ResourceEvent> = Object.freeze({})
): ResourceEvent {
  return Object.freeze({
    schemaVersion: 1,
    id: Id,
    resourceType: "container",
    resourceId: "a".repeat(64),
    invocation: selected.capability.invocation,
    childOwner: Owner,
    createdAt: StartedAt,
    ...overrides
  })
}

function ackController(selected: Fixture): AckController {
  const requestId = registrationRequest(selected)
  return Object.freeze({
    requestId,
    binding: (selectedRequestId: string) => binding(selected, selectedRequestId),
    async acknowledge(value?: RegistrationAck): Promise<RegistrationAck> {
      const selectedRequestId = await requestId
      const ack = value ?? createRegistrationAck(Nonce, binding(selected, selectedRequestId))
      await publishControl(selected.paths.acks, `${Id}.json`, ack)
      return ack
    }
  })
}

async function resultFile(selected: Fixture): Promise<ExampleResult> {
  return (await Bun.file(join(selected.paths.results ?? "", `${Id}.json`)).json()) as ExampleResult
}

async function expectNoSpawn(
  selected: Fixture,
  argv: readonly string[],
  overrides: ExampleTaskOptions = {}
): Promise<void> {
  let spawns = 0
  const task = runExampleTask(argv, selected.cwd, {
    ...baseOptions(selected, spawnHarness()),
    spawn(): ExampleTaskChild {
      spawns += 1
      throw new Error("spawn must not run")
    },
    registrationTimeoutMs: 20,
    ...overrides
  })
  await expect(task).rejects.toThrow()
  expect(spawns).toBe(0)
}

async function fileMode(path: string): Promise<number> {
  return (await Bun.file(path).stat()).mode & 0o777
}

test("invalid or partial worker frames fail closed and direct mode delegates local root", async () => {
  if (!Posix) return
  const selected = await fixture()
  try {
    await expectNoSpawn(selected, [...ScenarioArgv, "--worker"])
    await expectNoSpawn(selected, [...ScenarioArgv, "--worker", selected.capabilityPath])

    let delegated: unknown = null
    let spawns = 0
    const previousOwner = process.env.LIKEGO_E2E_OWNER
    const previousAuthority = process.env[OwnedDockerEnvironmentKey]
    process.env.LIKEGO_E2E_OWNER = "ambient-stale-owner"
    process.env[OwnedDockerEnvironmentKey] = "ambient-stale-authority"
    try {
      const delegatedOutcome = Object.freeze({ status: "passed" as const })
      const result = await runExampleTask(ScenarioArgv, selected.cwd, {
        runLocalRoot: async (input) => {
          delegated = input
          return delegatedOutcome
        },
        spawn(): ExampleTaskChild {
          spawns += 1
          throw new Error("direct wrapper must not spawn the scenario")
        }
      })
      expect(result).toBe(delegatedOutcome)
      expect(delegated).toEqual({
        cwd: selected.cwd,
        scenarioArgv: ScenarioArgv,
        signal: undefined
      })
      expect(spawns).toBe(0)
    } finally {
      if (previousOwner === undefined) delete process.env.LIKEGO_E2E_OWNER
      else process.env.LIKEGO_E2E_OWNER = previousOwner
      if (previousAuthority === undefined) delete process.env[OwnedDockerEnvironmentKey]
      else process.env[OwnedDockerEnvironmentKey] = previousAuthority
    }
  } finally {
    await cleanup(selected)
  }
})

test("capability, nonce, root, cwd, package, permission, and symlink failures never spawn", async () => {
  if (!Posix) return
  const mutations: readonly ((selected: Fixture) => Promise<{
    readonly argv?: readonly string[]
    readonly cwd?: string
    readonly options?: ExampleTaskOptions
  }>)[] = [
    async (selected) => {
      await writeFile(selected.capabilityPath, "{", { mode: 0o600 })
      return {}
    },
    async (selected) => ({
      argv: [...ScenarioArgv, "--worker", selected.capabilityPath, WrongNonce]
    }),
    async (selected) => ({
      options: {
        assertRootIdentity: async () => identity(RootPid, "synthetic:reused-root")
      }
    }),
    async (selected) => {
      const other = join(selected.temp.path, "packages")
      return { cwd: other }
    },
    async () => ({
      options: { readPackageName: async () => "@likego/example-foreign" }
    }),
    async (selected) => {
      await chmod(selected.capabilityPath, 0o640)
      return {}
    },
    async (selected) => {
      const target = `${selected.capabilityPath}.target`
      await writeFile(target, `${JSON.stringify(selected.capability)}\n`, {
        mode: 0o600
      })
      await Bun.file(selected.capabilityPath).delete()
      await symlink(target, selected.capabilityPath)
      return {}
    },
    async (selected) => {
      await chmod(selected.paths.acks ?? "", 0o750)
      return {}
    }
  ]

  for (const mutate of mutations) {
    const selected = await fixture()
    try {
      const changed = await mutate(selected)
      let spawns = 0
      await expect(
        runExampleTask(changed.argv ?? selected.frame, changed.cwd ?? selected.cwd, {
          ...baseOptions(selected, spawnHarness()),
          spawn(): ExampleTaskChild {
            spawns += 1
            throw new Error("spawn must not run")
          },
          registrationTimeoutMs: 20,
          ...changed.options
        })
      ).rejects.toThrow()
      expect(spawns).toBe(0)
    } finally {
      await chmod(selected.paths.acks ?? "", 0o700).catch(() => {})
      await chmod(selected.capabilityPath, 0o600).catch(() => {})
      await cleanup(selected)
    }
  }
})

test("participant is durable and readonly before ACK, and scenario starts only after ACK", async () => {
  if (!Posix) return
  const selected = await fixture()
  const spawned = spawnHarness()
  try {
    let participantCut = false
    const task = runExampleTask(selected.frame, selected.cwd, {
      ...baseOptions(selected, spawned),
      onParticipantPublished: async () => {
        participantCut = true
        const participantPath = join(selected.paths.participants ?? "", `${Id}.json`)
        expect(await Bun.file(participantPath).exists()).toBe(true)
        expect(await fileMode(participantPath)).toBe(0o400)
      }
    })
    const requestId = await registrationRequest(selected)
    expect(participantCut).toBe(true)
    expect(spawned.records).toHaveLength(0)
    await publishControl(
      selected.paths.acks,
      `${Id}.json`,
      createRegistrationAck(Nonce, binding(selected, requestId))
    )
    await waitForFixture("scenario spawn", () => spawned.records.length > 0)
    expect(spawned.records).toHaveLength(1)
    spawned.settle()
    expect((await task)?.status).toBe("passed")
  } finally {
    spawned.settle()
    await cleanup(selected)
  }
})

test("authenticated before-registration cut precedes durable registration and scenario spawn", async () => {
  if (!Posix) return
  const selected = await fixture()
  const spawned = spawnHarness()
  const capability = Object.freeze({
    ...selected.capability,
    resourceEventTestHook: "kill-worker-before-registration" as const
  })
  await writeFile(selected.capabilityPath, `${JSON.stringify(capability)}\n`, {
    mode: 0o600
  })
  const events: string[] = []
  try {
    const result = await runExampleTask(selected.frame, selected.cwd, {
      ...baseOptions(selected, spawned),
      assertRootIdentity: async () => rootIdentity(capability),
      beforeParticipantPublished: () => {
        events.push("before-participant")
      },
      killWorkerAtCutPoint: (cutPoint) => {
        events.push(`kill:${cutPoint}`)
        throw new Error("synthetic before-registration SIGKILL cut")
      }
    })
    expect(result.status).toBe("failed")
    expect(events).toEqual(["before-participant", "kill:before-registration"])
    expect(await readdir(selected.paths.participants ?? "")).toEqual([])
    expect(await readdir(selected.paths.registrations ?? "")).toEqual([])
    expect(await readdir(selected.paths.acks ?? "")).toEqual([])
    expect(spawned.records).toEqual([])
  } finally {
    spawned.settle()
    await cleanup(selected)
  }
})

test("authenticated after-ACK cut follows durable registration but precedes scenario spawn", async () => {
  if (!Posix) return
  const selected = await fixture()
  const spawned = spawnHarness()
  const capability = Object.freeze({
    ...selected.capability,
    resourceEventTestHook: "kill-worker-after-ack-before-scenario" as const
  })
  await writeFile(selected.capabilityPath, `${JSON.stringify(capability)}\n`, {
    mode: 0o600
  })
  const events: string[] = []
  try {
    const task = runExampleTask(selected.frame, selected.cwd, {
      ...baseOptions(selected, spawned),
      assertRootIdentity: async () => rootIdentity(capability),
      onParticipantPublished: () => {
        events.push("participant-published")
      },
      afterAckBeforeScenario: async () => {
        events.push("ack-verified")
        expect(await Bun.file(join(selected.paths.participants ?? "", `${Id}.json`)).exists()).toBe(
          true
        )
        expect(
          await Bun.file(join(selected.paths.registrations ?? "", `${Id}.json`)).exists()
        ).toBe(true)
        expect(await Bun.file(join(selected.paths.acks ?? "", `${Id}.json`)).exists()).toBe(true)
        expect(spawned.records).toEqual([])
      },
      killWorkerAtCutPoint: (cutPoint) => {
        events.push(`kill:${cutPoint}`)
        throw new Error("synthetic after-ACK SIGKILL cut")
      }
    })
    const requestId = await registrationRequest(selected)
    expect(events).toEqual(["participant-published"])
    expect(spawned.records).toEqual([])
    await publishControl(
      selected.paths.acks,
      `${Id}.json`,
      createRegistrationAck(Nonce, binding({ ...selected, capability }, requestId))
    )
    const result = await task
    expect(result.status).toBe("failed")
    expect(events).toEqual([
      "participant-published",
      "ack-verified",
      "kill:after-ack-before-scenario"
    ])
    expect(spawned.records).toEqual([])
  } finally {
    spawned.settle()
    await cleanup(selected)
  }
})

test("ACK-authenticated workers reject replaced control directories before scenario spawn", async () => {
  if (!Posix) return
  for (const name of ["results", "graceful"] as const) {
    const selected = await fixture()
    const original = selected.paths[name]
    if (original === undefined) throw new Error(`fixture ${name} directory is unavailable`)
    const moved = `${original}-moved`
    const victim = `${original}-victim`
    let swapped = false
    let spawns = 0
    try {
      await mkdir(victim, { mode: 0o700 })
      await writeFile(join(victim, "canary"), "preserve", { mode: 0o600 })
      const task = runExampleTask(selected.frame, selected.cwd, {
        ...baseOptions(selected, spawnHarness()),
        spawn(): ExampleTaskChild {
          spawns += 1
          throw new Error("spawn must not run")
        },
        afterAckBeforeScenario: async () => {
          await rename(original, moved)
          await symlink(victim, original, "dir")
          swapped = true
        }
      })
      await ackController(selected).acknowledge()
      let resolvedResult: unknown = null
      let rejected: unknown = null
      try {
        resolvedResult = await task
      } catch (error) {
        rejected = error
      }
      if (rejected === null) {
        throw new Error(
          `replaced control directory was accepted: name=${name} swapped=${String(swapped)} spawns=${spawns} result=${JSON.stringify(resolvedResult)}`
        )
      }
      expect(swapped).toBe(true)
      expect(rejected).toBeInstanceOf(Error)
      expect((rejected as Error).message).toContain("worker result unavailable")
      expect(spawns).toBe(0)
      expect(await Bun.file(join(victim, "canary")).text()).toBe("preserve")
      expect(await readdir(victim)).toEqual(["canary"])
    } finally {
      if (swapped) {
        await unlink(original).catch(() => {})
        await rename(moved, original).catch(() => {})
      }
      await cleanup(selected)
    }
  }
})

test("ACK mismatches and replayed request IDs fail before spawn", async () => {
  if (!Posix) return
  for (const makeAck of [
    (selected: Fixture, requestId: string): RegistrationAck => ({
      ...createRegistrationAck(Nonce, binding(selected, requestId)),
      ackToken: "ff".repeat(32)
    }),
    (selected: Fixture, requestId: string): RegistrationAck =>
      createRegistrationAck(Nonce, binding(selected, `${requestId}-replayed`))
  ]) {
    const selected = await fixture()
    try {
      let spawns = 0
      const task = runExampleTask(selected.frame, selected.cwd, {
        ...baseOptions(selected, spawnHarness()),
        spawn(): ExampleTaskChild {
          spawns += 1
          throw new Error("spawn must not run")
        }
      })
      const requestId = await registrationRequest(selected)
      await publishControl(selected.paths.acks, `${Id}.json`, makeAck(selected, requestId))
      const result = await task
      expect(result?.status).toBe("failed")
      expect(spawns).toBe(0)
    } finally {
      await cleanup(selected)
    }
  }
})

test("result publication completes before the wrapper command settles", async () => {
  if (!Posix) return
  const selected = await fixture()
  const spawned = spawnHarness()
  try {
    const task = runExampleTask(selected.frame, selected.cwd, baseOptions(selected, spawned))
    await ackController(selected).acknowledge()
    await waitForFixture("scenario spawn", () => spawned.records.length > 0)
    spawned.settle()
    const resultPath = join(selected.paths.results ?? "", `${Id}.json`)
    await waitForFixture(
      "readonly result publication",
      async () => (await Bun.file(resultPath).exists()) && (await fileMode(resultPath)) === 0o400
    )
    expect(await Bun.file(resultPath).exists()).toBe(true)
    expect(await fileMode(resultPath)).toBe(0o400)
    expect((await task)?.status).toBe("passed")
  } finally {
    spawned.settle()
    await cleanup(selected)
  }
})

test("authenticated graceful control is forwarded exactly once despite duplicate observation", async () => {
  if (!Posix) return
  const selected = await fixture()
  const spawned = spawnHarness()
  try {
    const task = runExampleTask(selected.frame, selected.cwd, baseOptions(selected, spawned))
    const controller = ackController(selected)
    const ack = await controller.acknowledge()
    await waitForFixture("scenario spawn", () => spawned.records.length > 0)
    const requestId = "graceful-request-1"
    await publishControl(
      selected.paths.graceful,
      `${Id}.json`,
      createGracefulControl(Nonce, binding(selected, requestId))
    )
    await waitForFixture("graceful scenario signal", () => spawned.kills.length > 0)
    await Bun.sleep(20)
    expect(spawned.kills).toEqual(["SIGTERM"])
    expect(requestId).not.toBe(ack.requestId)
    spawned.settle({ exitCode: null, signal: "SIGTERM" })
    expect((await task)?.status).toBe("failed")
    expect(spawned.kills).toEqual(["SIGTERM"])
  } finally {
    spawned.settle()
    await cleanup(selected)
  }
})

test("worker injects only signed authority, uses detached false, and cleans exact pair after resource event", async () => {
  if (!Posix) return
  const selected = await fixture()
  const spawned = spawnHarness()
  const cleanupCalls: unknown[][] = []
  const previousOwner = process.env.LIKEGO_E2E_OWNER
  const previousCapability = process.env.LIKEGO_E2E_CAPABILITY
  const previousStale = process.env.LIKEGO_E2E_OWNED_DOCKER_STALE
  process.env.LIKEGO_E2E_OWNER = "legacy-owner"
  process.env.LIKEGO_E2E_CAPABILITY = "stale-capability"
  process.env.LIKEGO_E2E_OWNED_DOCKER_STALE = "stale-owned-capability"
  try {
    const task = runExampleTask(selected.frame, selected.cwd, {
      ...baseOptions(selected, spawned),
      cleanupDocker: async (...values) => {
        cleanupCalls.push(values)
      }
    })
    await ackController(selected).acknowledge()
    await waitForFixture("scenario spawn", () => spawned.records.length > 0)
    const record = spawned.records[0]
    expect(record?.argv).toEqual(ScenarioArgv)
    expect(record?.options.cwd).toBe(selected.cwd)
    expect(record?.options.detached).toBe(false)
    expect(record?.options.env.LIKEGO_E2E_OWNER).toBeUndefined()
    expect(record?.options.env.LIKEGO_E2E_CAPABILITY).toBeUndefined()
    expect(record?.options.env.LIKEGO_E2E_OWNED_DOCKER_STALE).toBeUndefined()
    const encoded = record?.options.env[OwnedDockerEnvironmentKey]
    expect(encoded).toBeString()
    const authority = JSON.parse(encoded ?? "null") as ScenarioDockerAuthority
    expect(authority.registrationAck.childOwner).toBe(Owner)
    expect(authority.capabilityPath).toBe(selected.capabilityPath)
    expect(encoded?.length ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(4_096)
    await publishControl(selected.paths.resources, "resource-fixture.json", resourceEvent(selected))
    spawned.settle()
    expect((await task)?.status).toBe("passed")
    expect(cleanupCalls).toHaveLength(1)
    expect(cleanupCalls[0]?.slice(0, 3)).toEqual([selected.cwd, Invocation, Owner])
  } finally {
    spawned.settle()
    if (previousOwner === undefined) delete process.env.LIKEGO_E2E_OWNER
    else process.env.LIKEGO_E2E_OWNER = previousOwner
    if (previousCapability === undefined) delete process.env.LIKEGO_E2E_CAPABILITY
    else process.env.LIKEGO_E2E_CAPABILITY = previousCapability
    if (previousStale === undefined) delete process.env.LIKEGO_E2E_OWNED_DOCKER_STALE
    else process.env.LIKEGO_E2E_OWNED_DOCKER_STALE = previousStale
    await cleanup(selected)
  }
})

test("authenticated first-resource hook kills the worker only after its own durable event", async () => {
  if (!Posix) return
  const selected = await fixture()
  const spawned = spawnHarness()
  const capability = Object.freeze({
    ...selected.capability,
    resourceEventTestHook: "kill-worker-after-first" as const
  })
  await writeFile(selected.capabilityPath, `${JSON.stringify(capability)}\n`, {
    mode: 0o600
  })
  let kills = 0
  try {
    const task = runExampleTask(selected.frame, selected.cwd, {
      ...baseOptions(selected, spawned),
      assertRootIdentity: async () => rootIdentity(capability),
      killWorkerAfterFirstResource: () => {
        kills += 1
        throw new Error("synthetic worker SIGKILL cut")
      }
    })
    const requestId = await registrationRequest(selected)
    await publishControl(
      selected.paths.acks,
      `${Id}.json`,
      createRegistrationAck(Nonce, binding({ ...selected, capability }, requestId))
    )
    await waitForFixture("scenario spawn", () => spawned.records.length > 0)
    expect(kills).toBe(0)
    await publishControl(
      selected.paths.resources,
      "resource-fixture.json",
      resourceEvent({ ...selected, capability })
    )
    await waitForFixture("authenticated first-resource crash hook", () => kills > 0)
    expect(kills).toBe(1)
    spawned.settle({ exitCode: null, signal: "SIGTERM" })
    expect((await task)?.status).toBe("failed")
  } finally {
    spawned.settle()
    await cleanup(selected)
  }
})

test("first-resource observer retries a canonical durable publication window", async () => {
  if (!Posix) return
  const selected = await fixture()
  const spawned = spawnHarness()
  const capability = Object.freeze({
    ...selected.capability,
    resourceEventTestHook: "kill-worker-after-first" as const
  })
  await writeFile(selected.capabilityPath, `${JSON.stringify(capability)}\n`, {
    mode: 0o600
  })
  const temporaryComponent = ".durable-123e4567-e89b-42d3-a456-426614174000.tmp"
  const temporaryPath = join(selected.paths.resources ?? "", temporaryComponent)
  await writeFile(temporaryPath, '{"publication":"in-progress"}\n', {
    flag: "wx",
    mode: 0o400
  })
  const pollingSleepSignals = new Set<AbortSignal>()
  const clock: ExampleTaskClock = Object.freeze({
    now: () => performance.now(),
    date: () => new Date(),
    sleep: async (milliseconds: number, signal?: AbortSignal) => {
      if (signal !== undefined) pollingSleepSignals.add(signal)
      await Bun.sleep(milliseconds)
    }
  })
  let kills = 0
  try {
    const task = runExampleTask(selected.frame, selected.cwd, {
      ...baseOptions(selected, spawned),
      clock,
      assertRootIdentity: async () => rootIdentity(capability),
      killWorkerAfterFirstResource: () => {
        kills += 1
        throw new Error("synthetic worker SIGKILL cut")
      }
    })
    const requestId = await registrationRequest(selected)
    await publishControl(
      selected.paths.acks,
      `${Id}.json`,
      createRegistrationAck(Nonce, binding({ ...selected, capability }, requestId))
    )
    await waitForFixture("scenario spawn", () => spawned.records.length > 0)
    await waitForFixture(
      "resource and graceful publication-window retries",
      () => pollingSleepSignals.size >= 2
    )
    expect(kills).toBe(0)
    expect(spawned.kills).toEqual([])

    await unlink(temporaryPath)
    await publishControl(
      selected.paths.resources,
      "resource-after-publication.json",
      resourceEvent({ ...selected, capability })
    )
    await waitForFixture("first-resource hook after publication", () => kills > 0)
    expect(kills).toBe(1)
    spawned.settle({ exitCode: null, signal: "SIGTERM" })
    expect((await task)?.status).toBe("failed")
  } finally {
    await unlink(temporaryPath).catch(() => {})
    spawned.settle()
    await cleanup(selected)
  }
})

test("first-resource observer rejects malformed durable temporary lookalikes", async () => {
  if (!Posix) return
  const selected = await fixture()
  const spawned = spawnHarness()
  const capability = Object.freeze({
    ...selected.capability,
    resourceEventTestHook: "kill-worker-after-first" as const
  })
  await writeFile(selected.capabilityPath, `${JSON.stringify(capability)}\n`, {
    mode: 0o600
  })
  let kills = 0
  try {
    const task = runExampleTask(selected.frame, selected.cwd, {
      ...baseOptions(selected, spawned),
      assertRootIdentity: async () => rootIdentity(capability),
      killWorkerAfterFirstResource: () => {
        kills += 1
        throw new Error("malformed temporary component reached the crash hook")
      }
    })
    const requestId = await registrationRequest(selected)
    await publishControl(
      selected.paths.acks,
      `${Id}.json`,
      createRegistrationAck(Nonce, binding({ ...selected, capability }, requestId))
    )
    await waitForFixture("scenario spawn", () => spawned.records.length > 0)
    await writeFile(join(selected.paths.resources ?? "", ".durable-not-a-uuid.tmp"), "invalid\n", {
      flag: "wx",
      mode: 0o400
    })
    await waitForFixture("malformed resource component rejection", () => spawned.kills.length > 0)
    expect(kills).toBe(0)
    expect(spawned.kills).toEqual(["SIGTERM"])
    spawned.settle({ exitCode: null, signal: "SIGTERM" })
    const result = await task
    expect(result?.status).toBe("failed")
    if (result !== null && "cleanupFailures" in result) {
      expect(result.cleanupFailures.map((failure) => failure.code)).toContain(
        "resource-event-invalid"
      )
    }
  } finally {
    spawned.settle()
    await cleanup(selected)
  }
})

test("ambient system error codes are not reused as durable failure codes", async () => {
  if (!Posix) return
  const selected = await fixture()
  const spawnError = Object.assign(new Error("scenario executable is unavailable"), {
    code: "ENOENT"
  })
  try {
    const task = runExampleTask(selected.frame, selected.cwd, {
      ...baseOptions(selected, spawnHarness()),
      spawn: () => {
        throw spawnError
      }
    })
    await ackController(selected).acknowledge()
    const result = await task
    expect(result.status).toBe("failed")
    if (!("cleanupFailures" in result)) {
      throw new Error("authenticated worker invocation returned a direct-root outcome")
    }
    expect(result.cleanupFailures).toEqual([
      {
        code: "example-worker-failed",
        category: "primary",
        summary: "Error: scenario executable is unavailable"
      }
    ])
  } finally {
    await cleanup(selected)
  }
})

test("first-resource observer stops when the scenario exits before creating a resource", async () => {
  if (!Posix) return
  const selected = await fixture()
  const spawned = spawnHarness()
  const capability = Object.freeze({
    ...selected.capability,
    resourceEventTestHook: "kill-worker-after-first" as const
  })
  await writeFile(selected.capabilityPath, `${JSON.stringify(capability)}\n`, {
    mode: 0o600
  })
  let kills = 0
  const pollingSleepSignals = new Set<AbortSignal>()
  const cancelledPollingSleepSignals = new Set<AbortSignal>()
  let rootChecks = 0
  const clock: ExampleTaskClock = Object.freeze({
    now: () => performance.now(),
    date: () => new Date(),
    sleep: async (milliseconds: number, signal?: AbortSignal) => {
      if (signal === undefined) {
        await Bun.sleep(milliseconds)
        return
      }
      pollingSleepSignals.add(signal)
      if (signal.aborted) {
        cancelledPollingSleepSignals.add(signal)
        return
      }
      const cancelled = Promise.withResolvers<void>()
      const onAbort = (): void => {
        cancelledPollingSleepSignals.add(signal)
        cancelled.resolve()
      }
      signal.addEventListener("abort", onAbort, { once: true })
      try {
        await cancelled.promise
      } finally {
        signal.removeEventListener("abort", onAbort)
      }
    }
  })
  try {
    const task = runExampleTask(selected.frame, selected.cwd, {
      ...baseOptions(selected, spawned),
      clock,
      pollIntervalMs: 2,
      assertRootIdentity: async () => {
        rootChecks += 1
        return rootIdentity(capability)
      },
      killWorkerAfterFirstResource: () => {
        kills += 1
        throw new Error("observer ran after scenario settlement")
      }
    })
    const requestId = await registrationRequest(selected)
    await publishControl(
      selected.paths.acks,
      `${Id}.json`,
      createRegistrationAck(Nonce, binding({ ...selected, capability }, requestId))
    )
    await waitForFixture(
      "resource and graceful observer sleeps",
      () => pollingSleepSignals.size >= 2
    )
    expect(pollingSleepSignals.size).toBe(2)

    spawned.settle({ exitCode: 1 })
    const settlement = await Promise.race([
      task.then((value) => ({ kind: "settled" as const, value })),
      Bun.sleep(FixtureWaitTimeoutMs).then(() => ({ kind: "timeout" as const }))
    ])
    expect(settlement.kind).toBe("settled")
    if (settlement.kind === "settled") expect(settlement.value?.status).toBe("failed")
    expect(cancelledPollingSleepSignals).toEqual(pollingSleepSignals)
    expect(kills).toBe(0)
    const checksAfterSettlement = rootChecks
    await publishControl(
      selected.paths.resources,
      "resource-after-settlement.json",
      resourceEvent({ ...selected, capability })
    )
    await Bun.sleep(10)
    expect(rootChecks).toBe(checksAfterSettlement)
    expect(kills).toBe(0)
  } finally {
    spawned.settle()
    await cleanup(selected)
  }
})

test("a durable resource that races scenario settlement still triggers the crash hook", async () => {
  if (!Posix) return
  const selected = await fixture()
  const spawned = spawnHarness()
  const capability = Object.freeze({
    ...selected.capability,
    resourceEventTestHook: "kill-worker-after-first" as const
  })
  await writeFile(selected.capabilityPath, `${JSON.stringify(capability)}\n`, {
    mode: 0o600
  })
  let kills = 0
  let observerSleepStarted = 0
  const clock: ExampleTaskClock = Object.freeze({
    now: () => performance.now(),
    date: () => new Date(),
    sleep: async (milliseconds: number, signal?: AbortSignal) => {
      if (signal === undefined) {
        await Bun.sleep(milliseconds)
        return
      }
      observerSleepStarted += 1
      if (signal.aborted) return
      const cancelled = Promise.withResolvers<void>()
      const onAbort = (): void => cancelled.resolve()
      signal.addEventListener("abort", onAbort, { once: true })
      try {
        await cancelled.promise
      } finally {
        signal.removeEventListener("abort", onAbort)
      }
    }
  })
  try {
    const task = runExampleTask(selected.frame, selected.cwd, {
      ...baseOptions(selected, spawned),
      clock,
      assertRootIdentity: async () => rootIdentity(capability),
      killWorkerAfterFirstResource: () => {
        kills += 1
        throw new Error("synthetic worker SIGKILL cut")
      }
    })
    const requestId = await registrationRequest(selected)
    await publishControl(
      selected.paths.acks,
      `${Id}.json`,
      createRegistrationAck(Nonce, binding({ ...selected, capability }, requestId))
    )
    await waitForFixture("first-resource observer sleep", () => observerSleepStarted > 0)
    expect(observerSleepStarted).toBeGreaterThanOrEqual(1)

    await publishControl(
      selected.paths.resources,
      "resource-race.json",
      resourceEvent({ ...selected, capability })
    )
    spawned.settle()
    expect((await task)?.status).toBe("failed")
    expect(kills).toBe(1)
  } finally {
    spawned.settle()
    await cleanup(selected)
  }
})

test("shared resource events from earlier examples do not alter current exact-pair cleanup", async () => {
  if (!Posix) return
  const selected = await fixture()
  const spawned = spawnHarness()
  const cleanupCalls: unknown[][] = []
  const sibling = Object.freeze({
    id: "earlier-docker-example",
    packageName: "@likego/example-earlier-docker-example",
    cwdRealpath: join(selected.root, "earlier-docker-example"),
    childOwner: "earlier-docker-example-owner"
  })
  const capability = Object.freeze({
    ...selected.capability,
    allowedExamples: Object.freeze([...selected.capability.allowedExamples, sibling])
  })
  await writeFile(selected.capabilityPath, `${JSON.stringify(capability)}\n`, {
    mode: 0o600
  })
  await publishControl(
    selected.paths.resources,
    "earlier-resource.json",
    resourceEvent(selected, {
      id: sibling.id,
      childOwner: sibling.childOwner,
      resourceId: "b".repeat(64)
    })
  )
  try {
    const task = runExampleTask(selected.frame, selected.cwd, {
      ...baseOptions(selected, spawned),
      assertRootIdentity: async () => rootIdentity(capability),
      cleanupDocker: async (...values) => {
        cleanupCalls.push(values)
      }
    })
    const requestId = await registrationRequest(selected)
    await publishControl(
      selected.paths.acks,
      `${Id}.json`,
      createRegistrationAck(Nonce, binding({ ...selected, capability }, requestId))
    )
    await waitForFixture("scenario spawn", () => spawned.records.length > 0)
    spawned.settle()
    expect((await task)?.status).toBe("passed")
    expect(cleanupCalls).toHaveLength(1)
    expect(cleanupCalls[0]?.slice(0, 3)).toEqual([selected.cwd, Invocation, Owner])
  } finally {
    spawned.settle()
    await cleanup(selected)
  }
})

test("nonce, ACK, authority, argv/env, streams, and AggregateError canaries never reach result or forwarded output", async () => {
  if (!Posix) return
  const selected = await fixture()
  const argvCanary = "argv-canary-secret"
  const environmentCanary = "environment-canary-secret"
  const aggregateCanary = "aggregate-canary-secret"
  const spawned = spawnHarness(
    stream("safe stdout token=stream-can", "ary-secret\n"),
    stream("password=stderr-canary-secret\n")
  )
  let forwarded = ""
  try {
    const task = runExampleTask(
      ["bun", "scenario.ts", argvCanary, "--worker", selected.capabilityPath, Nonce],
      selected.cwd,
      {
        ...baseOptions(selected, spawned),
        forwardStdout: (value) => {
          forwarded += value
        },
        forwardStderr: (value) => {
          forwarded += value
        },
        cleanupDocker: async () => {
          throw new AggregateError(
            [new Error(`token=${aggregateCanary}`), new Error(`password=${aggregateCanary}`)],
            `cleanup token=${aggregateCanary}`
          )
        }
      }
    )
    const ack = await ackController(selected).acknowledge()
    await waitForFixture("scenario spawn", () => spawned.records.length > 0)
    const authorityCanary = spawned.records[0]?.options.env[OwnedDockerEnvironmentKey] ?? ""
    expect(authorityCanary.length).toBeGreaterThan(0)
    expect(spawned.records[0]?.options.env.TEST_CANARY).toBeUndefined()
    await publishControl(selected.paths.resources, "resource-fixture.json", resourceEvent(selected))
    spawned.settle({ exitCode: 23 })
    const result = await task
    expect(result?.status).toBe("failed")
    const resultText = await Bun.file(join(selected.paths.results ?? "", `${Id}.json`)).text()
    const complete = `${forwarded}\n${resultText}`
    for (const secret of [
      Nonce,
      ack.ackToken,
      authorityCanary,
      "stream-canary-secret",
      "stderr-canary-secret",
      aggregateCanary
    ]) {
      expect(complete).not.toContain(secret)
    }
    expect(resultText).not.toContain(argvCanary)
    expect(resultText).not.toContain(environmentCanary)
    expect(resultText).not.toContain("stdout")
    expect(resultText).not.toContain("stderr")
    expect(resultText).not.toContain("argv")
    expect(resultText).not.toContain("env")
    expect(resultText).not.toContain("stack")
    expect(resultText).not.toContain("cause")
  } finally {
    spawned.settle()
    await cleanup(selected)
  }
})

test("a fake clock bounds missing ACK polling while the root is checked every iteration", async () => {
  if (!Posix) return
  const selected = await fixture()
  let current = 0
  let rootChecks = 0
  const clock: ExampleTaskClock = Object.freeze({
    now: () => current,
    date: () => new Date(StartedAt),
    sleep: async (milliseconds: number) => {
      current += milliseconds
    }
  })
  try {
    const result = await runExampleTask(selected.frame, selected.cwd, {
      ...baseOptions(selected, spawnHarness()),
      clock,
      pollIntervalMs: 2,
      registrationTimeoutMs: 6,
      assertRootIdentity: async () => {
        rootChecks += 1
        return rootIdentity(selected.capability)
      }
    })
    expect(result?.status).toBe("failed")
    expect(rootChecks).toBeGreaterThanOrEqual(2)
    expect((await readdir(selected.paths.results ?? "")).sort()).toEqual([`${Id}.json`])
  } finally {
    await cleanup(selected)
  }
})
