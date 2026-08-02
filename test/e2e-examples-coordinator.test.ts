import { expect, test } from "bun:test"
import { mkdir, readdir, stat, writeFile } from "node:fs/promises"
import { basename, join, resolve } from "node:path"

import {
  ExampleInvocationDirectoryNames,
  runExamples,
  runSingleExampleLocalRoot,
  type ExampleWorkerDriverContext,
  type ExamplesRunOptions
} from "../e2e/examples"
import { errorSummary } from "../e2e/harness/diagnostics"
import {
  parseGracefulControl,
  parseRegistrationAck,
  parseResourceEvent,
  type ExampleParticipant,
  type ExampleResult,
  type ProcessIdentity,
  type RegistrationAck
} from "../e2e/harness/example-protocol"
import {
  closeOwnedDockerContext,
  createContainer,
  createOwnedDockerContext,
  type ScenarioDockerAuthority
} from "../e2e/harness/owned-docker"
import type { CommandDefinition, CommandResult, ProcessSupervisor } from "../e2e/harness/process"
import { createTempDirectory, removeTempDirectory, type TempDirectory } from "../e2e/harness/temp"

const Timestamp = "2026-07-31T05:00:00.000Z"
const Principal = `uid:${typeof process.getuid === "function" ? process.getuid() : 0}`
const RootIdentity: ProcessIdentity = Object.freeze({
  pid: process.pid,
  ppid: Math.max(0, process.ppid),
  pgid: process.pid,
  startIdentity: "fixture-root-start",
  principal: Principal
})

type Runner = ProcessSupervisor["run"]

interface RepositoryFixture {
  readonly temp: TempDirectory
  readonly root: string
  readonly cwdById: ReadonlyMap<string, string>
}

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (reason: unknown) => void
}

interface RunnerCall {
  readonly root: string
  readonly definition: CommandDefinition
  readonly deferred: Deferred<CommandResult>
}

interface DeferredRunner {
  readonly runner: Runner
  readonly calls: RunnerCall[]
  readonly callFor: (context: ExampleWorkerDriverContext) => RunnerCall
}

interface BackstopObservation {
  readonly invocation: string
  readonly owners: readonly string[]
  readonly deadline?: number | undefined
}

function deferred<T>(): Deferred<T> {
  let resolveValue: ((value: T) => void) | null = null
  let rejectValue: ((reason: unknown) => void) | null = null
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolveValue = resolvePromise
    rejectValue = rejectPromise
  })
  return Object.freeze({
    promise,
    resolve(value: T): void {
      resolveValue?.(value)
    },
    reject(reason: unknown): void {
      rejectValue?.(reason)
    }
  })
}

function commandResult(overrides: Partial<CommandResult> = Object.freeze({})): CommandResult {
  return Object.freeze({
    exitCode: 0,
    signal: null,
    termination: "exit",
    timedOut: false,
    abortReason: null,
    durationMs: 5,
    stdout: "",
    stderr: "",
    cleanupFailures: Object.freeze([]),
    containment: "not-claimed",
    residual: "zero-observed",
    ...overrides
  })
}

function abortResult(reason: unknown): CommandResult {
  return commandResult({
    exitCode: null,
    termination: "abort",
    abortReason: errorSummary(reason)
  })
}

function createDeferredRunner(events: string[] = []): DeferredRunner {
  const calls: RunnerCall[] = []
  const runner: Runner = (root, definition) => {
    const result = deferred<CommandResult>()
    const call = Object.freeze({ root, definition, deferred: result })
    calls.push(call)
    const aborted = (): void => {
      events.push(`hard:${calls.indexOf(call)}`)
      result.resolve(abortResult(definition.signal?.reason))
    }
    definition.signal?.addEventListener("abort", aborted, { once: true })
    if (definition.signal?.aborted === true) aborted()
    return result.promise
  }
  return Object.freeze({
    runner,
    calls,
    callFor(context: ExampleWorkerDriverContext): RunnerCall {
      const matches = calls.filter(
        (call) =>
          call.definition.cwd === context.input.cwdRealpath ||
          call.definition.command.includes(context.input.cwdRealpath)
      )
      const selected = matches.length === 1 ? matches[0] : calls.length === 1 ? calls[0] : undefined
      if (selected === undefined) throw new Error(`no command call for ${context.input.id}`)
      return selected
    }
  })
}

function manifest(id: string): Readonly<Record<string, unknown>> {
  return Object.freeze({
    name: `@likego/example-${id}`,
    private: true,
    scripts: Object.freeze({ "test:e2e": "bun ../../e2e/example-task.ts -- synthetic" })
  })
}

async function repositoryFixture(ids: readonly string[]): Promise<RepositoryFixture> {
  const temp = await createTempDirectory("likego-example-coordinator-test-")
  const root = temp.path
  const examples = join(root, "examples")
  await mkdir(examples, { mode: 0o700 })
  const cwdById = new Map<string, string>()
  for (const id of ids) {
    const cwd = join(examples, id)
    await mkdir(cwd, { mode: 0o700 })
    await writeFile(join(cwd, "package.json"), `${JSON.stringify(manifest(id))}\n`, {
      mode: 0o600
    })
    cwdById.set(id, cwd)
  }
  return Object.freeze({ temp, root, cwdById })
}

async function standalonePackage(root: string, id: string): Promise<string> {
  const cwd = join(root, "standalone", id)
  await mkdir(cwd, { recursive: true, mode: 0o700 })
  await writeFile(join(cwd, "package.json"), `${JSON.stringify(manifest(id))}\n`, {
    mode: 0o600
  })
  return cwd
}

function allowedEntry(context: ExampleWorkerDriverContext) {
  const entries = context.capability.allowedExamples.filter(
    (entry) => entry.id === context.input.id
  )
  const entry = entries[0]
  if (entries.length !== 1 || entry === undefined) {
    throw new Error(`missing capability entry for ${context.input.id}`)
  }
  return entry
}

function participantFor(
  context: ExampleWorkerDriverContext,
  identities: Map<number, ProcessIdentity>,
  offset = 0,
  overrides: Readonly<Record<string, unknown>> = Object.freeze({})
): ExampleParticipant {
  const entry = allowedEntry(context)
  const workerPid = 10_000 + offset
  const workerStartIdentity = `fixture-worker-${workerPid}`
  identities.set(
    workerPid,
    Object.freeze({
      pid: workerPid,
      ppid: process.pid,
      pgid: workerPid,
      startIdentity: workerStartIdentity,
      principal: Principal
    })
  )
  return {
    schemaVersion: 1,
    id: context.input.id,
    packageName: context.input.packageName,
    cwdRealpath: context.input.cwdRealpath,
    workerPid,
    workerStartIdentity,
    childOwner: entry.childOwner,
    parentInvocation: context.capability.invocation,
    startedAt: Timestamp,
    ...overrides
  } as ExampleParticipant
}

function passedResultFor(
  context: ExampleWorkerDriverContext,
  overrides: Readonly<Record<string, unknown>> = Object.freeze({})
): ExampleResult {
  return {
    schemaVersion: 1,
    id: context.input.id,
    durationMs: 4,
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    abortReason: null,
    cleanupFailures: [],
    childOwner: allowedEntry(context).childOwner,
    status: "passed",
    ...overrides
  } as ExampleResult
}

function coordinatorOptions(
  runner: Runner,
  identities: Map<number, ProcessIdentity>,
  workerDriver: NonNullable<ExamplesRunOptions["workerDriver"]> | undefined,
  backstops: BackstopObservation[] = [],
  overrides: Partial<ExamplesRunOptions> = Object.freeze({})
): ExamplesRunOptions {
  return {
    runner,
    currentIdentity: async () => RootIdentity,
    identityReader: async (pid) => {
      const identity = identities.get(pid)
      if (identity === undefined) throw new Error("fixture process is not live")
      return identity
    },
    dockerBackstop: async (_root, invocation, owners, deadline) => {
      backstops.push(
        Object.freeze({
          invocation,
          owners: Object.freeze(Array.from(owners).sort()),
          deadline
        })
      )
    },
    workerDriver,
    timeoutMs: 2_000,
    gracePeriodMs: 25,
    hardTerminationReserveMs: 25,
    dockerCleanupTimeoutMs: 25,
    pollIntervalMs: 1,
    workerDriverDrainMs: 100,
    ...overrides
  }
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>((resolveAbort) =>
    signal.addEventListener("abort", () => resolveAbort(), { once: true })
  )
}

async function runSuccessfulWorker(
  context: ExampleWorkerDriverContext,
  identities: Map<number, ProcessIdentity>,
  runner: DeferredRunner,
  offset: number,
  events: string[] = []
): Promise<RegistrationAck> {
  events.push(`participant:${context.input.id}`)
  await context.publishParticipant(participantFor(context, identities, offset))
  await context.publishRegistrationRequest()
  await context.waitForRegistration()
  events.push(`registration:${context.input.id}`)
  const ack = parseRegistrationAck(await context.waitForAck())
  events.push(`ack:${context.input.id}`)
  await context.publishResult(passedResultFor(context))
  events.push(`result:${context.input.id}`)
  runner.callFor(context).deferred.resolve(commandResult())
  events.push(`command-resolved:${context.input.id}`)
  return ack
}

test("owned supervisor preflight and close failures are both preserved", async () => {
  const fixture = await repositoryFixture(["alpha-service"])
  const primary = new Error("synthetic examples preflight failure")
  const cleanup = new Error("synthetic examples supervisor close failure")
  let preflightCalls = 0
  let closeCalls = 0
  let failure: unknown = null
  try {
    await runExamples(fixture.root, {
      createSupervisor: async () =>
        Object.freeze({
          mode: "managed" as const,
          async preflight() {
            preflightCalls += 1
            throw primary
          },
          async run() {
            throw new Error("runner must not start after preflight failure")
          },
          async close() {
            closeCalls += 1
            throw cleanup
          }
        })
    })
  } catch (error) {
    failure = error
  } finally {
    await removeTempDirectory(fixture.temp)
  }
  expect(preflightCalls).toBe(1)
  expect(closeCalls).toBe(1)
  expect(failure).toBeInstanceOf(AggregateError)
  expect((failure as AggregateError).errors).toEqual([primary, cleanup])
})

test("an external owner deadline bounds the command and Docker backstop without resetting budget", async () => {
  const fixture = await repositoryFixture(["alpha-service"])
  const identities = new Map<number, ProcessIdentity>()
  const runner = createDeferredRunner()
  const ownerStartedAt = 50_000
  const ownerDeadline = ownerStartedAt + 3_000
  let monotonic = ownerStartedAt
  let commandTimeout = 0
  let backstopDeadline = Number.POSITIVE_INFINITY
  try {
    const result = await runExamples(
      fixture.root,
      coordinatorOptions(
        runner.runner,
        identities,
        async (context) => {
          commandTimeout = context.command.timeoutMs
          monotonic = ownerStartedAt + 450
          await runSuccessfulWorker(context, identities, runner, 9)
        },
        [],
        {
          monotonicNow: () => monotonic,
          deadline: ownerDeadline,
          timeoutMs: 600,
          gracePeriodMs: 100,
          hardTerminationReserveMs: 100,
          dockerCleanupTimeoutMs: 100,
          dockerBackstop: async (_root, _invocation, _owners, deadline) => {
            backstopDeadline = deadline
          }
        }
      )
    )
    expect(result.status).toBe("passed")
    expect(commandTimeout).toBe(800)
    expect(backstopDeadline).toBe(ownerStartedAt + 550)
    expect(backstopDeadline).toBeLessThan(ownerDeadline)
    expect(backstopDeadline).not.toBe(monotonic + 3_000)
    expect(result.durationMs).toBe(450)
  } finally {
    await removeTempDirectory(fixture.temp)
  }
})

test("root coordinator dynamically runs the discovered set sequentially with durable ACK-before-result evidence", async () => {
  const fixture = await repositoryFixture(["zebra-service", "alpha-service"])
  const identities = new Map<number, ProcessIdentity>()
  const events: string[] = []
  const runner = createDeferredRunner()
  const backstops: BackstopObservation[] = []
  try {
    const result = await runExamples(
      fixture.root,
      coordinatorOptions(
        runner.runner,
        identities,
        async (context) => {
          expect(context.command.terminationPolicy).toBe("hard-only")
          expect(context.command.knownSecrets).toContain(context.nonce)
          expect(context.command.timeoutMs).toBeGreaterThan(
            context.command.terminationPolicy === "hard-only" ? 25 : 0
          )
          for (const name of ExampleInvocationDirectoryNames) {
            const metadata = await stat(resolve(context.paths.root, name))
            expect(metadata.mode & 0o777).toBe(0o700)
          }
          expect((await stat(context.paths.executionInput)).mode & 0o777).toBe(0o400)
          expect((await stat(context.paths.capability)).mode & 0o777).toBe(0o400)
          const ack = await runSuccessfulWorker(
            context,
            identities,
            runner,
            context.input.id === "alpha-service" ? 1 : 2,
            events
          )
          expect(ack.childOwner).toBe(allowedEntry(context).childOwner)
        },
        backstops
      )
    )

    expect(result.status).toBe("passed")
    expect(result.exitCode).toBe(0)
    expect(result.executionInputIds).toEqual(["alpha-service", "zebra-service"])
    expect(result.participantIds).toEqual(result.executionInputIds)
    expect(result.resultIds).toEqual(result.executionInputIds)
    expect(result.completedCommandIds).toEqual(result.executionInputIds)
    expect(result.completeness.missingParticipantIds).toEqual([])
    expect(result.completeness.missingResultIds).toEqual([])
    expect(result.examples.map((entry) => entry.classification)).toEqual(["passed", "passed"])
    expect(result.registeredChildOwners).toHaveLength(2)
    expect(new Set(backstops[0]?.owners)).toEqual(new Set(result.registeredChildOwners))

    expect(runner.calls).toHaveLength(2)
    for (const [index, id] of result.executionInputIds.entries()) {
      const call = runner.calls[index]
      const cwd = fixture.cwdById.get(id)
      if (call === undefined || cwd === undefined) throw new Error("missing command fixture")
      const capabilityPath = call.definition.command.at(-2)
      const nonce = call.definition.command.at(-1)
      if (capabilityPath === undefined || nonce === undefined) {
        throw new Error("missing command capability frame")
      }
      expect(call.definition.command).toEqual([
        "bun",
        "run",
        "--cwd",
        cwd,
        "test:e2e",
        "--",
        "--worker",
        capabilityPath,
        nonce
      ])
    }
    expect(events.indexOf("command-resolved:alpha-service")).toBeLessThan(
      events.indexOf("participant:zebra-service")
    )
    for (const id of result.executionInputIds) {
      expect(events.indexOf(`registration:${id}`)).toBeLessThan(events.indexOf(`ack:${id}`))
      expect(events.indexOf(`result:${id}`)).toBeLessThan(events.indexOf(`command-resolved:${id}`))
    }
  } finally {
    await removeTempDirectory(fixture.temp)
  }
})

test("pre-wrapper exit zero is classified wrapper-not-entered instead of passing", async () => {
  const fixture = await repositoryFixture(["alpha-service"])
  const identities = new Map<number, ProcessIdentity>()
  const runner: Runner = async () => commandResult()
  try {
    const result = await runExamples(
      fixture.root,
      coordinatorOptions(runner, identities, undefined)
    )
    expect(result.status).toBe("failed")
    expect(result.examples[0]?.classification).toBe("wrapper-not-entered")
    expect(result.completedCommandIds).toEqual(["alpha-service"])
    expect(result.participantIds).toEqual([])
    expect(result.failures.map((failure) => failure.code)).toContain("example-wrapper-not-entered")
  } finally {
    await removeTempDirectory(fixture.temp)
  }
})

test("a nonzero package command with no participant remains missing-participant and command failure", async () => {
  const fixture = await repositoryFixture(["alpha-service"])
  const identities = new Map<number, ProcessIdentity>()
  const runner: Runner = async () => commandResult({ exitCode: 17 })
  try {
    const result = await runExamples(
      fixture.root,
      coordinatorOptions(runner, identities, undefined)
    )
    expect(result.examples[0]?.classification).toBe("missing-participant")
    expect(result.completeness.missingParticipantIds).toEqual(["alpha-service"])
    expect(result.failures.map((failure) => failure.code)).toEqual(
      expect.arrayContaining(["example-missing-participant", "example-command-failed"])
    )
  } finally {
    await removeTempDirectory(fixture.temp)
  }
})

test("unexpected participant and result artifacts fail the dynamic differential", async () => {
  const fixture = await repositoryFixture(["alpha-service"])
  const identities = new Map<number, ProcessIdentity>()
  const runner = createDeferredRunner()
  try {
    const result = await runExamples(
      fixture.root,
      coordinatorOptions(runner.runner, identities, async (context) => {
        const expected = participantFor(context, identities, 3)
        await context.publishParticipant(
          {
            ...expected,
            id: "intruder",
            packageName: "@likego/example-intruder",
            cwdRealpath: join(fixture.root, "intruder")
          },
          "intruder.json"
        )
        await context.publishResult(
          {
            ...passedResultFor(context),
            id: "intruder",
            childOwner: "intruder-owner"
          },
          "intruder.json"
        )
        runner.callFor(context).deferred.resolve(commandResult())
      })
    )
    expect(result.participantIds).toEqual(["intruder"])
    expect(result.resultIds).toEqual(["intruder"])
    expect(result.completeness.unexpectedParticipantIds).toEqual(["intruder"])
    expect(result.completeness.unexpectedResultIds).toEqual(["intruder"])
    expect(result.failures.map((failure) => failure.code)).toEqual(
      expect.arrayContaining(["example-unexpected-participant", "example-unexpected-result"])
    )
  } finally {
    await removeTempDirectory(fixture.temp)
  }
})

test("final artifact scans reject crash-left canonical durable temporary components", async () => {
  const fixture = await repositoryFixture(["alpha-service"])
  const identities = new Map<number, ProcessIdentity>()
  const runner = createDeferredRunner()
  try {
    const result = await runExamples(
      fixture.root,
      coordinatorOptions(runner.runner, identities, async (context) => {
        await context.publishParticipant(participantFor(context, identities, 4))
        await context.publishRegistrationRequest()
        await context.waitForRegistration()
        await context.waitForAck()
        await context.publishResult(passedResultFor(context))
        const temporary = ".durable-123e4567-e89b-42d3-a456-426614174000.tmp"
        await writeFile(join(context.paths.participants, temporary), "incomplete\n", {
          flag: "wx",
          mode: 0o400
        })
        await writeFile(join(context.paths.results, temporary), "incomplete\n", {
          flag: "wx",
          mode: 0o400
        })
        runner.callFor(context).deferred.resolve(commandResult())
      })
    )
    expect(result.status).toBe("failed")
    expect(result.failures.map((failure) => failure.code)).toEqual(
      expect.arrayContaining(["example-participant-invalid", "example-result-invalid"])
    )
  } finally {
    await removeTempDirectory(fixture.temp)
  }
})

test("an expected result without a participant is classified result-without-participant", async () => {
  const fixture = await repositoryFixture(["alpha-service"])
  const identities = new Map<number, ProcessIdentity>()
  const runner = createDeferredRunner()
  try {
    const result = await runExamples(
      fixture.root,
      coordinatorOptions(runner.runner, identities, async (context) => {
        await context.publishResult(passedResultFor(context))
        runner.callFor(context).deferred.resolve(commandResult())
      })
    )
    expect(result.examples[0]?.classification).toBe("result-without-participant")
    expect(result.failures.map((failure) => failure.code)).toContain(
      "example-result-without-participant"
    )
  } finally {
    await removeTempDirectory(fixture.temp)
  }
})

test("before-registration cancellation sends no graceful control and registers no owner", async () => {
  const fixture = await repositoryFixture(["alpha-service"])
  const identities = new Map<number, ProcessIdentity>()
  const events: string[] = []
  const runner = createDeferredRunner(events)
  const controller = new AbortController()
  const backstops: BackstopObservation[] = []
  let gracefulFiles: readonly string[] = []
  try {
    const result = await runExamples(
      fixture.root,
      coordinatorOptions(
        runner.runner,
        identities,
        async (context) => {
          controller.abort(new Error("before registration cut"))
          await waitForAbort(context.signal)
          gracefulFiles = await readdir(context.paths.graceful)
        },
        backstops,
        { signal: controller.signal }
      )
    )
    expect(result.status).toBe("aborted")
    expect(result.examples[0]?.classification).toBe("missing-participant")
    expect(result.registeredChildOwners).toEqual([])
    expect(backstops[0]?.owners).toEqual([])
    expect(gracefulFiles).toEqual([])
    expect(runner.calls[0]?.definition.terminationPolicy).toBe("hard-only")
  } finally {
    await removeTempDirectory(fixture.temp)
  }
})

test("ACKed cancellation writes graceful exactly once, then hard-aborts before the registered-owner backstop", async () => {
  const fixture = await repositoryFixture(["alpha-service"])
  const identities = new Map<number, ProcessIdentity>()
  const events: string[] = []
  const runner = createDeferredRunner(events)
  const controller = new AbortController()
  const backstops: BackstopObservation[] = []
  let expectedOwner = ""
  let gracefulFileCount = 0
  try {
    const result = await runExamples(
      fixture.root,
      coordinatorOptions(
        runner.runner,
        identities,
        async (context) => {
          expectedOwner = allowedEntry(context).childOwner
          await context.publishParticipant(participantFor(context, identities, 4))
          await context.publishRegistrationRequest()
          await context.waitForRegistration()
          events.push("registration")
          await context.waitForAck()
          events.push("ack")
          controller.abort(new Error("after ACK before create cut"))
          const graceful = parseGracefulControl(await context.waitForGraceful())
          expect(graceful.childOwner).toBe(expectedOwner)
          events.push("graceful")
          gracefulFileCount = (await readdir(context.paths.graceful)).length
          await waitForAbort(context.signal)
          events.push("worker-observed-hard")
        },
        backstops,
        {
          signal: controller.signal,
          gracePeriodMs: 20,
          dockerBackstop: async (_root, invocation, owners) => {
            events.push("backstop")
            backstops.push(
              Object.freeze({ invocation, owners: Object.freeze(Array.from(owners).sort()) })
            )
          }
        }
      )
    )
    expect(result.status).toBe("aborted")
    expect(result.examples[0]?.classification).toBe("registered-but-unreported")
    expect(result.examples[0]?.acknowledged).toBe(true)
    expect(result.examples[0]?.gracefulRequested).toBe(true)
    expect(gracefulFileCount).toBe(1)
    expect(result.registeredChildOwners).toEqual([expectedOwner])
    expect(backstops[0]?.owners).toEqual([expectedOwner])
    expect(runner.calls[0]?.definition.terminationPolicy).toBe("hard-only")
    expect(events.indexOf("registration")).toBeLessThan(events.indexOf("ack"))
    expect(events.indexOf("ack")).toBeLessThan(events.indexOf("graceful"))
    expect(events.indexOf("graceful")).toBeLessThan(events.indexOf("hard:0"))
    expect(events.indexOf("hard:0")).toBeLessThan(events.indexOf("backstop"))
  } finally {
    await removeTempDirectory(fixture.temp)
  }
})

test("durable resource event cut reaches the registered-owner backstop after hard abort", async () => {
  if (process.platform === "win32") return
  const fixture = await repositoryFixture(["alpha-service"])
  const identities = new Map<number, ProcessIdentity>()
  const events: string[] = []
  const runner = createDeferredRunner(events)
  const controller = new AbortController()
  const ContainerId = "c".repeat(64)
  let expectedOwner = ""
  let observedEvent: ReturnType<typeof parseResourceEvent> | null = null
  let contextClosed = false
  try {
    const result = await runExamples(
      fixture.root,
      coordinatorOptions(
        runner.runner,
        identities,
        async (worker) => {
          const participant = participantFor(worker, identities, 8)
          expectedOwner = allowedEntry(worker).childOwner
          await worker.publishParticipant(participant)
          await worker.publishRegistrationRequest()
          await worker.waitForRegistration()
          const ack = parseRegistrationAck(await worker.waitForAck())
          events.push("ack")
          const authority: ScenarioDockerAuthority = {
            schemaVersion: 1,
            capabilityPath: worker.capabilityPath,
            capabilityDigest: worker.capabilityDigest,
            workerPid: participant.workerPid,
            workerStartIdentity: participant.workerStartIdentity,
            registrationAck: ack
          }
          const owned = await createOwnedDockerContext(authority, {
            identityReader: async (pid) => {
              if (pid === RootIdentity.pid) return RootIdentity
              const identity = identities.get(pid)
              if (identity === undefined) throw new Error("fixture process is not live")
              return identity
            },
            runner: async (_root, definition) => {
              expect(definition.command.slice(0, 3)).toEqual(["docker", "run", "--detach"])
              return commandResult({ stdout: `${ContainerId}\n` })
            },
            now: () => new Date(Timestamp),
            afterEvent: async (event) => {
              observedEvent = parseResourceEvent(event)
              events.push("resource-event")
              controller.abort(new Error("after resource event cut"))
              await waitForAbort(worker.signal)
            }
          })
          try {
            await createContainer(owned, ["synthetic@sha256:fixed"])
          } catch (error) {
            expect(error).toBeInstanceOf(Error)
          } finally {
            await closeOwnedDockerContext(owned)
            contextClosed = true
          }
        },
        [],
        {
          signal: controller.signal,
          gracePeriodMs: 20,
          dockerBackstop: async (_root, invocation, owners) => {
            events.push("backstop")
            const event = observedEvent
            if (event === null) throw new Error("resource event was not published before backstop")
            expect(invocation).toBe(event.invocation)
            expect(Array.from(owners)).toEqual([expectedOwner])
            expect(event).toMatchObject({
              resourceType: "container",
              resourceId: ContainerId,
              childOwner: expectedOwner
            })
          }
        }
      )
    )

    expect(result.status).toBe("aborted")
    expect(result.examples[0]?.classification).toBe("registered-but-unreported")
    expect(result.registeredChildOwners).toEqual([expectedOwner])
    expect(contextClosed).toBe(true)
    expect(events.indexOf("ack")).toBeLessThan(events.indexOf("resource-event"))
    expect(events.indexOf("resource-event")).toBeLessThan(events.indexOf("hard:0"))
    expect(events.indexOf("hard:0")).toBeLessThan(events.indexOf("backstop"))
  } finally {
    await removeTempDirectory(fixture.temp)
  }
})

test("result and package command disagreement is a protocol failure", async () => {
  const fixture = await repositoryFixture(["alpha-service"])
  const identities = new Map<number, ProcessIdentity>()
  const runner = createDeferredRunner()
  try {
    const result = await runExamples(
      fixture.root,
      coordinatorOptions(runner.runner, identities, async (context) => {
        await context.publishParticipant(participantFor(context, identities, 5))
        await context.publishRegistrationRequest()
        await context.waitForAck()
        await context.publishResult(passedResultFor(context))
        runner.callFor(context).deferred.resolve(commandResult({ exitCode: 23 }))
      })
    )
    expect(result.examples[0]?.classification).toBe("failed")
    expect(result.failures.map((failure) => failure.code)).toContain(
      "example-result-command-inconsistent"
    )
  } finally {
    await removeTempDirectory(fixture.temp)
  }
})

test("direct local root validates a standalone manifest, uses the worker command, and clears stale ambient authority", async () => {
  const fixture = await repositoryFixture([])
  const cwd = await standalonePackage(fixture.root, "standalone-service")
  const identities = new Map<number, ProcessIdentity>()
  const runner = createDeferredRunner()
  const previous = process.env.LIKEGO_E2E_STALE_CANARY
  process.env.LIKEGO_E2E_STALE_CANARY = "stale-secret"
  try {
    const result = await runSingleExampleLocalRoot(
      fixture.root,
      cwd,
      ["bun", "scenario.ts", "--case", "direct"],
      coordinatorOptions(runner.runner, identities, async (context) => {
        const command = runner.callFor(context).definition.command
        expect(command.slice(0, 3)).toEqual([
          "bun",
          resolve(fixture.root, "e2e/example-task.ts"),
          "--"
        ])
        expect(runner.callFor(context).definition.cwd).toBe(cwd)
        expect(command.slice(3, -3)).toEqual(["bun", "scenario.ts", "--case", "direct"])
        expect(command.at(-3)).toBe("--worker")
        expect(runner.callFor(context).definition.environment).toMatchObject({
          LIKEGO_E2E_STALE_CANARY: undefined,
          LIKEGO_E2E_CAPABILITY: undefined,
          LIKEGO_E2E_NONCE: undefined
        })
        await runSuccessfulWorker(context, identities, runner, 6)
      })
    )
    expect(result.status).toBe("passed")
    expect(result.executionInputIds).toEqual([basename(cwd)])
    expect(result.examples[0]?.classification).toBe("passed")
  } finally {
    if (previous === undefined) delete process.env.LIKEGO_E2E_STALE_CANARY
    else process.env.LIKEGO_E2E_STALE_CANARY = previous
    await removeTempDirectory(fixture.temp)
  }
})

test("aggregate diagnostics redact nonce and authenticated ACK material", async () => {
  const fixture = await repositoryFixture(["alpha-service"])
  const identities = new Map<number, ProcessIdentity>()
  const runner = createDeferredRunner()
  let nonce = ""
  let ackToken = ""
  try {
    const result = await runExamples(
      fixture.root,
      coordinatorOptions(runner.runner, identities, async (context) => {
        nonce = context.nonce
        await context.publishParticipant(participantFor(context, identities, 7))
        await context.publishRegistrationRequest()
        ackToken = parseRegistrationAck(await context.waitForAck()).ackToken
        await context.publishResult(passedResultFor(context))
        runner
          .callFor(context)
          .deferred.resolve(
            commandResult({ stdout: `nonce=${nonce}\n`, stderr: `ackToken=${ackToken}\n` })
          )
      })
    )
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(nonce)
    expect(serialized).not.toContain(ackToken)
    expect(`${result.stdout}${result.stderr}`).toContain("<redacted>")
  } finally {
    await removeTempDirectory(fixture.temp)
  }
})
