import { constants } from "node:fs"
import { open, readdir, realpath } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { setTimeout as sleepTimer } from "node:timers/promises"

import {
  boundedTail,
  createStreamingRedactor,
  errorSummary,
  extractSensitiveValues,
  redactText
} from "./harness/diagnostics"
import {
  applyDockerEnvironment,
  digestDockerEnvironment,
  snapshotDockerEnvironment,
  withDockerEnvironment,
  type DockerEnvironmentSnapshot
} from "./harness/docker-environment"
import {
  closeDurableJsonDirectory,
  isDurableJsonTemporaryComponent,
  openDurableJsonDirectory,
  readDurableJson,
  writeDurableJson,
  type DurableJsonDirectory
} from "./harness/durable-json"
import {
  assertInvocationRootIdentity,
  createProtocolReplayGuard,
  currentProcessIdentity,
  digestInvocationCapability,
  generateRequestId,
  parseExampleResult,
  parseInvocationCapability,
  parseResourceEvent,
  parseTerminalWorkerFrame,
  verifyGracefulControl,
  verifyInvocationNonce,
  verifyRegistrationAck,
  type AllowedExampleEntry,
  type AuthenticatedControlBinding,
  type ExampleResult,
  type InvocationCapability,
  type ProcessIdentity,
  type RegistrationAck,
  type WorkerExampleInvocation
} from "./harness/example-protocol"
import { cleanupDockerPair } from "./harness/docker-pairs"
import { runCommand, type ProcessSupervisor } from "./harness/process"
import { failureRecord, type FailureRecord } from "./harness/result"
import {
  authorityToEnvironment,
  OwnedDockerEnvironmentKey,
  type ScenarioDockerAuthority
} from "./harness/owned-docker"

export interface ExampleTaskClock {
  readonly now: () => number
  readonly date: () => Date
  readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>
}

export interface ExampleTaskChildResult {
  readonly exitCode: number | null
  readonly signal: string | null
  readonly timedOut: boolean
  readonly aborted: boolean
  readonly abortReason: string | null
  readonly durationMs: number
  readonly cleanupFailures: readonly FailureRecord[]
}

export interface ExampleTaskChild {
  readonly stdout: ReadableStream<Uint8Array> | null
  readonly stderr: ReadableStream<Uint8Array> | null
  readonly settled: Promise<ExampleTaskChildResult>
  readonly kill: (signal: "SIGTERM") => void
}

export interface ExampleTaskSpawnOptions {
  readonly cwd: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly detached: false
}

export interface ExampleTaskRootOutcome {
  readonly status: "passed" | "failed" | "timed-out" | "aborted"
}

export type ExampleTaskWorkerCutPoint = "before-registration" | "after-ack-before-scenario"

export interface ExampleTaskOptions {
  readonly signal?: AbortSignal | undefined
  readonly clock?: ExampleTaskClock | undefined
  readonly pollIntervalMs?: number | undefined
  readonly registrationTimeoutMs?: number | undefined
  readonly gracefulPollTimeoutMs?: number | undefined
  readonly cleanupTimeoutMs?: number | undefined
  readonly maximumCapturedCharacters?: number | undefined
  readonly spawn?:
    | ((argv: readonly string[], options: ExampleTaskSpawnOptions) => ExampleTaskChild)
    | undefined
  readonly currentIdentity?: (() => Promise<ProcessIdentity>) | undefined
  readonly assertRootIdentity?:
    | ((capability: InvocationCapability) => Promise<ProcessIdentity>)
    | undefined
  readonly cleanupDocker?:
    | ((
        cwd: string,
        invocation: string,
        owner: string,
        deadline: number,
        runner?: ProcessSupervisor["run"]
      ) => Promise<void>)
    | undefined
  readonly forwardStdout?: ((value: string) => void) | undefined
  readonly forwardStderr?: ((value: string) => void) | undefined
  readonly readPackageName?: ((cwd: string) => Promise<string>) | undefined
  readonly runLocalRoot?:
    | ((input: {
        readonly cwd: string
        readonly scenarioArgv: readonly string[]
        readonly signal?: AbortSignal | undefined
      }) => Promise<ExampleTaskRootOutcome>)
    | undefined
  /** Test-only seam immediately before durable participant publication. */
  readonly beforeParticipantPublished?: (() => void | Promise<void>) | undefined
  /** Test-only seam after authenticated ACK and before scenario authority/spawn. */
  readonly afterAckBeforeScenario?: (() => void | Promise<void>) | undefined
  /** Injectable only to observe authenticated pre-scenario SIGKILL cut points. */
  readonly killWorkerAtCutPoint?: ((cutPoint: ExampleTaskWorkerCutPoint) => never) | undefined
  readonly onParticipantPublished?: (() => void | Promise<void>) | undefined
  readonly onResultPublished?: ((result: ExampleResult) => void | Promise<void>) | undefined
  /** Injectable only for the authenticated real-resource crash gate. */
  readonly killWorkerAfterFirstResource?: (() => never) | undefined
}

interface InvocationDirectories {
  readonly invocation: DurableJsonDirectory
  readonly participants: DurableJsonDirectory
  readonly registrations: DurableJsonDirectory
  readonly acks: DurableJsonDirectory
  readonly results: DurableJsonDirectory
  readonly graceful: DurableJsonDirectory
  readonly resources: DurableJsonDirectory
}

interface ChildStreams {
  readonly stdout: Promise<string>
  readonly stderr: Promise<string>
}

interface ResolvedExampleTaskOptions {
  readonly signal?: AbortSignal | undefined
  readonly clock: ExampleTaskClock
  readonly pollIntervalMs: number
  readonly registrationTimeoutMs: number
  readonly gracefulPollTimeoutMs: number
  readonly cleanupTimeoutMs: number
  readonly maximumCapturedCharacters: number
  readonly spawn: (argv: readonly string[], options: ExampleTaskSpawnOptions) => ExampleTaskChild
  readonly currentIdentity: () => Promise<ProcessIdentity>
  readonly assertRootIdentity: (capability: InvocationCapability) => Promise<ProcessIdentity>
  readonly cleanupDocker: (
    cwd: string,
    invocation: string,
    owner: string,
    deadline: number,
    runner?: ProcessSupervisor["run"]
  ) => Promise<void>
  readonly forwardStdout: (value: string) => void
  readonly forwardStderr: (value: string) => void
  readonly readPackageName: (cwd: string) => Promise<string>
  readonly beforeParticipantPublished?: (() => void | Promise<void>) | undefined
  readonly afterAckBeforeScenario?: (() => void | Promise<void>) | undefined
  readonly killWorkerAtCutPoint: (cutPoint: ExampleTaskWorkerCutPoint) => never
  readonly onParticipantPublished?: (() => void | Promise<void>) | undefined
  readonly onResultPublished?: ((result: ExampleResult) => void | Promise<void>) | undefined
  readonly killWorkerAfterFirstResource: () => never
}

interface WorkerFailure extends Error {
  readonly workerFailureCode?: string | undefined
  readonly workerFailureCategory?: FailureRecord["category"] | undefined
}

const DefaultPollIntervalMs = 25
const DefaultRegistrationTimeoutMs = 30_000
const DefaultGracefulPollTimeoutMs = 24 * 60 * 60 * 1_000
const DefaultCleanupTimeoutMs = 60_000
const DefaultMaximumCapturedCharacters = 8_192
const SiblingNames = Object.freeze([
  "participants",
  "registrations",
  "acks",
  "results",
  "graceful",
  "resources"
] as const)
const LegacyOwnerEnvironmentKey = "GO_LIKE_E2E_OWNER"
const StaleCapabilityEnvironmentPrefix = "GO_LIKE_E2E_"
const EmptyOptions = Object.freeze({})
const Utf8Decoder = new TextDecoder("utf-8", { fatal: true })

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const selected = value ?? fallback
  if (!Number.isSafeInteger(selected) || selected < 1) {
    throw new RangeError(`${label} must be a positive safe integer`)
  }
  return selected
}

function defaultClock(): ExampleTaskClock {
  return Object.freeze({
    now: () => performance.now(),
    date: () => new Date(),
    sleep: async (milliseconds: number, signal?: AbortSignal) => {
      try {
        await sleepTimer(milliseconds, undefined, { signal })
      } catch (error) {
        if (signal?.aborted !== true) throw error
      }
    }
  })
}

function killCurrentWorker(cutPoint: string): never {
  process.kill(process.pid, "SIGKILL")
  throw new Error(`${cutPoint} crash hook did not terminate the process`)
}

function defaultKillWorkerAtCutPoint(cutPoint: ExampleTaskWorkerCutPoint): never {
  return killCurrentWorker(`authenticated ${cutPoint} worker`)
}

function defaultKillWorkerAfterFirstResource(): never {
  return killCurrentWorker("authenticated first-resource worker")
}

function workerError(
  code: string,
  category: FailureRecord["category"],
  summary: string
): WorkerFailure {
  return Object.assign(new Error(summary), {
    workerFailureCode: code,
    workerFailureCategory: category
  })
}

function errorCode(value: unknown): string | null {
  if (value === null || typeof value !== "object" || !("code" in value)) return null
  return typeof value.code === "string" ? value.code : null
}

function noFollowReadFlags(): number {
  const noFollow = Reflect.get(constants, "O_NOFOLLOW")
  if (typeof noFollow !== "number") {
    throw workerError(
      "capability-unsupported",
      "prerequisite",
      "worker capability requires no-follow file opens"
    )
  }
  const closeOnExec = Reflect.get(constants, "O_CLOEXEC")
  return constants.O_RDONLY | noFollow | (typeof closeOnExec === "number" ? closeOnExec : 0)
}

async function readCapability(path: string): Promise<InvocationCapability> {
  if (basename(path) !== "capability.json") {
    throw workerError("capability-invalid", "security", "worker capability path is invalid")
  }
  let directory: DurableJsonDirectory | null = null
  try {
    directory = await openDurableJsonDirectory(dirname(path))
    return parseInvocationCapability(await readDurableJson(directory, "capability.json"))
  } catch {
    throw workerError(
      "capability-invalid",
      "security",
      "worker capability could not be read safely"
    )
  } finally {
    await (directory === null ? Promise.resolve() : closeDurableJsonDirectory(directory)).catch(
      () => {}
    )
  }
}

async function manifestPackageName(cwd: string): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(join(cwd, "package.json"), noFollowReadFlags())
    const metadata = await handle.stat()
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > 1024 * 1024) {
      throw new Error("invalid manifest")
    }
    const bytes = new Uint8Array(metadata.size)
    let offset = 0
    while (offset < bytes.byteLength) {
      const observed = await handle.read(bytes, offset, bytes.byteLength - offset, offset)
      if (observed.bytesRead === 0) break
      offset += observed.bytesRead
    }
    if (offset !== bytes.byteLength) throw new Error("manifest changed while reading")
    const value: unknown = JSON.parse(Utf8Decoder.decode(bytes))
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("manifest root is invalid")
    }
    const name = Reflect.get(value, "name")
    if (typeof name !== "string") throw new Error("manifest name is invalid")
    return name
  } catch {
    throw workerError(
      "package-invalid",
      "security",
      "current package identity could not be read safely"
    )
  } finally {
    await handle?.close().catch(() => {})
  }
}

function expectedCapabilityPath(frame: WorkerExampleInvocation): string {
  const invocation = dirname(frame.capabilityPath)
  if (basename(frame.capabilityPath) !== "capability.json" || resolve(invocation) !== invocation) {
    throw workerError(
      "capability-layout-invalid",
      "security",
      "worker capability path does not match the fixed invocation layout"
    )
  }
  return invocation
}

function packageEntry(
  capability: InvocationCapability,
  cwd: string,
  packageName: string
): AllowedExampleEntry {
  const matches = capability.allowedExamples.filter(
    (entry) => entry.cwdRealpath === cwd && entry.packageName === packageName
  )
  const entry = matches[0]
  if (
    matches.length !== 1 ||
    entry === undefined ||
    basename(cwd) !== entry.id ||
    packageName !== `@go-like/example-${entry.id}`
  ) {
    throw workerError(
      "example-not-authorized",
      "security",
      "current cwd and package do not match one exact capability entry"
    )
  }
  return entry
}

async function canonicalInvocationRoot(
  frame: WorkerExampleInvocation,
  capability: InvocationCapability
): Promise<string> {
  const expected = expectedCapabilityPath(frame)
  let capabilityCanonical: string
  let resultCanonical: string
  let invocationCanonical: string
  try {
    ;[capabilityCanonical, resultCanonical, invocationCanonical] = await Promise.all([
      realpath(frame.capabilityPath),
      realpath(capability.resultDirRealpath),
      realpath(expected)
    ])
  } catch {
    throw workerError(
      "capability-layout-invalid",
      "security",
      "worker invocation layout is unavailable"
    )
  }
  if (
    capabilityCanonical !== frame.capabilityPath ||
    resultCanonical !== capability.resultDirRealpath ||
    invocationCanonical !== expected ||
    resultCanonical !== invocationCanonical
  ) {
    throw workerError(
      "capability-layout-invalid",
      "security",
      "worker capability and result root do not identify the same canonical invocation"
    )
  }
  return invocationCanonical
}

async function openInvocationDirectories(root: string): Promise<InvocationDirectories> {
  const opened: DurableJsonDirectory[] = []
  try {
    const invocation = await openDurableJsonDirectory(root)
    opened.push(invocation)
    const siblings = await Promise.all(
      SiblingNames.map(async (name) => {
        const path = join(root, name)
        const directory = await openDurableJsonDirectory(path, {
          containedRoot: root
        })
        opened.push(directory)
        return directory
      })
    )
    const [participants, registrations, acks, results, graceful, resources] = siblings
    if (
      participants === undefined ||
      registrations === undefined ||
      acks === undefined ||
      results === undefined ||
      graceful === undefined ||
      resources === undefined
    ) {
      throw new Error("worker invocation control directories are incomplete")
    }
    return Object.freeze({
      invocation,
      participants,
      registrations,
      acks,
      results,
      graceful,
      resources
    })
  } catch (error) {
    await Promise.allSettled(opened.reverse().map(closeDurableJsonDirectory))
    if ((error as WorkerFailure).workerFailureCode !== undefined) throw error
    throw workerError(
      "invocation-directory-invalid",
      "security",
      "worker invocation control directories are invalid"
    )
  }
}

async function closeInvocationDirectories(directories: InvocationDirectories): Promise<void> {
  const settlements = await Promise.allSettled([
    closeDurableJsonDirectory(directories.resources),
    closeDurableJsonDirectory(directories.graceful),
    closeDurableJsonDirectory(directories.results),
    closeDurableJsonDirectory(directories.acks),
    closeDurableJsonDirectory(directories.registrations),
    closeDurableJsonDirectory(directories.participants),
    closeDurableJsonDirectory(directories.invocation)
  ])
  const failures = settlements.flatMap((settlement) =>
    settlement.status === "rejected" ? [settlement.reason] : []
  )
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) {
    throw new AggregateError(failures, "worker invocation directory close failed")
  }
}

function sameRootIdentity(observed: ProcessIdentity, capability: InvocationCapability): boolean {
  return (
    observed.pid === capability.rootPid &&
    observed.startIdentity === capability.rootStartIdentity &&
    observed.principal === capability.rootPrincipal
  )
}

async function assertRootLive(
  capability: InvocationCapability,
  check: (value: InvocationCapability) => Promise<ProcessIdentity>
): Promise<void> {
  let observed: ProcessIdentity
  try {
    observed = await check(capability)
  } catch {
    throw workerError(
      "root-identity-expired",
      "security",
      "invocation root process identity is unavailable or changed"
    )
  }
  if (!sameRootIdentity(observed, capability)) {
    throw workerError(
      "root-identity-expired",
      "security",
      "invocation root process identity is unavailable or changed"
    )
  }
}

function environmentForAuthority(
  ambient: Readonly<Record<string, string | undefined>>,
  authority: ScenarioDockerAuthority,
  dockerEnvironment: DockerEnvironmentSnapshot
): Readonly<Record<string, string | undefined>> {
  const environment: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(ambient)) {
    if (
      key === LegacyOwnerEnvironmentKey ||
      (key.startsWith(StaleCapabilityEnvironmentPrefix) && key !== OwnedDockerEnvironmentKey)
    ) {
      continue
    }
    environment[key] = value
  }
  Object.assign(environment, applyDockerEnvironment(dockerEnvironment, environment))
  Object.assign(environment, authorityToEnvironment(authority))
  return Object.freeze(environment)
}

function defaultSpawn(argv: readonly string[], options: ExampleTaskSpawnOptions): ExampleTaskChild {
  const startedAt = performance.now()
  const child = Bun.spawn(argv.slice(), {
    cwd: options.cwd,
    env: options.env,
    detached: false,
    stdout: "pipe",
    stderr: "pipe"
  })
  return Object.freeze({
    stdout: child.stdout,
    stderr: child.stderr,
    settled: child.exited.then((exitCode) =>
      Object.freeze({
        exitCode: child.signalCode === null ? exitCode : null,
        signal: child.signalCode,
        timedOut: false,
        aborted: false,
        abortReason: null,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        cleanupFailures: Object.freeze([])
      })
    ),
    kill(signal: "SIGTERM"): void {
      child.kill(signal)
    }
  })
}

async function captureStream(
  stream: ReadableStream<Uint8Array> | null,
  secrets: readonly string[],
  maximumCharacters: number,
  forward: (value: string) => void
): Promise<string> {
  if (stream === null) return ""
  const reader = stream.getReader()
  const redactor = createStreamingRedactor({ knownSecrets: secrets })
  let captured = ""
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      const safe = redactor.write(chunk.value)
      if (safe.length > 0) {
        forward(safe)
        captured = boundedTail(captured + safe, maximumCharacters)
      }
    }
    const safe = redactor.end()
    if (safe.length > 0) {
      forward(safe)
      captured = boundedTail(captured + safe, maximumCharacters)
    }
    return captured
  } finally {
    reader.releaseLock()
  }
}

function component(id: string): string {
  return `${id}.json`
}

function isMissingFile(error: unknown): boolean {
  return (
    errorCode(error) === "ENOENT" ||
    (error instanceof Error && error.message.includes("could not be opened without following"))
  )
}

async function readIfPublished(
  directory: DurableJsonDirectory,
  name: string
): Promise<unknown | null> {
  try {
    return await readDurableJson(directory, name)
  } catch (error) {
    if (isMissingFile(error)) return null
    throw error
  }
}

async function waitForAck(
  directories: InvocationDirectories,
  capability: InvocationCapability,
  frame: WorkerExampleInvocation,
  bindingBase: Omit<AuthenticatedControlBinding, "requestId">,
  registrationRequestId: string,
  clock: ExampleTaskClock,
  pollIntervalMs: number,
  timeoutMs: number,
  assertRoot: (value: InvocationCapability) => Promise<ProcessIdentity>,
  suppliedAck?: (() => Promise<unknown>) | undefined
): Promise<{
  readonly ack: RegistrationAck
  readonly binding: AuthenticatedControlBinding
}> {
  const deadline = clock.now() + timeoutMs
  const guard = createProtocolReplayGuard()
  while (clock.now() < deadline) {
    await assertRootLive(capability, assertRoot)
    const value =
      suppliedAck === undefined
        ? await readIfPublished(directories.acks, component(bindingBase.id))
        : await suppliedAck()
    if (value !== null) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw workerError("registration-ack-invalid", "security", "registration ACK is invalid")
      }
      const requestId = Reflect.get(value, "requestId")
      if (typeof requestId !== "string" || requestId !== registrationRequestId) {
        throw workerError("registration-ack-invalid", "security", "registration ACK is invalid")
      }
      const binding = Object.freeze({ ...bindingBase, requestId })
      try {
        return Object.freeze({
          ack: verifyRegistrationAck(value, frame.nonce, binding, guard),
          binding
        })
      } catch {
        throw workerError(
          "registration-ack-invalid",
          "security",
          "registration ACK authentication failed"
        )
      }
    }
    await clock.sleep(Math.min(pollIntervalMs, Math.max(1, deadline - clock.now())))
  }
  throw workerError(
    "registration-ack-timeout",
    "security",
    "registration ACK was not received inside the bounded wait"
  )
}

function addFailure(
  failures: FailureRecord[],
  code: string,
  category: FailureRecord["category"],
  value: unknown,
  secrets: readonly string[]
): void {
  if (failures.length >= 64) return
  failures.push(
    failureRecord(code, category, errorSummary(value, { knownSecrets: secrets }, 2_048))
  )
}

function primaryFailure(value: unknown, secrets: readonly string[]): FailureRecord {
  const candidate = value as WorkerFailure
  return failureRecord(
    candidate.workerFailureCode ?? "example-worker-failed",
    candidate.workerFailureCategory ?? "primary",
    errorSummary(value, { knownSecrets: secrets }, 2_048)
  )
}

function sanitizedFailureRecord(value: FailureRecord, secrets: readonly string[]): FailureRecord {
  return failureRecord(
    value.code,
    value.category,
    boundedTail(redactText(value.summary, { knownSecrets: secrets }), 2_048)
  )
}

function resultStatus(
  child: ExampleTaskChildResult | null,
  primary: FailureRecord | null,
  cleanupFailures: readonly FailureRecord[],
  abortedByWorker: boolean
): ExampleResult["status"] {
  if (child?.timedOut === true) return "timed-out"
  if (child?.aborted === true || abortedByWorker) return "aborted"
  if (
    primary === null &&
    child !== null &&
    child.exitCode === 0 &&
    child.signal === null &&
    cleanupFailures.length === 0
  ) {
    return "passed"
  }
  return "failed"
}

function resultRecord(
  entry: AllowedExampleEntry,
  startedAt: number,
  clock: ExampleTaskClock,
  child: ExampleTaskChildResult | null,
  primary: FailureRecord | null,
  cleanupFailures: readonly FailureRecord[],
  abortedByWorker: boolean,
  abortReason: string | null
): ExampleResult {
  const allCleanup = [
    ...(primary === null ? [] : [primary]),
    ...(child?.cleanupFailures ?? []),
    ...cleanupFailures
  ].slice(0, 64)
  const status = resultStatus(child, primary, allCleanup, abortedByWorker)
  const aborted = status === "aborted"
  return parseExampleResult({
    schemaVersion: 1,
    id: entry.id,
    durationMs: child?.durationMs ?? Math.max(0, Math.round(clock.now() - startedAt)),
    exitCode: child?.exitCode ?? null,
    signal: child?.signal ?? null,
    timedOut: status === "timed-out",
    aborted,
    abortReason: aborted ? (child?.abortReason ?? abortReason ?? "worker interrupted") : null,
    cleanupFailures: allCleanup,
    childOwner: entry.childOwner,
    status
  })
}

async function observeGraceful(
  child: ExampleTaskChild,
  directories: InvocationDirectories,
  capability: InvocationCapability,
  frame: WorkerExampleInvocation,
  bindingBase: Omit<AuthenticatedControlBinding, "requestId">,
  ackRequestId: string,
  clock: ExampleTaskClock,
  pollIntervalMs: number,
  timeoutMs: number,
  assertRoot: (value: InvocationCapability) => Promise<ProcessIdentity>,
  signal?: AbortSignal,
  suppliedGraceful?: (() => Promise<unknown>) | undefined
): Promise<void> {
  const deadline = clock.now() + timeoutMs
  const guard = createProtocolReplayGuard()
  let signalHandled = false
  const requestSignal = (): void => {
    if (signalHandled) return
    signalHandled = true
    child.kill("SIGTERM")
  }
  const onAbort = (): void => requestSignal()
  signal?.addEventListener("abort", onAbort, { once: true })
  if (signal?.aborted === true) requestSignal()
  try {
    while (clock.now() < deadline) {
      if (signal?.aborted === true) throw signal.reason
      await assertRootLive(capability, assertRoot)
      const value =
        suppliedGraceful === undefined
          ? await readIfPublished(directories.graceful, component(bindingBase.id))
          : await suppliedGraceful()
      if (value !== null) {
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          throw workerError("graceful-invalid", "security", "graceful control is invalid")
        }
        const requestId = Reflect.get(value, "requestId")
        if (typeof requestId !== "string") {
          throw workerError("graceful-invalid", "security", "graceful control is invalid")
        }
        if (requestId === ackRequestId) {
          throw workerError("graceful-replay", "security", "graceful control reused an ACK request")
        }
        const binding = Object.freeze({ ...bindingBase, requestId })
        try {
          verifyGracefulControl(value, frame.nonce, binding, guard)
          requestSignal()
        } catch (error) {
          if (signalHandled && error instanceof Error && error.message.includes("replay")) {
            await clock.sleep(Math.min(pollIntervalMs, Math.max(1, deadline - clock.now())), signal)
            continue
          }
          throw workerError(
            "graceful-invalid",
            "security",
            "graceful control authentication failed"
          )
        }
      }
      await clock.sleep(Math.min(pollIntervalMs, Math.max(1, deadline - clock.now())), signal)
    }
  } finally {
    signal?.removeEventListener("abort", onAbort)
  }
}

type ResourceEventObservation = "absent" | "current" | "publication-in-progress"

async function observeResourceEvents(
  directory: DurableJsonDirectory,
  invocationRoot: string,
  capability: InvocationCapability,
  entry: AllowedExampleEntry
): Promise<ResourceEventObservation> {
  const allowed = new Map(capability.allowedExamples.map((candidate) => [candidate.id, candidate]))
  const names = await readdir(join(invocationRoot, "resources"))
  let publicationInProgress = false
  for (const name of names) {
    if (isDurableJsonTemporaryComponent(name)) {
      publicationInProgress = true
      continue
    }
    if (!name.endsWith(".json")) {
      throw workerError(
        "resource-event-invalid",
        "security",
        "worker resource directory contains an unexpected component"
      )
    }
  }
  if (publicationInProgress) return "publication-in-progress"

  let current = false
  for (const name of names) {
    let event: ReturnType<typeof parseResourceEvent>
    try {
      event = parseResourceEvent(await readDurableJson(directory, name))
    } catch {
      throw workerError("resource-event-invalid", "security", "worker resource event is invalid")
    }
    const expected = allowed.get(event.id)
    if (
      expected === undefined ||
      event.invocation !== capability.invocation ||
      event.childOwner !== expected.childOwner
    ) {
      throw workerError(
        "resource-event-invalid",
        "security",
        "worker resource event does not match the invocation capability"
      )
    }
    if (event.id === entry.id) current = true
  }
  return current ? "current" : "absent"
}

async function observeFirstResourceEvent(
  directory: DurableJsonDirectory,
  invocationRoot: string,
  capability: InvocationCapability,
  entry: AllowedExampleEntry,
  clock: ExampleTaskClock,
  pollIntervalMs: number,
  assertRoot: (value: InvocationCapability) => Promise<ProcessIdentity>,
  killWorker: () => never,
  signal: AbortSignal
): Promise<void> {
  for (;;) {
    if (signal.aborted) return
    await assertRootLive(capability, assertRoot)
    if (signal.aborted) return
    const observation = await observeResourceEvents(directory, invocationRoot, capability, entry)
    if (signal.aborted) return
    if (observation === "current") killWorker()
    await clock.sleep(pollIntervalMs, signal)
  }
}

function resolveWorkerOptions(options: ExampleTaskOptions): ResolvedExampleTaskOptions {
  return Object.freeze({
    signal: options.signal,
    clock: options.clock ?? defaultClock(),
    pollIntervalMs: positiveInteger(
      options.pollIntervalMs,
      DefaultPollIntervalMs,
      "worker poll interval"
    ),
    registrationTimeoutMs: positiveInteger(
      options.registrationTimeoutMs,
      DefaultRegistrationTimeoutMs,
      "worker registration timeout"
    ),
    gracefulPollTimeoutMs: positiveInteger(
      options.gracefulPollTimeoutMs,
      DefaultGracefulPollTimeoutMs,
      "worker graceful poll timeout"
    ),
    cleanupTimeoutMs: positiveInteger(
      options.cleanupTimeoutMs,
      DefaultCleanupTimeoutMs,
      "worker cleanup timeout"
    ),
    maximumCapturedCharacters: positiveInteger(
      options.maximumCapturedCharacters,
      DefaultMaximumCapturedCharacters,
      "worker capture bound"
    ),
    spawn: options.spawn ?? defaultSpawn,
    currentIdentity: options.currentIdentity ?? currentProcessIdentity,
    assertRootIdentity: options.assertRootIdentity ?? assertInvocationRootIdentity,
    cleanupDocker: options.cleanupDocker ?? cleanupDockerPair,
    forwardStdout: options.forwardStdout ?? ((value) => process.stdout.write(value)),
    forwardStderr: options.forwardStderr ?? ((value) => process.stderr.write(value)),
    readPackageName: options.readPackageName ?? manifestPackageName,
    beforeParticipantPublished: options.beforeParticipantPublished,
    afterAckBeforeScenario: options.afterAckBeforeScenario,
    killWorkerAtCutPoint: options.killWorkerAtCutPoint ?? defaultKillWorkerAtCutPoint,
    onParticipantPublished: options.onParticipantPublished,
    onResultPublished: options.onResultPublished,
    killWorkerAfterFirstResource:
      options.killWorkerAfterFirstResource ?? defaultKillWorkerAfterFirstResource
  })
}

async function runWorker(
  frame: WorkerExampleInvocation,
  cwd: string,
  selectedOptions: ExampleTaskOptions
): Promise<ExampleResult> {
  const options = resolveWorkerOptions(selectedOptions)
  const clock = options.clock
  const pollIntervalMs = options.pollIntervalMs
  const registrationTimeoutMs = options.registrationTimeoutMs
  const gracefulPollTimeoutMs = options.gracefulPollTimeoutMs
  const cleanupTimeoutMs = options.cleanupTimeoutMs
  const maximumCapturedCharacters = options.maximumCapturedCharacters
  const canonicalCwd = await realpath(resolve(cwd))
  if (canonicalCwd !== resolve(cwd)) {
    throw workerError("cwd-invalid", "security", "worker cwd must be canonical")
  }
  const capability = await readCapability(frame.capabilityPath)
  if (!verifyInvocationNonce(frame.nonce, capability.nonceDigest)) {
    throw workerError("nonce-invalid", "security", "worker invocation nonce authentication failed")
  }
  const invocationRoot = await canonicalInvocationRoot(frame, capability)
  await assertRootLive(capability, options.assertRootIdentity)
  const packageName = await options.readPackageName(canonicalCwd)
  const entry = packageEntry(capability, canonicalCwd, packageName)
  const identity = await options.currentIdentity()
  const dockerEnvironment = snapshotDockerEnvironment()
  if (digestDockerEnvironment(dockerEnvironment) !== capability.dockerEnvironmentDigest) {
    throw workerError(
      "docker-environment-invalid",
      "security",
      "worker Docker environment does not match the invocation capability"
    )
  }
  if (identity.pid !== process.pid || identity.principal !== capability.rootPrincipal) {
    throw workerError("worker-identity-invalid", "security", "worker process identity is invalid")
  }

  let directories: InvocationDirectories | null = null
  let scenarioStartAttempted = false
  let child: ExampleTaskChild | null = null
  let childResult: ExampleTaskChildResult | null = null
  let primary: FailureRecord | null = null
  const cleanupFailures: FailureRecord[] = []
  let result: ExampleResult | null = null
  let resultWritten = false
  let knownSecrets: readonly string[] = Object.freeze([frame.nonce])
  const startedAt = clock.now()
  try {
    directories = await openInvocationDirectories(invocationRoot)
    const participant = Object.freeze({
      schemaVersion: 1 as const,
      id: entry.id,
      packageName: entry.packageName,
      cwdRealpath: entry.cwdRealpath,
      workerPid: identity.pid,
      workerStartIdentity: identity.startIdentity,
      childOwner: entry.childOwner,
      parentInvocation: capability.invocation,
      startedAt: clock.date().toISOString()
    })
    await options.beforeParticipantPublished?.()
    if (capability.resourceEventTestHook === "kill-worker-before-registration") {
      options.killWorkerAtCutPoint("before-registration")
    }
    await writeDurableJson(directories.participants, component(entry.id), participant, {
      readOnly: true
    })
    await options.onParticipantPublished?.()

    const capabilityDigest = digestInvocationCapability(capability)
    const registrationRequestId = generateRequestId()
    const bindingBase = Object.freeze({
      invocation: capability.invocation,
      capabilityDigest,
      id: entry.id,
      workerPid: identity.pid,
      workerStartIdentity: identity.startIdentity,
      childOwner: entry.childOwner
    })
    await writeDurableJson(
      directories.registrations,
      component(entry.id),
      { requestId: registrationRequestId },
      { readOnly: true }
    )
    const { ack } = await waitForAck(
      directories,
      capability,
      frame,
      bindingBase,
      registrationRequestId,
      clock,
      pollIntervalMs,
      registrationTimeoutMs,
      options.assertRootIdentity
    )
    await options.afterAckBeforeScenario?.()
    if (capability.resourceEventTestHook === "kill-worker-after-ack-before-scenario") {
      options.killWorkerAtCutPoint("after-ack-before-scenario")
    }
    // Reopen every control directory from the retained secure temp root immediately before
    // granting scenario authority. A replaced path fails before the child can be spawned.
    const previousDirectories = directories
    directories = null
    await closeInvocationDirectories(previousDirectories)
    directories = await openInvocationDirectories(invocationRoot)
    await assertRootLive(capability, options.assertRootIdentity)

    const authority: ScenarioDockerAuthority = Object.freeze({
      schemaVersion: 1,
      capabilityPath: frame.capabilityPath,
      capabilityDigest,
      workerPid: identity.pid,
      workerStartIdentity: identity.startIdentity,
      registrationAck: ack
    })
    const environment = environmentForAuthority(process.env, authority, dockerEnvironment)
    const encodedAuthority = environment[OwnedDockerEnvironmentKey]
    knownSecrets = Object.freeze(
      [
        frame.nonce,
        ack.ackToken,
        encodedAuthority,
        ...extractSensitiveValues(frame.scenarioArgv, environment)
      ].filter((value): value is string => typeof value === "string" && value.length > 0)
    )
    // Enforce sanitizer registry bounds before a child can observe any extracted secret.
    redactText("", { knownSecrets })
    scenarioStartAttempted = true
    child = options.spawn(frame.scenarioArgv, {
      cwd: canonicalCwd,
      env: environment,
      detached: false
    })
    const streams: ChildStreams = Object.freeze({
      stdout: captureStream(
        child.stdout,
        knownSecrets,
        maximumCapturedCharacters,
        options.forwardStdout
      ),
      stderr: captureStream(
        child.stderr,
        knownSecrets,
        maximumCapturedCharacters,
        options.forwardStderr
      )
    })
    const resourceCrashController = new AbortController()
    let resourceCrashTriggered = false
    const triggerResourceCrash = (): never => {
      resourceCrashTriggered = true
      return options.killWorkerAfterFirstResource()
    }
    const resourceCrash =
      capability.resourceEventTestHook === "kill-worker-after-first"
        ? observeFirstResourceEvent(
            directories.resources,
            invocationRoot,
            capability,
            entry,
            clock,
            pollIntervalMs,
            options.assertRootIdentity,
            triggerResourceCrash,
            resourceCrashController.signal
          )
        : null
    const gracefulController = new AbortController()
    const scenarioSettled = new Error("scenario settled")
    const forwardWorkerAbort = (): void => gracefulController.abort(options.signal?.reason)
    options.signal?.addEventListener("abort", forwardWorkerAbort, {
      once: true
    })
    if (options.signal?.aborted === true) forwardWorkerAbort()
    const graceful = observeGraceful(
      child,
      directories,
      capability,
      frame,
      bindingBase,
      ack.requestId,
      clock,
      pollIntervalMs,
      gracefulPollTimeoutMs,
      options.assertRootIdentity,
      gracefulController.signal
    )
    try {
      const settlement = await Promise.race([
        child.settled.then((value) => ({ kind: "child" as const, value })),
        graceful.then(
          () => ({ kind: "graceful-complete" as const }),
          (error: unknown) => ({ kind: "graceful-error" as const, error })
        ),
        ...(resourceCrash === null
          ? []
          : [
              resourceCrash.then(
                () => ({ kind: "resource-crash-complete" as const }),
                (error: unknown) => ({
                  kind: "resource-crash-error" as const,
                  error
                })
              )
            ])
      ])
      if (settlement.kind === "graceful-error" || settlement.kind === "resource-crash-error") {
        try {
          child.kill("SIGTERM")
        } catch {
          // The authenticated-control or crash-hook failure remains primary.
        }
        childResult = await child.settled
        throw settlement.error
      }
      if (
        settlement.kind === "graceful-complete" ||
        settlement.kind === "resource-crash-complete"
      ) {
        childResult = await child.settled
      } else {
        childResult = settlement.value
      }
      childResult = Object.freeze({
        ...childResult,
        cleanupFailures: Object.freeze(
          childResult.cleanupFailures.map((failure) =>
            sanitizedFailureRecord(failure, knownSecrets)
          )
        )
      })
    } finally {
      resourceCrashController.abort(scenarioSettled)
      gracefulController.abort(scenarioSettled)
      options.signal?.removeEventListener("abort", forwardWorkerAbort)
      const drains = await Promise.allSettled([
        streams.stdout,
        streams.stderr,
        graceful,
        ...(resourceCrash === null ? [] : [resourceCrash])
      ])
      for (const drain of drains) {
        if (drain.status === "rejected" && drain.reason !== scenarioSettled) {
          addFailure(
            cleanupFailures,
            "stream-drain-failed",
            "stream-drain",
            drain.reason,
            knownSecrets
          )
        }
      }
      if (resourceCrash !== null && !resourceCrashTriggered) {
        const observation = await observeResourceEvents(
          directories.resources,
          invocationRoot,
          capability,
          entry
        )
        if (observation === "publication-in-progress") {
          addFailure(
            cleanupFailures,
            "resource-event-invalid",
            "security",
            new Error(
              "worker resource event publication remained incomplete after scenario settlement"
            ),
            knownSecrets
          )
        }
        if (observation === "current") triggerResourceCrash()
      }
    }
  } catch (error) {
    primary = primaryFailure(error, knownSecrets)
    if (child !== null && childResult === null) {
      try {
        child.kill("SIGTERM")
      } catch (killError) {
        addFailure(cleanupFailures, "scenario-signal-failed", "signal", killError, knownSecrets)
      }
      try {
        childResult = await child.settled
      } catch (settleError) {
        addFailure(
          cleanupFailures,
          "scenario-settle-failed",
          "process-cleanup",
          settleError,
          knownSecrets
        )
      }
    }
  }

  if (directories !== null) {
    try {
      if (scenarioStartAttempted) {
        await options.cleanupDocker(
          canonicalCwd,
          capability.invocation,
          entry.childOwner,
          clock.now() + cleanupTimeoutMs,
          withDockerEnvironment(runCommand, dockerEnvironment)
        )
      }
    } catch (error) {
      addFailure(cleanupFailures, "docker-cleanup-failed", "docker", error, knownSecrets)
    }
    result = resultRecord(
      entry,
      startedAt,
      clock,
      childResult,
      primary,
      cleanupFailures,
      options.signal?.aborted === true,
      options.signal?.aborted === true
        ? errorSummary(options.signal.reason, { knownSecrets }, 2_048)
        : null
    )
    try {
      await writeDurableJson(directories.results, component(entry.id), result, {
        readOnly: true
      })
      resultWritten = true
      await options.onResultPublished?.(result)
    } catch (error) {
      if (primary === null) primary = primaryFailure(error, knownSecrets)
    }
    try {
      await closeInvocationDirectories(directories)
    } catch (error) {
      if (resultWritten) {
        throw workerError(
          "invocation-directory-close-failed",
          "filesystem",
          errorSummary(error, { knownSecrets }, 2_048)
        )
      }
      if (primary === null) primary = primaryFailure(error, knownSecrets)
    }
  }

  if (result === null)
    throw workerError("result-unavailable", "filesystem", "worker result unavailable")
  if (!resultWritten) {
    throw workerError("result-publication-failed", "filesystem", "worker result publication failed")
  }
  return result
}

async function defaultRunLocalRoot(input: {
  readonly cwd: string
  readonly scenarioArgv: readonly string[]
  readonly signal?: AbortSignal | undefined
}): Promise<ExampleTaskRootOutcome> {
  const { runSingleExampleLocalRoot } = await import("./examples")
  return await runSingleExampleLocalRoot(input)
}

/** Runs the real worker state machine for a coordinator-injected package command. */
export async function runExampleTaskWorker(context: {
  readonly command: {
    readonly command: readonly string[]
    readonly cwd: string
  }
  readonly signal?: AbortSignal | undefined
}): Promise<ExampleResult> {
  const command = context.command.command
  const marker = command.lastIndexOf("--worker")
  const argv =
    marker < 1
      ? command
      : command.slice(command[0] === "bun" && command[1] === "run" ? marker - 1 : 3)
  const invocation = parseTerminalWorkerFrame(argv)
  if (invocation.mode !== "worker") {
    throw workerError(
      "worker-frame-invalid",
      "security",
      "coordinator example task did not contain an authenticated worker frame"
    )
  }
  return await runWorker(invocation, context.command.cwd, {
    signal: context.signal
  })
}

/** Runs the example package wrapper in direct-root or authenticated aggregate-worker mode. */
export async function runExampleTask(
  argv: readonly string[],
  cwd: string,
  options: ExampleTaskOptions = EmptyOptions
): Promise<ExampleTaskRootOutcome | ExampleResult> {
  const invocation = parseTerminalWorkerFrame(argv)
  if (invocation.mode === "direct") {
    return await (options.runLocalRoot ?? defaultRunLocalRoot)({
      cwd,
      scenarioArgv: invocation.scenarioArgv,
      signal: options.signal
    })
  }
  return await runWorker(invocation, cwd, options)
}

if (import.meta.main) {
  const controller = new AbortController()
  const onSigint = (): void => controller.abort(new Error("example task interrupted by SIGINT"))
  const onSigterm = (): void => controller.abort(new Error("example task interrupted by SIGTERM"))
  process.once("SIGINT", onSigint)
  process.once("SIGTERM", onSigterm)
  try {
    const result = await runExampleTask(process.argv.slice(2), process.cwd(), {
      signal: controller.signal
    })
    if (result.status !== "passed") process.exitCode = 1
  } catch (error) {
    process.stderr.write(`${errorSummary(error)}\n`)
    process.exitCode = 1
  } finally {
    process.removeListener("SIGINT", onSigint)
    process.removeListener("SIGTERM", onSigterm)
  }
}
