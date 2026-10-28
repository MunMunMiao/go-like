import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { readdir, readFile, stat, unlink } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import {
  discoverExampleExecutionInputs,
  runSingleExampleLocalRoot,
  type ExampleDockerBackstop,
  type ExamplesRunResult
} from "./examples"
import {
  cleanupDockerPair,
  dockerPairInventoryCommands,
  DockerInvocationLabelKey,
  DockerOwnerLabelKey,
  parseDockerPairInventoryOutput,
  verifyDockerInvocationCleanup,
  type DockerPairResource,
  type DockerResourceType
} from "./harness/docker-pairs"
import {
  createProcessSupervisor,
  runCommand,
  type CommandResult,
  type ProcessSupervisor
} from "./harness/process"
import { DockerCleanupReserveMs } from "./harness/result"

const Root = resolve(import.meta.dir, "..")
const FixtureCwd = resolve(import.meta.dir, "fixtures/example-task-docker")
const GateTimeoutMs = 240_000
const DockerCommandTimeoutMs = 10_000
const DockerBackstopReserveMs = 15_000
const ExactPairCleanupMs = 45_000
const MaximumC6ScannedFiles = 512
const MaximumC6ScannedBytes = 16 * 1024 * 1024
const DockerIdPattern = /^[a-f0-9]{64}$/u
const DockerImages = Object.freeze([
  "gcr.io/etcd-development/etcd:v3.7.1@sha256:a9983dd6d9283138ab926daa307c6c25623636703ecf5645d5df4d666ce9eba2",
  "redis:8.10.0-alpine@sha256:978f0e01593e65eed801f2402944efcd936d43b5027e4908a7897baf88ed6241",
  "hashicorp/consul:2.0.2@sha256:7dcf35d6b2682831094f1680aa58be214134969505acce0a9b280249581aa7d2",
  "hashicorp/vault:2.0.3@sha256:a296a888b118615dc01d5f1a6846e6d4a7277946caaed5b447008fff5fe06b54",
  "otel/opentelemetry-collector-contrib:0.157.0@sha256:f2f01157055a9b2aab9df7118e1f1c9abf345e99b23bc7a2bc791db374a7d0f6",
  "docker.io/library/postgres:18.4@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a",
  "docker.io/library/nats:2.14.4-alpine@sha256:f2123f533c2b0cada0a5c5ec434fb2b8cfe1cf220215ef9d7517e1372917ad66"
])

interface SpecializedCrashCase {
  readonly id: string
  readonly scenarioArgv: readonly string[]
  readonly firstResourceType: DockerResourceType
}

interface ZeroResourceCutCase {
  readonly hook: "kill-worker-before-registration" | "kill-worker-after-ack-before-scenario"
  readonly expectedClassification: "missing-participant" | "registered-but-unreported"
}

const ZeroResourceCutCases = Object.freeze([
  Object.freeze({
    hook: "kill-worker-before-registration" as const,
    expectedClassification: "missing-participant" as const
  }),
  Object.freeze({
    hook: "kill-worker-after-ack-before-scenario" as const,
    expectedClassification: "registered-but-unreported" as const
  })
] satisfies readonly ZeroResourceCutCase[])

const SpecializedCrashCases = Object.freeze([
  Object.freeze({
    id: "batch-reporting",
    scenarioArgv: Object.freeze(["bun", "test/e2e/docker-e2e.ts"]),
    firstResourceType: "container" as const
  }),
  Object.freeze({
    id: "commerce-catalog",
    scenarioArgv: Object.freeze(["bun", "e2e/docker.ts"]),
    firstResourceType: "container" as const
  }),
  Object.freeze({
    id: "cybersecurity-alert-triage",
    scenarioArgv: Object.freeze(["bun", "e2e/docker.ts"]),
    firstResourceType: "container" as const
  }),
  Object.freeze({
    id: "enterprise-platform-runtime",
    scenarioArgv: Object.freeze(["bunx", "--no-install", "tsx", "test/e2e/docker-e2e.ts"]),
    firstResourceType: "container" as const
  }),
  Object.freeze({
    id: "iot-telemetry",
    scenarioArgv: Object.freeze(["bun", "e2e/docker.ts"]),
    firstResourceType: "volume" as const
  }),
  Object.freeze({
    id: "payments-ledger",
    scenarioArgv: Object.freeze(["bun", "e2e/docker.ts"]),
    firstResourceType: "volume" as const
  }),
  Object.freeze({
    id: "saas-tenant-api",
    scenarioArgv: Object.freeze(["bun", "e2e/docker.ts"]),
    firstResourceType: "container" as const
  })
] satisfies readonly SpecializedCrashCase[])

type Runner = ProcessSupervisor["run"]

interface BackstopCapture {
  calls: number
  invocation: string | null
  owners: string[]
  resourcesBeforeCleanup: DockerPairResource[]
  productionFailure: unknown
}

interface FixtureNetwork {
  readonly name: string
  id: string | null
  readonly owner: string | null
  readonly invocation: string | null
}

interface FixtureNetworkObservation {
  readonly id: string
  readonly owner: string | null
  readonly invocation: string | null
}

interface CollisionCapture extends BackstopCapture {
  readonly networks: FixtureNetwork[]
  readonly productionCommands: readonly string[][]
  injectionFailure: unknown
}

let dockerServerPreflightPromise: Promise<void> | null = null
let dockerPreflightPromise: Promise<void> | null = null

function commandSuccessful(result: CommandResult): boolean {
  return (
    !result.timedOut &&
    result.termination === "exit" &&
    result.exitCode === 0 &&
    result.signal === null &&
    result.cleanupFailures.length === 0 &&
    result.residual !== "present" &&
    result.residual !== "inconclusive"
  )
}

function commandFailure(label: string, result: CommandResult): Error {
  return new Error(
    `${label} failed: termination=${result.termination} exit=${String(result.exitCode)} signal=${String(result.signal)}`
  )
}

async function checkedDockerCommand(
  runner: Runner,
  root: string,
  command: readonly string[],
  timeoutMs = DockerCommandTimeoutMs
): Promise<CommandResult> {
  let result: CommandResult
  try {
    result = await runner(root, {
      cwd: ".",
      command: Object.freeze(command.slice()),
      timeoutMs
    })
  } catch {
    throw new Error(
      `real Docker gate command could not start: operation=${command[1] ?? "unknown"}`
    )
  }
  if (!commandSuccessful(result)) {
    throw commandFailure(`real Docker gate ${command[1] ?? "command"}`, result)
  }
  return result
}

async function dockerServerPreflight(): Promise<void> {
  if (dockerServerPreflightPromise !== null) return await dockerServerPreflightPromise
  dockerServerPreflightPromise = (async () => {
    if (process.platform === "win32") {
      throw new Error("real worker SIGKILL gates require a POSIX host")
    }
    await checkedDockerCommand(runCommand, Root, [
      "docker",
      "version",
      "--format",
      "{{.Server.Version}}"
    ])
  })()
  return await dockerServerPreflightPromise
}

async function dockerPreflight(): Promise<void> {
  if (dockerPreflightPromise !== null) return await dockerPreflightPromise
  dockerPreflightPromise = (async () => {
    await dockerServerPreflight()
    for (const image of DockerImages) {
      await checkedDockerCommand(runCommand, Root, [
        "docker",
        "image",
        "inspect",
        "--format",
        "{{.Id}}",
        image
      ])
    }
  })()
  return await dockerPreflightPromise
}

function timeoutBefore(deadline: number, reserveMs: number, pendingCommands: number): number {
  const remaining = Math.floor(deadline - performance.now()) - reserveMs - pendingCommands
  if (remaining < 1) {
    throw new Error("real Docker gate exhausted its caller-owned deadline")
  }
  return Math.min(DockerCommandTimeoutMs, remaining)
}

async function exactPairInventory(
  root: string,
  invocation: string,
  owner: string,
  runner: Runner,
  deadline = performance.now() + 30_000,
  reserveMs = 0
): Promise<readonly DockerPairResource[]> {
  const commands = dockerPairInventoryCommands(invocation, [owner]).filter(
    (entry) => entry.filter === "invocation"
  )
  const resources = new Map<string, DockerPairResource>()
  for (const [index, entry] of commands.entries()) {
    const result = await checkedDockerCommand(
      runner,
      root,
      entry.command,
      timeoutBefore(deadline, reserveMs, commands.length - index - 1)
    )
    for (const resource of parseDockerPairInventoryOutput(entry.type, result.stdout)) {
      if (resource.owner === owner && resource.invocation === invocation) {
        resources.set(`${resource.type}\u0000${resource.id}`, resource)
      }
    }
  }
  return Object.freeze(
    Array.from(resources.values()).sort((left, right) =>
      `${left.type}\u0000${left.id}`.localeCompare(`${right.type}\u0000${right.id}`)
    )
  )
}

function oneOwner(owners: readonly string[]): string {
  const owner = owners[0]
  if (owners.length !== 1 || owner === undefined) {
    throw new Error("real Docker gate expected one registered child owner")
  }
  return owner
}

function nestedMessages(value: unknown, seen = new Set<unknown>()): readonly string[] {
  if (value === null || value === undefined || seen.has(value)) return Object.freeze([])
  seen.add(value)
  if (!(value instanceof Error)) return Object.freeze([])
  const messages = [value.message]
  if (value instanceof AggregateError) {
    for (const nested of value.errors) messages.push(...nestedMessages(nested, seen))
  }
  if (value.cause !== undefined) messages.push(...nestedMessages(value.cause, seen))
  return Object.freeze(messages)
}

function throwCollectedFailures(failures: readonly unknown[], summary: string): void {
  const selected = failures.filter((failure) => failure !== null && failure !== undefined)
  if (selected.length === 0) return
  if (selected.length === 1) throw selected[0]
  throw new AggregateError(selected, summary)
}

function captureBackstop(capture: BackstopCapture): ExampleDockerBackstop {
  return async (root, invocation, owners, deadline, runner) => {
    capture.calls += 1
    capture.invocation = invocation
    capture.owners = Array.from(owners)
    const failures: unknown[] = []
    try {
      capture.resourcesBeforeCleanup = Array.from(
        await exactPairInventory(
          root,
          invocation,
          oneOwner(capture.owners),
          runner,
          deadline,
          DockerBackstopReserveMs
        )
      )
    } catch (error) {
      failures.push(error)
    }
    try {
      await verifyDockerInvocationCleanup(root, invocation, capture.owners, deadline, runner)
    } catch (error) {
      capture.productionFailure = error
      failures.push(error)
    }
    throwCollectedFailures(failures, "real Docker snapshot and production backstop failed")
  }
}

async function compensateExactPair(
  invocation: string,
  owner: string
): Promise<readonly DockerPairResource[]> {
  const failures: unknown[] = []
  let observed: readonly DockerPairResource[] = Object.freeze([])
  try {
    observed = await exactPairInventory(Root, invocation, owner, runCommand)
  } catch (error) {
    failures.push(error)
  }
  if (observed.length > 0) {
    try {
      await cleanupDockerPair(
        Root,
        invocation,
        owner,
        performance.now() + ExactPairCleanupMs,
        runCommand
      )
    } catch (error) {
      failures.push(error)
    }
  }
  try {
    const remaining = await exactPairInventory(Root, invocation, owner, runCommand)
    if (remaining.length > 0) {
      failures.push(
        new Error(
          `real Docker exact-pair compensation left ${remaining.length} resource(s) untouched`
        )
      )
    }
  } catch (error) {
    failures.push(error)
  }
  throwCollectedFailures(failures, "real Docker exact-pair compensation failed")
  return observed
}

function assertCrashResult(
  selected: SpecializedCrashCase,
  result: ExamplesRunResult,
  capture: BackstopCapture,
  remainingAfterProduction: readonly DockerPairResource[]
): void {
  const record = result.examples[0]
  const owner = oneOwner(capture.owners)
  const capturedInvocation = capture.invocation
  if (capturedInvocation === null) {
    throw new Error("real Docker gate did not capture the root invocation")
  }
  expect(result.status).toBe("failed")
  expect(result.invocation).toBe(capturedInvocation)
  expect(result.executionInputIds).toEqual([selected.id])
  expect(result.participantIds).toEqual([selected.id])
  expect(result.resultIds).toEqual(record?.result === null ? [] : [selected.id])
  expect(result.completedCommandIds).toEqual([selected.id])
  expect(result.registeredChildOwners).toEqual([owner])
  expect(result.timedOut).toBe(false)
  expect(record?.id).toBe(selected.id)
  expect(record?.wrapperEntered).toBe(true)
  expect(record?.registration).not.toBeNull()
  expect(record?.registration?.childOwner).toBe(owner)
  expect(record?.acknowledged).toBe(true)
  expect(capture.calls).toBe(1)
  expect(capture.resourcesBeforeCleanup.length).toBeGreaterThan(0)
  expect(capture.productionFailure).toBeInstanceOf(Error)
  expect(
    capture.resourcesBeforeCleanup.some((resource) => resource.type === selected.firstResourceType)
  ).toBe(true)
  for (const resource of capture.resourcesBeforeCleanup) {
    expect(resource.owner).toBe(owner)
    expect(resource.invocation).toBe(capturedInvocation)
  }
  expect(remainingAfterProduction).toEqual([])
  expect(nestedMessages(capture.productionFailure).join("\n")).toContain(
    "Docker owned resource observed"
  )
  expect(record?.command?.termination).toBe("signal")
  expect(record?.command?.signal).toBe("SIGKILL")
  if (record?.result === null) {
    expect(record.classification).toBe("registered-but-unreported")
  } else {
    expect(record?.classification).toBe("failed")
    expect(record?.result?.status).toBe("failed")
    expect(record?.result?.cleanupFailures.map((failure) => failure.code)).toContain(
      "docker-cleanup-failed"
    )
  }
  expect(record?.command?.timedOut).toBe(false)
  const failureCodes = result.failures.map((failure) => failure.code)
  expect(failureCodes).toContain(
    record?.result === null
      ? "example-registered-but-unreported"
      : "example-result-command-inconsistent"
  )
  expect(failureCodes).toContain("example-command-failed")
  expect(failureCodes).toContain("example-docker-backstop-failed")
  expect(nestedMessages(capture.productionFailure).join("\n")).toContain(
    "Docker owned resource observed"
  )
  expect(result.residual).toBe("present")
}

function captureZeroResourceBackstop(capture: BackstopCapture): ExampleDockerBackstop {
  return async (root, invocation, owners, deadline, runner) => {
    capture.calls += 1
    capture.invocation = invocation
    capture.owners = Array.from(owners)
    const commands = dockerPairInventoryCommands(invocation, capture.owners)
    const resources = new Map<string, DockerPairResource>()
    for (const [index, entry] of commands.entries()) {
      const result = await checkedDockerCommand(
        runner,
        root,
        entry.command,
        timeoutBefore(deadline, 0, commands.length - index - 1)
      )
      for (const resource of parseDockerPairInventoryOutput(entry.type, result.stdout)) {
        resources.set(`${resource.type}\u0000${resource.id}`, resource)
      }
    }
    capture.resourcesBeforeCleanup = Array.from(resources.values())
    await verifyDockerInvocationCleanup(root, invocation, capture.owners, deadline, runner)
  }
}

for (const selected of ZeroResourceCutCases) {
  test(
    `C4 ${selected.hook} is a real worker SIGKILL with no scenario start or Docker inventory`,
    async () => {
      await dockerServerPreflight()
      const markerPath = join(
        FixtureCwd,
        `.scenario-started-${selected.hook}-${randomUUID()}.marker`
      )
      const capture: BackstopCapture = {
        calls: 0,
        invocation: null,
        owners: [],
        resourcesBeforeCleanup: [],
        productionFailure: null
      }
      let result: ExamplesRunResult | null = null
      try {
        result = await runSingleExampleLocalRoot(
          Root,
          FixtureCwd,
          ["bun", "scenario.ts", "mark-started", markerPath],
          {
            resourceEventTestHook: selected.hook,
            timeoutMs: 30_000,
            gracePeriodMs: 1_000,
            hardTerminationReserveMs: 10_000,
            dockerCleanupTimeoutMs: 20_000,
            pollIntervalMs: 10,
            workerDriverDrainMs: 1_000,
            processMode: "managed",
            dockerBackstop: captureZeroResourceBackstop(capture)
          }
        )
        const record = result.examples[0]
        expect(result.status).toBe("failed")
        expect(result.executionInputIds).toEqual(["example-task-docker"])
        expect(result.completedCommandIds).toEqual(["example-task-docker"])
        expect(record?.classification).toBe(selected.expectedClassification)
        expect(record?.command?.termination).toBe("signal")
        expect(record?.command?.signal).toBe("SIGKILL")
        expect(record?.command?.timedOut).toBe(false)
        expect(record?.result).toBeNull()
        expect(capture.calls).toBe(1)
        expect(capture.resourcesBeforeCleanup).toEqual([])
        expect(await Bun.file(markerPath).exists()).toBe(false)
        if (selected.hook === "kill-worker-before-registration") {
          expect(result.participantIds).toEqual([])
          expect(result.registeredChildOwners).toEqual([])
          expect(record?.wrapperEntered).toBe(false)
          expect(record?.registration).toBeNull()
          expect(record?.acknowledged).toBe(false)
        } else {
          expect(result.participantIds).toEqual(["example-task-docker"])
          expect(result.registeredChildOwners).toHaveLength(1)
          expect(record?.wrapperEntered).toBe(true)
          expect(record?.registration).not.toBeNull()
          expect(record?.acknowledged).toBe(true)
        }
      } finally {
        await unlink(markerPath).catch(() => {})
      }
    },
    GateTimeoutMs
  )
}

async function runSpecializedCrashGate(selected: SpecializedCrashCase): Promise<void> {
  await dockerPreflight()
  const capture: BackstopCapture = {
    calls: 0,
    invocation: null,
    owners: [],
    resourcesBeforeCleanup: [],
    productionFailure: null
  }
  let result: ExamplesRunResult | null = null
  let runFailure: unknown = null
  try {
    result = await runSingleExampleLocalRoot(
      Root,
      resolve(Root, "examples", selected.id),
      selected.scenarioArgv,
      {
        resourceEventTestHook: "kill-worker-after-first",
        timeoutMs: 120_000,
        gracePeriodMs: 1_000,
        hardTerminationReserveMs: 10_000,
        dockerCleanupTimeoutMs: 45_000,
        pollIntervalMs: 10,
        workerDriverDrainMs: 1_000,
        processMode: "managed",
        dockerBackstop: captureBackstop(capture)
      }
    )
  } catch (error) {
    runFailure = error
  }

  if (capture.invocation === null && result !== null) capture.invocation = result.invocation
  if (capture.owners.length === 0 && result !== null) {
    capture.owners = Array.from(result.registeredChildOwners)
  }
  let remainingAfterProduction: readonly DockerPairResource[] = Object.freeze([])
  let compensationFailure: unknown = null
  if (capture.invocation !== null && capture.owners.length === 1) {
    try {
      remainingAfterProduction = await compensateExactPair(
        capture.invocation,
        oneOwner(capture.owners)
      )
    } catch (error) {
      compensationFailure = error
    }
  }
  throwCollectedFailures(
    [runFailure, compensationFailure],
    `${selected.id} crash gate and compensation failed`
  )
  if (result === null) throw new Error(`${selected.id} crash gate returned no aggregate result`)
  assertCrashResult(selected, result, capture, remainingAfterProduction)
}

for (const selected of SpecializedCrashCases) {
  test(
    `C5 ${selected.id} first real owned resource reaches the registered-owner backstop`,
    async () => {
      await runSpecializedCrashGate(selected)
    },
    GateTimeoutMs
  )
}

test(
  "C5 shared OwnedDocker fixture covers a real network first-resource crash",
  async () => {
    const selected: SpecializedCrashCase = Object.freeze({
      id: "example-task-docker",
      scenarioArgv: Object.freeze(["bun", "scenario.ts", "network-then-wait"]),
      firstResourceType: "network"
    })
    await dockerPreflight()
    const capture: BackstopCapture = {
      calls: 0,
      invocation: null,
      owners: [],
      resourcesBeforeCleanup: [],
      productionFailure: null
    }
    let result: ExamplesRunResult | null = null
    let runFailure: unknown = null
    try {
      result = await runSingleExampleLocalRoot(Root, FixtureCwd, selected.scenarioArgv, {
        resourceEventTestHook: "kill-worker-after-first",
        timeoutMs: 120_000,
        gracePeriodMs: 1_000,
        hardTerminationReserveMs: 10_000,
        dockerCleanupTimeoutMs: 45_000,
        pollIntervalMs: 10,
        workerDriverDrainMs: 1_000,
        processMode: "managed",
        dockerBackstop: captureBackstop(capture)
      })
    } catch (error) {
      runFailure = error
    }
    if (capture.invocation === null && result !== null) capture.invocation = result.invocation
    if (capture.owners.length === 0 && result !== null) {
      capture.owners = Array.from(result.registeredChildOwners)
    }
    let remainingAfterProduction: readonly DockerPairResource[] = Object.freeze([])
    let compensationFailure: unknown = null
    if (capture.invocation !== null && capture.owners.length === 1) {
      try {
        remainingAfterProduction = await compensateExactPair(
          capture.invocation,
          oneOwner(capture.owners)
        )
      } catch (error) {
        compensationFailure = error
      }
    }
    throwCollectedFailures(
      [runFailure, compensationFailure],
      "shared network crash gate and compensation failed"
    )
    if (result === null) throw new Error("shared network crash gate returned no aggregate result")
    assertCrashResult(selected, result, capture, remainingAfterProduction)
    expect(capture.resourcesBeforeCleanup.some((resource) => resource.type === "network")).toBe(
      true
    )
  },
  GateTimeoutMs
)

async function scanTreeForSecret(root: string, secret: string): Promise<void> {
  const pending = [root]
  let files = 0
  let bytes = 0
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined) break
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        pending.push(path)
        continue
      }
      if (!entry.isFile()) throw new Error("C6 invocation tree contains a non-regular artifact")
      files += 1
      if (files > MaximumC6ScannedFiles) throw new Error("C6 invocation tree file bound exceeded")
      const metadata = await stat(path)
      bytes += metadata.size
      if (bytes > MaximumC6ScannedBytes) throw new Error("C6 invocation tree byte bound exceeded")
      expect((await readFile(path)).includes(Buffer.from(secret))).toBe(false)
    }
  }
}

test(
  "C6-PR5 one canary is absent from Docker logs, output, failures, IPC, capability, ACK, and temp artifacts",
  async () => {
    await dockerPreflight()
    const canary = `go-like-c6-canary-${randomUUID()}`
    const previous = process.env.GO_LIKE_C6_SECRET
    process.env.GO_LIKE_C6_SECRET = canary
    let invocationRoot: string | null = null
    let result: ExamplesRunResult | null = null
    try {
      result = await runSingleExampleLocalRoot(
        Root,
        FixtureCwd,
        ["bun", "scenario.ts", "sanitizer-canary", canary, `--token=${canary}`],
        {
          dockerDiagnosticsPolicy: "safe-redacted-logs",
          timeoutMs: 30_000,
          gracePeriodMs: 1_000,
          hardTerminationReserveMs: 10_000,
          dockerCleanupTimeoutMs: 45_000,
          pollIntervalMs: 10,
          workerDriverDrainMs: 1_000,
          processMode: "managed",
          workerDriver: async (context) => {
            invocationRoot = dirname(context.capabilityPath)
            const complete = await context.commandPromise
            const snapshot = JSON.stringify({
              complete,
              capability: context.capability,
              nonce: context.nonce,
              registration: await context.readRegistration(),
              ack: await context.readAck()
            })
            expect(snapshot).not.toContain(canary)
            await scanTreeForSecret(invocationRoot, canary)
          }
        }
      )
      expect(result.status).toBe("failed")
      const rendered = JSON.stringify(result)
      expect(rendered).not.toContain(canary)
      expect(result.stdout).not.toContain(canary)
      expect(result.stderr).not.toContain(canary)
      expect(rendered).toContain("<redacted>")
      expect(invocationRoot).not.toBeNull()
    } finally {
      if (previous === undefined) delete process.env.GO_LIKE_C6_SECRET
      else process.env.GO_LIKE_C6_SECRET = previous
      if (invocationRoot !== null) expect(await Bun.file(invocationRoot).exists()).toBe(false)
    }
  },
  GateTimeoutMs
)

function fixtureLabels(network: FixtureNetwork): readonly string[] {
  const arguments_: string[] = []
  if (network.owner !== null) {
    arguments_.push("--label", `${DockerOwnerLabelKey}=${network.owner}`)
  }
  if (network.invocation !== null) {
    arguments_.push("--label", `${DockerInvocationLabelKey}=${network.invocation}`)
  }
  return Object.freeze(arguments_)
}

async function createFixtureNetwork(
  runner: Runner,
  root: string,
  deadline: number,
  network: FixtureNetwork,
  remainingCreates: number
): Promise<void> {
  const result = await checkedDockerCommand(
    runner,
    root,
    ["docker", "network", "create", ...fixtureLabels(network), network.name],
    timeoutBefore(deadline, 20_000, remainingCreates)
  )
  const id = result.stdout.trim()
  if (!DockerIdPattern.test(id)) {
    throw new Error("real Docker fixture network create returned an invalid full ID")
  }
  network.id = id
}

function parsedNullableString(value: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(value) as unknown
  } catch {
    throw new Error("real Docker fixture inspect returned invalid JSON")
  }
  if (parsed === null) return null
  if (typeof parsed !== "string") {
    throw new Error("real Docker fixture inspect returned an invalid label value")
  }
  return parsed
}

async function inspectFixtureNetwork(
  network: FixtureNetwork
): Promise<FixtureNetworkObservation | null> {
  const target = network.id ?? network.name
  const format = `{{json .Id}}\t{{json (index .Labels "${DockerOwnerLabelKey}")}}\t{{json (index .Labels "${DockerInvocationLabelKey}")}}`
  const result = await runCommand(Root, {
    cwd: ".",
    command: ["docker", "network", "inspect", "--format", format, target],
    timeoutMs: DockerCommandTimeoutMs
  })
  if (!commandSuccessful(result)) {
    if (result.termination === "exit" && result.exitCode === 1) return null
    throw commandFailure("real Docker fixture network inspect", result)
  }
  const line = result.stdout.trim()
  const fields = line.split("\t")
  if (fields.length !== 3) throw new Error("real Docker fixture inspect row is invalid")
  const id = parsedNullableString(fields[0] ?? "")
  const owner = parsedNullableString(fields[1] ?? "")
  const invocation = parsedNullableString(fields[2] ?? "")
  if (id === null || !DockerIdPattern.test(id)) {
    throw new Error("real Docker fixture inspect returned an invalid full ID")
  }
  return Object.freeze({ id, owner, invocation })
}

async function removeFixtureNetworks(networks: readonly FixtureNetwork[]): Promise<void> {
  const failures: unknown[] = []
  for (const network of networks.slice().reverse()) {
    let observed: FixtureNetworkObservation | null
    try {
      observed = await inspectFixtureNetwork(network)
    } catch (error) {
      failures.push(error)
      continue
    }
    if (observed === null) continue
    if (
      (network.id !== null && observed.id !== network.id) ||
      observed.owner !== network.owner ||
      observed.invocation !== network.invocation
    ) {
      failures.push(
        new Error(
          `refusing to remove changed Docker fixture network ${network.name}: ownership labels or full ID no longer match`
        )
      )
      continue
    }
    try {
      await checkedDockerCommand(runCommand, Root, ["docker", "network", "rm", observed.id])
      if ((await inspectFixtureNetwork(network)) !== null) {
        failures.push(
          new Error(`Docker fixture network ${network.name} remained after exact removal`)
        )
      }
    } catch (error) {
      failures.push(error)
    }
  }
  throwCollectedFailures(failures, "real Docker collision fixture cleanup failed")
}

test(
  "C5 Docker duplicate filters for one label key are AND, so owner sources remain separate",
  async () => {
    await dockerServerPreflight()
    const suffix = randomUUID()
    const invocation = `c5-filter-invocation-${suffix}`
    const networks: FixtureNetwork[] = [
      {
        name: `go-like-c5-filter-a-${suffix}`,
        id: null,
        owner: `c5-filter-owner-a-${suffix}`,
        invocation
      },
      {
        name: `go-like-c5-filter-b-${suffix}`,
        id: null,
        owner: `c5-filter-owner-b-${suffix}`,
        invocation
      }
    ]
    const deadline = performance.now() + 60_000
    const failures: unknown[] = []
    try {
      for (const [index, network] of networks.entries()) {
        await createFixtureNetwork(runCommand, Root, deadline, network, networks.length - index - 1)
      }
      const firstOwner = networks[0]?.owner
      const secondOwner = networks[1]?.owner
      if (
        firstOwner === null ||
        firstOwner === undefined ||
        secondOwner === null ||
        secondOwner === undefined
      ) {
        throw new Error("real Docker filter fixture owner is unavailable")
      }
      const single = await checkedDockerCommand(runCommand, Root, [
        "docker",
        "network",
        "ls",
        "--no-trunc",
        "--filter",
        `label=${DockerOwnerLabelKey}=${firstOwner}`,
        "--format",
        "{{json .ID}}"
      ])
      expect(single.stdout.trim().split(/\r?\n/u)).toContain(JSON.stringify(networks[0]?.id))
      const repeated = await checkedDockerCommand(runCommand, Root, [
        "docker",
        "network",
        "ls",
        "--no-trunc",
        "--filter",
        `label=${DockerOwnerLabelKey}=${firstOwner}`,
        "--filter",
        `label=${DockerOwnerLabelKey}=${secondOwner}`,
        "--format",
        "{{json .ID}}"
      ])
      expect(repeated.stdout).toBe("")
    } catch (error) {
      failures.push(error)
    } finally {
      try {
        await removeFixtureNetworks(networks)
      } catch (error) {
        failures.push(error)
      }
    }
    throwCollectedFailures(failures, "real Docker duplicate-filter gate failed")
  },
  GateTimeoutMs
)

test(
  "C5 current dynamic-owner production backstop completes the default Docker budget",
  async () => {
    await dockerServerPreflight()
    const inputs = await discoverExampleExecutionInputs(Root)
    expect(inputs.length).toBeGreaterThan(0)
    const suffix = randomUUID()
    const owners = inputs.map((input) => `c5-scale-${input.id}`)
    const invocation = `c5-scale-${suffix}`
    const supervisor = await createProcessSupervisor("managed", Root)
    await supervisor.preflight()
    let calls = 0
    const startedAt = performance.now()
    try {
      await verifyDockerInvocationCleanup(
        Root,
        invocation,
        owners,
        startedAt + DockerCleanupReserveMs,
        async (commandRoot, definition) => {
          calls += 1
          return await supervisor.run(commandRoot, definition)
        }
      )
    } finally {
      await supervisor.close()
    }
    expect(calls).toBeGreaterThanOrEqual((owners.length + 1) * 3 * 3)
    expect(performance.now() - startedAt).toBeLessThan(DockerCleanupReserveMs)
  },
  GateTimeoutMs
)

function collisionBackstop(capture: CollisionCapture): ExampleDockerBackstop {
  return async (root, invocation, owners, deadline, runner) => {
    capture.calls += 1
    capture.invocation = invocation
    capture.owners = Array.from(owners)
    const owner = oneOwner(capture.owners)
    const suffix = randomUUID()
    const foreignOwner = `c5-foreign-owner-${suffix}`
    const unknownOwner = `c5-unknown-owner-${suffix}`
    const foreignInvocation = `c5-foreign-invocation-${suffix}`
    capture.networks.push(
      {
        name: `go-like-c5-unknown-current-${suffix}`,
        id: null,
        owner: unknownOwner,
        invocation
      },
      {
        name: `go-like-c5-missing-current-${suffix}`,
        id: null,
        owner: null,
        invocation
      },
      {
        name: `go-like-c5-registered-foreign-${suffix}`,
        id: null,
        owner,
        invocation: foreignInvocation
      },
      {
        name: `go-like-c5-registered-missing-${suffix}`,
        id: null,
        owner,
        invocation: null
      },
      {
        name: `go-like-c5-foreign-canary-${suffix}`,
        id: null,
        owner: foreignOwner,
        invocation: foreignInvocation
      }
    )

    const failures: unknown[] = []
    try {
      for (const [index, network] of capture.networks.entries()) {
        await createFixtureNetwork(
          runner,
          root,
          deadline,
          network,
          capture.networks.length - index - 1
        )
      }
    } catch (error) {
      capture.injectionFailure = error
      failures.push(error)
    }

    const recordingRunner: Runner = async (commandRoot, definition) => {
      ;(capture.productionCommands as string[][]).push(definition.command.slice())
      return await runner(commandRoot, definition)
    }
    try {
      await verifyDockerInvocationCleanup(
        root,
        invocation,
        capture.owners,
        deadline,
        recordingRunner
      )
    } catch (error) {
      capture.productionFailure = error
      failures.push(error)
    }
    throwCollectedFailures(failures, "real Docker collision injection and backstop failed")
  }
}

test(
  "C5 real Docker backstop leaves four collision classes and one foreign canary untouched",
  async () => {
    await dockerPreflight()
    const capture: CollisionCapture = {
      calls: 0,
      invocation: null,
      owners: [],
      resourcesBeforeCleanup: [],
      productionFailure: null,
      networks: [],
      productionCommands: [],
      injectionFailure: null
    }
    let result: ExamplesRunResult | null = null
    let runFailure: unknown = null
    try {
      result = await runSingleExampleLocalRoot(
        Root,
        FixtureCwd,
        ["bun", "scenario.ts", "registration-only"],
        {
          timeoutMs: 60_000,
          gracePeriodMs: 1_000,
          hardTerminationReserveMs: 10_000,
          dockerCleanupTimeoutMs: 60_000,
          pollIntervalMs: 10,
          workerDriverDrainMs: 1_000,
          processMode: "managed",
          dockerBackstop: collisionBackstop(capture)
        }
      )
    } catch (error) {
      runFailure = error
    }

    const observations: Array<FixtureNetworkObservation | null> = []
    const postRunFailures: unknown[] = []
    for (const network of capture.networks) {
      try {
        observations.push(await inspectFixtureNetwork(network))
      } catch (error) {
        observations.push(null)
        postRunFailures.push(error)
      }
    }
    let exactPairAfterProduction: readonly DockerPairResource[] = Object.freeze([])
    if (capture.invocation !== null && capture.owners.length === 1) {
      try {
        exactPairAfterProduction = await exactPairInventory(
          Root,
          capture.invocation,
          oneOwner(capture.owners),
          runCommand
        )
      } catch (error) {
        postRunFailures.push(error)
      }
    }
    try {
      await removeFixtureNetworks(capture.networks)
    } catch (error) {
      postRunFailures.push(error)
    }
    throwCollectedFailures(
      [runFailure, ...postRunFailures],
      "real Docker collision gate and fixture cleanup failed"
    )

    if (result === null) throw new Error("real Docker collision gate returned no aggregate result")
    const record = result.examples[0]
    expect(result.status).toBe("failed")
    expect(result.residual).toBe("inconclusive")
    expect(result.executionInputIds).toEqual(["example-task-docker"])
    expect(result.participantIds).toEqual(["example-task-docker"])
    expect(result.resultIds).toEqual(["example-task-docker"])
    expect(result.completedCommandIds).toEqual(["example-task-docker"])
    expect(result.registeredChildOwners).toEqual(capture.owners)
    expect(record?.classification).toBe("passed")
    expect(record?.registration).not.toBeNull()
    expect(record?.acknowledged).toBe(true)
    expect(record?.result?.status).toBe("passed")
    expect(record?.command?.termination).toBe("exit")
    expect(record?.command?.exitCode).toBe(0)
    expect(capture.calls).toBe(1)
    expect(capture.injectionFailure).toBeNull()
    expect(capture.networks).toHaveLength(5)
    expect(observations).toHaveLength(5)
    for (const [index, network] of capture.networks.entries()) {
      const observed = observations[index]
      if (observed === null || observed === undefined || network.id === null) {
        throw new Error(`Docker fixture network ${network.name} was not left untouched`)
      }
      expect(observed.id).toBe(network.id)
      expect(observed.owner).toBe(network.owner)
      expect(observed.invocation).toBe(network.invocation)
    }
    expect(exactPairAfterProduction).toEqual([])
    expect(capture.productionCommands.length).toBeGreaterThan(0)
    for (const command of capture.productionCommands) {
      const joined = command.join(" ")
      expect(command).toContain("ls")
      expect(joined).not.toContain("inspect")
      expect(joined).not.toContain("logs")
      expect(joined).not.toContain(" rm ")
      expect(joined).not.toContain("prune")
    }
    const messages = nestedMessages(capture.productionFailure).join("\n")
    expect(messages).toContain("owner-label=unknown invocation-label=current")
    expect(messages).toContain("owner-label=missing invocation-label=current")
    expect(messages).toContain("owner-label=registered invocation-label=foreign")
    expect(messages).toContain("owner-label=registered invocation-label=missing")
    const foreign = capture.networks[4]
    expect(foreign?.id).toBeString()
    expect(messages).not.toContain(foreign?.id ?? "foreign-network-id-unavailable")
    expect(result.failures.map((failure) => failure.code)).toContain(
      "example-docker-backstop-failed"
    )
  },
  GateTimeoutMs
)
