import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, readdir, realpath } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"

import { collectCleanupFailure, type CleanupFailure, finalizeWithCleanup } from "./harness/cleanup"
import { errorSummary, extractSensitiveValues, redactText } from "./harness/diagnostics"
import {
  digestDockerEnvironment,
  snapshotDockerEnvironment,
  withDockerEnvironment,
  type DockerEnvironmentSnapshot
} from "./harness/docker-environment"
import { verifyDockerInvocationCleanup } from "./harness/docker-pairs"
import {
  closeDurableJsonDirectory,
  openDurableJsonDirectory,
  readDurableJson,
  writeDurableJson,
  type DurableJsonDirectory
} from "./harness/durable-json"
import {
  createGracefulControl,
  createRegistrationAck,
  currentProcessIdentity,
  digestInvocationCapability,
  digestInvocationNonce,
  ExampleProtocolLimits,
  generateChildOwner,
  generateInvocationNonce,
  generateRequestId,
  parseExampleParticipant,
  parseExampleResult,
  parseInvocationCapability,
  parseTerminalWorkerFrame,
  readProcessIdentity,
  type AllowedExampleEntry,
  type AuthenticatedControlBinding,
  type ExampleParticipant,
  type ExampleResult,
  type InvocationCapability,
  type ProcessIdentity
} from "./harness/example-protocol"
import {
  createProcessSupervisor,
  type CommandDefinition,
  type CommandResult,
  type ContainmentClaim,
  type ProcessMode,
  type ProcessSupervisor,
  type ProcessTermination,
  type ResidualObservation
} from "./harness/process"
import {
  DockerCleanupReserveMs,
  failureRecord,
  ProcessTerminationReserveMs,
  type FailureCategory,
  type FailureRecord
} from "./harness/result"
import {
  createTempDirectory,
  createTempSubdirectories,
  isPathContained,
  removeTempDirectory,
  verifyTempDirectory,
  type TempDirectory
} from "./harness/temp"

export interface ExampleExecutionInput {
  readonly id: string
  readonly packageName: string
  readonly cwdRealpath: string
  readonly scriptName: "test:e2e"
}

export type ExampleInputFailureCode =
  | "example-input-root-invalid"
  | "example-input-too-large"
  | "example-id-invalid"
  | "example-path-invalid"
  | "example-manifest-invalid"
  | "example-name-mismatch"
  | "example-not-private"
  | "example-script-missing"

export class ExampleInputError extends Error {
  readonly code: ExampleInputFailureCode
  readonly exampleId: string | null

  constructor(code: ExampleInputFailureCode, summary: string, exampleId: string | null = null) {
    super(`${code}: ${summary}`)
    this.name = "ExampleInputError"
    this.code = code
    this.exampleId = exampleId
  }
}

interface ExampleManifest {
  readonly name?: unknown
  readonly private?: unknown
  readonly scripts?: unknown
}

export const ExampleInvocationDirectoryNames = Object.freeze([
  "participants",
  "registrations",
  "acks",
  "results",
  "graceful",
  "resources"
] as const)

export interface ExampleInvocationPaths {
  readonly root: string
  readonly participants: string
  readonly registrations: string
  readonly acks: string
  readonly results: string
  readonly graceful: string
  readonly resources: string
  readonly executionInput: string
  readonly capability: string
}

export interface ExampleRegistrationRecord {
  readonly schemaVersion: 1
  readonly invocation: string
  readonly capabilityDigest: string
  readonly id: string
  readonly packageName: string
  readonly cwdRealpath: string
  readonly workerPid: number
  readonly workerStartIdentity: string
  readonly childOwner: string
  readonly requestId: string
  readonly registeredAt: string
}

export type ExampleRunClassification =
  | "passed"
  | "failed"
  | "not-run"
  | "missing-participant"
  | "wrapper-not-entered"
  | "registered-but-unreported"
  | "result-without-participant"

export interface ExampleRunRecord {
  readonly id: string
  readonly input: ExampleExecutionInput
  readonly classification: ExampleRunClassification
  readonly wrapperEntered: boolean
  readonly command: CommandResult | null
  readonly participant: ExampleParticipant | null
  readonly result: ExampleResult | null
  readonly registration: ExampleRegistrationRecord | null
  readonly acknowledged: boolean
  readonly gracefulRequested: boolean
  readonly failures: readonly FailureRecord[]
}

export interface ExamplesCompleteness {
  readonly executionInputIds: readonly string[]
  readonly participantIds: readonly string[]
  readonly resultIds: readonly string[]
  readonly completedCommandIds: readonly string[]
  readonly missingParticipantIds: readonly string[]
  readonly unexpectedParticipantIds: readonly string[]
  readonly duplicateParticipantIds: readonly string[]
  readonly missingResultIds: readonly string[]
  readonly unexpectedResultIds: readonly string[]
  readonly duplicateResultIds: readonly string[]
  readonly missingCompletedCommandIds: readonly string[]
  readonly unexpectedCompletedCommandIds: readonly string[]
}

export type ExamplesRunStatus = "passed" | "failed" | "timed-out" | "aborted"

/** A command-shaped aggregate with per-example protocol and completeness evidence. */
export interface ExamplesRunResult extends CommandResult {
  readonly status: ExamplesRunStatus
  readonly invocation: string
  readonly examples: readonly ExampleRunRecord[]
  readonly completeness: ExamplesCompleteness
  readonly executionInputIds: readonly string[]
  readonly participantIds: readonly string[]
  readonly resultIds: readonly string[]
  readonly completedCommandIds: readonly string[]
  readonly registeredChildOwners: readonly string[]
  readonly failures: readonly FailureRecord[]
}

export type ExampleDockerBackstop = (
  root: string,
  invocation: string,
  registeredOwners: Iterable<string>,
  deadline: number,
  runner: ProcessSupervisor["run"]
) => Promise<void>

export interface ExampleWorkerDriverContext {
  readonly input: ExampleExecutionInput
  readonly capability: InvocationCapability
  readonly capabilityDigest: string
  readonly capabilityPath: string
  readonly nonce: string
  readonly paths: ExampleInvocationPaths
  readonly command: CommandDefinition
  readonly commandPromise: Promise<CommandResult>
  readonly signal: AbortSignal
  readonly publishRegistrationRequest: (requestId?: string) => Promise<string>
  readonly publishParticipant: (value: unknown, component?: string) => Promise<void>
  readonly publishResult: (value: unknown, component?: string) => Promise<void>
  readonly readRegistration: () => Promise<unknown>
  readonly readAck: () => Promise<unknown>
  readonly readGraceful: () => Promise<unknown>
  readonly waitForRegistration: () => Promise<unknown>
  readonly waitForAck: () => Promise<unknown>
  readonly waitForGraceful: () => Promise<unknown>
}

export type ExampleWorkerDriver = (context: ExampleWorkerDriverContext) => void | Promise<void>

/** Adapts the real example-task worker state machine to the coordinator's injectable driver. */
export async function exampleTaskWorkerDriver(context: ExampleWorkerDriverContext): Promise<void> {
  const { runExampleTaskWorker } = await import("./example-task")
  await runExampleTaskWorker(context)
}

export interface ExamplesCoordinatorDependencies {
  readonly runner?: ProcessSupervisor["run"] | undefined
  readonly commandRunner?: ProcessSupervisor["run"] | undefined
  /** Test seam for deterministic monotonic deadline evidence. */
  readonly monotonicNow?: (() => number) | undefined
  readonly createSupervisor?:
    | ((mode: ProcessMode, root: string) => Promise<ProcessSupervisor>)
    | undefined
  readonly currentIdentity?: (() => Promise<ProcessIdentity>) | undefined
  readonly identityReader?: ((pid: number) => Promise<ProcessIdentity>) | undefined
  readonly dockerBackstop?: ExampleDockerBackstop | undefined
  readonly workerDriver?: ExampleWorkerDriver | undefined
  readonly now?: (() => Date) | undefined
}

export interface ExamplesRunOptions extends ExamplesCoordinatorDependencies {
  /** An externally owned, already-preflighted supervisor. It is never closed here. */
  readonly supervisor?: ProcessSupervisor | undefined
  /** Test-only authenticated cut points used by C4/C5 real process and Docker gates. */
  readonly resourceEventTestHook?:
    | "none"
    | "kill-worker-before-registration"
    | "kill-worker-after-ack-before-scenario"
    | "kill-worker-after-first"
    | undefined
  /** Test-only authenticated opt-in used by the C6 real Docker log sanitizer gate. */
  readonly dockerDiagnosticsPolicy?: "metadata-only" | "safe-redacted-logs" | undefined
  readonly signal?: AbortSignal | undefined
  /** Monotonic absolute owner deadline. All logical and cleanup budgets derive from it. */
  readonly deadline?: number | undefined
  readonly timeoutMs?: number | undefined
  readonly gracePeriodMs?: number | undefined
  readonly hardTerminationReserveMs?: number | undefined
  readonly dockerCleanupTimeoutMs?: number | undefined
  readonly pollIntervalMs?: number | undefined
  readonly workerDriverDrainMs?: number | undefined
  readonly processMode?: ProcessMode | undefined
  readonly dependencies?: ExamplesCoordinatorDependencies | undefined
}

const ExampleIdPattern = /^[a-z0-9][a-z0-9-]{0,63}$/u
const MaximumManifestBytes = 1024 * 1024
const Utf8Decoder = new TextDecoder("utf-8", { fatal: true })
const DefaultExamplesTimeoutMs = 2_700_000
const DefaultGracePeriodMs = 5_000
const ExamplesHandoffReserveMs = 1_000
/** Time kept outside the logical examples deadline for graceful, hard, Docker, and handoff work. */
export const ExamplesCoordinatorReserveMs =
  DefaultGracePeriodMs +
  ProcessTerminationReserveMs +
  DockerCleanupReserveMs +
  ExamplesHandoffReserveMs
const DefaultPollIntervalMs = 10
const DefaultWorkerDriverDrainMs = 1_000
const CapabilityComponent = "capability.json"
const DockerEnvironmentComponent = "docker-environment.json"
const ExecutionInputComponent = "execution-input.json"
const StaleExampleEnvironmentKeys = Object.freeze([
  "GO_LIKE_E2E_CAPABILITY",
  "GO_LIKE_E2E_INVOCATION",
  "GO_LIKE_E2E_NONCE",
  "GO_LIKE_E2E_OWNER",
  "GO_LIKE_E2E_RESULT_DIR",
  "GO_LIKE_E2E_OWNED_DOCKER_AUTHORITY_V1"
])

function noFollowReadFlags(): number {
  const noFollow = Reflect.get(constants, "O_NOFOLLOW")
  if (typeof noFollow !== "number") {
    throw new ExampleInputError(
      "example-input-root-invalid",
      "the platform does not expose no-follow file opens"
    )
  }
  const closeOnExec = Reflect.get(constants, "O_CLOEXEC")
  return constants.O_RDONLY | noFollow | (typeof closeOnExec === "number" ? closeOnExec : 0)
}

function plainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

async function readManifest(path: string, id: string): Promise<ExampleManifest> {
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(path, noFollowReadFlags())
    const metadata = await handle.stat()
    if (!metadata.isFile() || metadata.size > MaximumManifestBytes) {
      throw new ExampleInputError(
        "example-manifest-invalid",
        "package.json must be a bounded regular file",
        id
      )
    }
    const bytes = new Uint8Array(metadata.size)
    let offset = 0
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset)
      if (result.bytesRead === 0) break
      offset += result.bytesRead
    }
    if (offset !== bytes.byteLength) {
      throw new ExampleInputError(
        "example-manifest-invalid",
        "package.json changed while it was read",
        id
      )
    }
    let text: string
    try {
      text = Utf8Decoder.decode(bytes)
    } catch {
      throw new ExampleInputError("example-manifest-invalid", "package.json is not valid UTF-8", id)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new ExampleInputError("example-manifest-invalid", "package.json is not valid JSON", id)
    }
    if (!plainObject(parsed)) {
      throw new ExampleInputError(
        "example-manifest-invalid",
        "package.json root must be an object",
        id
      )
    }
    return parsed
  } catch (error) {
    if (error instanceof ExampleInputError) throw error
    throw new ExampleInputError(
      "example-manifest-invalid",
      "package.json could not be opened without following links",
      id
    )
  } finally {
    await handle?.close().catch(() => {})
  }
}

function validateManifest(id: string, cwdRealpath: string, manifest: ExampleManifest): void {
  const expectedName = `@go-like/example-${id}`
  if (manifest.name !== expectedName) {
    throw new ExampleInputError(
      "example-name-mismatch",
      "package name does not match its directory identity",
      id
    )
  }
  if (manifest.private !== true) {
    throw new ExampleInputError("example-not-private", "package must set private to true", id)
  }
  if (!plainObject(manifest.scripts)) {
    throw new ExampleInputError("example-script-missing", "package has no scripts object", id)
  }
  const script = manifest.scripts["test:e2e"]
  if (typeof script !== "string" || script.trim().length === 0) {
    throw new ExampleInputError(
      "example-script-missing",
      "package has no non-empty test:e2e script",
      id
    )
  }
  if (cwdRealpath.length === 0) {
    throw new ExampleInputError("example-path-invalid", "package path is empty", id)
  }
}

function frozenExecutionInput(id: string, cwdRealpath: string): ExampleExecutionInput {
  return Object.freeze({
    id,
    packageName: `@go-like/example-${id}`,
    cwdRealpath,
    scriptName: "test:e2e" as const
  })
}

/** Discovers the current invocation input from immediate, non-symlink example packages. */
export async function discoverExampleExecutionInputs(
  repositoryRoot: string
): Promise<readonly ExampleExecutionInput[]> {
  let canonicalRepository: string
  let canonicalExamples: string
  try {
    canonicalRepository = await realpath(resolve(repositoryRoot))
    const requestedExamples = join(canonicalRepository, "examples")
    const requestedMetadata = await lstat(requestedExamples)
    if (requestedMetadata.isSymbolicLink() || !requestedMetadata.isDirectory()) {
      throw new Error("examples root is not a direct directory")
    }
    canonicalExamples = await realpath(requestedExamples)
    if (!isPathContained(canonicalRepository, canonicalExamples)) {
      throw new Error("examples root escaped the repository")
    }
  } catch {
    throw new ExampleInputError(
      "example-input-root-invalid",
      "repository examples root is unavailable or unsafe"
    )
  }

  const entries = await readdir(canonicalExamples, { withFileTypes: true })
  const inputs: ExampleExecutionInput[] = []
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue
    const id = entry.name
    if (!ExampleIdPattern.test(id) || basename(id) !== id) {
      throw new ExampleInputError(
        "example-id-invalid",
        "immediate package directory has an invalid identifier"
      )
    }
    const requestedCwd = join(canonicalExamples, id)
    let cwdRealpath: string
    try {
      const metadata = await lstat(requestedCwd)
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("not a directory")
      cwdRealpath = await realpath(requestedCwd)
    } catch {
      throw new ExampleInputError(
        "example-path-invalid",
        "package directory is unavailable or unsafe",
        id
      )
    }
    if (!isPathContained(canonicalExamples, cwdRealpath)) {
      throw new ExampleInputError(
        "example-path-invalid",
        "package directory escaped the examples root",
        id
      )
    }
    const manifest = await readManifest(join(cwdRealpath, "package.json"), id)
    validateManifest(id, cwdRealpath, manifest)
    inputs.push(frozenExecutionInput(id, cwdRealpath))
  }

  inputs.sort((left, right) => left.id.localeCompare(right.id, "en"))
  if (inputs.length === 0) {
    throw new ExampleInputError(
      "example-input-root-invalid",
      "examples root contains no executable package input"
    )
  }
  if (inputs.length > ExampleProtocolLimits.maximumAllowedExamples) {
    throw new ExampleInputError(
      "example-input-too-large",
      "examples root exceeds the invocation capability bound"
    )
  }
  return Object.freeze(inputs)
}

async function standaloneExecutionInput(cwd: string): Promise<ExampleExecutionInput> {
  const requested = resolve(cwd)
  let canonical: string
  try {
    const metadata = await lstat(requested)
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("not a directory")
    canonical = await realpath(requested)
  } catch {
    throw new ExampleInputError(
      "example-path-invalid",
      "standalone example package directory is unavailable or unsafe"
    )
  }
  const id = basename(canonical)
  if (!ExampleIdPattern.test(id) || basename(id) !== id) {
    throw new ExampleInputError(
      "example-id-invalid",
      "standalone example package has an invalid directory identity"
    )
  }
  const manifest = await readManifest(join(canonical, "package.json"), id)
  validateManifest(id, canonical, manifest)
  return frozenExecutionInput(id, canonical)
}

/** Resolves a direct package to its exact discovered entry, or validates a standalone fixture. */
export async function resolveSingleExampleExecutionInput(
  repositoryRoot: string,
  cwd: string
): Promise<ExampleExecutionInput> {
  const canonicalRepository = await realpath(resolve(repositoryRoot)).catch(() => {
    throw new ExampleInputError(
      "example-input-root-invalid",
      "repository root is unavailable or unsafe"
    )
  })
  const selected = await standaloneExecutionInput(cwd)
  let canonicalExamples: string | null = null
  try {
    const requested = join(canonicalRepository, "examples")
    const metadata = await lstat(requested)
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("unsafe")
    canonicalExamples = await realpath(requested)
  } catch {
    canonicalExamples = null
  }
  if (canonicalExamples !== null && isPathContained(canonicalExamples, selected.cwdRealpath)) {
    const discovered = await discoverExampleExecutionInputs(canonicalRepository)
    const matches = discovered.filter(
      (input) => input.id === selected.id && input.cwdRealpath === selected.cwdRealpath
    )
    const exact = matches[0]
    if (
      dirname(selected.cwdRealpath) !== canonicalExamples ||
      matches.length !== 1 ||
      exact === undefined ||
      exact.packageName !== selected.packageName
    ) {
      throw new ExampleInputError(
        "example-path-invalid",
        "direct package does not match its discovered execution input",
        selected.id
      )
    }
    return exact
  }
  return selected
}

interface ResolvedOptions {
  readonly signal: AbortSignal | undefined
  readonly startedAt: number
  readonly deadline: number
  readonly logicalDeadline: number
  readonly graceDeadline: number
  readonly hardDeadline: number
  readonly dockerDeadline: number
  readonly timeoutMs: number
  readonly gracePeriodMs: number
  readonly hardTerminationReserveMs: number
  readonly dockerCleanupTimeoutMs: number
  readonly pollIntervalMs: number
  readonly workerDriverDrainMs: number
  readonly processMode: ProcessMode
  readonly dockerEnvironment: DockerEnvironmentSnapshot
  readonly resourceEventTestHook:
    | "none"
    | "kill-worker-before-registration"
    | "kill-worker-after-ack-before-scenario"
    | "kill-worker-after-first"
  readonly dockerDiagnosticsPolicy: "metadata-only" | "safe-redacted-logs"
  readonly runner: ProcessSupervisor["run"]
  readonly ownedSupervisor: ProcessSupervisor | null
  readonly currentIdentity: () => Promise<ProcessIdentity>
  readonly identityReader: (pid: number) => Promise<ProcessIdentity>
  readonly dockerBackstop: ExampleDockerBackstop
  readonly workerDriver: ExampleWorkerDriver | undefined
  readonly monotonicNow: () => number
  readonly now: () => Date
}

interface PendingFailure {
  readonly code: string
  readonly category: FailureCategory
  readonly exampleId: string | null
  readonly value: unknown
  readonly fallback: string
  readonly cleanup: boolean
}

interface PromiseSettlement<T> {
  readonly status: "fulfilled" | "rejected"
  readonly value?: T
  readonly reason?: unknown
}

interface RootTermination {
  readonly kind: "signal" | "deadline"
  readonly reason: unknown
}

interface RootControl {
  readonly promise: Promise<RootTermination>
  readonly state: () => RootTermination | null
  readonly close: () => void
}

interface InvocationHandles {
  readonly root: DurableJsonDirectory
  readonly participants: DurableJsonDirectory
  readonly registrations: DurableJsonDirectory
  readonly acks: DurableJsonDirectory
  readonly results: DurableJsonDirectory
  readonly graceful: DurableJsonDirectory
  readonly resources: DurableJsonDirectory
}

interface ParticipantObservation {
  readonly component: string
  readonly value: ExampleParticipant | null
  readonly valid: boolean
}

interface ResultObservation {
  readonly component: string
  readonly value: ExampleResult | null
  readonly valid: boolean
}

interface RegistrationState {
  readonly record: ExampleRegistrationRecord
  readonly participant: ExampleParticipant
  readonly acknowledged: boolean
}

interface ExampleRootCommand {
  readonly cwd: string
  readonly command: readonly string[]
}

interface ExecutionState {
  readonly input: ExampleExecutionInput
  readonly commandDefinition: CommandDefinition
  readonly internalController: AbortController
  readonly commandPromise: Promise<CommandResult>
  readonly commandEvent: Promise<PromiseSettlement<CommandResult>>
  commandSettlement: PromiseSettlement<CommandResult> | null
  driverEvent: Promise<PromiseSettlement<void>> | null
  driverSettlement: PromiseSettlement<void> | null
  gracefulRequested: boolean
}

interface CoordinatorState {
  readonly root: string
  readonly directory: TempDirectory | null
  readonly inputs: readonly ExampleExecutionInput[]
  readonly inputById: ReadonlyMap<string, ExampleExecutionInput>
  readonly capability: InvocationCapability
  readonly capabilityDigest: string
  readonly nonce: string
  readonly paths: ExampleInvocationPaths
  readonly handles: InvocationHandles
  readonly options: ResolvedOptions
  readonly control: RootControl
  readonly pendingFailures: PendingFailure[]
  readonly secrets: string[]
  readonly participantObservations: ParticipantObservation[]
  readonly resultObservations: ResultObservation[]
  readonly observedParticipantComponents: Set<string>
  readonly observedResultComponents: Set<string>
  readonly validParticipants: Map<string, ExampleParticipant>
  readonly validResults: Map<string, ExampleResult>
  readonly registrations: Map<string, RegistrationState>
  readonly registeredOwners: Set<string>
  readonly completedCommandIds: Set<string>
  readonly executions: Map<string, ExecutionState>
  supervisorFailed: boolean
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  label: string
): number {
  const selected = value ?? fallback
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > 3_600_000_000) {
    throw new RangeError(`${label} must be a positive bounded integer`)
  }
  return selected
}

function dependencies(options: ExamplesRunOptions): ExamplesCoordinatorDependencies {
  return options.dependencies ?? Object.freeze({})
}

async function resolveOptions(
  root: string,
  options: ExamplesRunOptions,
  startedAt: number
): Promise<ResolvedOptions> {
  const injected = dependencies(options)
  const monotonicNow = options.monotonicNow ?? injected.monotonicNow ?? (() => performance.now())
  const selectedRunner =
    options.runner ?? options.commandRunner ?? injected.runner ?? injected.commandRunner
  if (options.supervisor !== undefined && selectedRunner !== undefined) {
    throw new TypeError("example supervisor and runner overrides are mutually exclusive")
  }
  let runner = options.supervisor?.run ?? selectedRunner
  let ownedSupervisor: ProcessSupervisor | null = null
  const processMode = options.processMode ?? "managed"
  const timeoutMs = boundedPositiveInteger(
    options.timeoutMs,
    DefaultExamplesTimeoutMs,
    "example timeout"
  )
  const gracePeriodMs = boundedPositiveInteger(
    options.gracePeriodMs,
    DefaultGracePeriodMs,
    "example grace period"
  )
  const hardTerminationReserveMs = boundedPositiveInteger(
    options.hardTerminationReserveMs,
    ProcessTerminationReserveMs,
    "example hard termination reserve"
  )
  const dockerCleanupTimeoutMs = boundedPositiveInteger(
    options.dockerCleanupTimeoutMs,
    DockerCleanupReserveMs,
    "example Docker cleanup timeout"
  )
  const reserveMs =
    gracePeriodMs + hardTerminationReserveMs + dockerCleanupTimeoutMs + ExamplesHandoffReserveMs
  const deadline = options.deadline ?? startedAt + timeoutMs + reserveMs
  if (!Number.isFinite(deadline) || deadline <= 0) {
    throw new RangeError("example owner deadline must be a finite positive monotonic timestamp")
  }
  const logicalDeadline = Math.min(startedAt + timeoutMs, deadline - reserveMs)
  const graceDeadline = Math.min(
    logicalDeadline + gracePeriodMs,
    deadline - hardTerminationReserveMs - dockerCleanupTimeoutMs - ExamplesHandoffReserveMs
  )
  const hardDeadline = Math.min(
    graceDeadline + hardTerminationReserveMs,
    deadline - dockerCleanupTimeoutMs - ExamplesHandoffReserveMs
  )
  const dockerDeadline = Math.min(
    hardDeadline + dockerCleanupTimeoutMs,
    deadline - ExamplesHandoffReserveMs
  )
  if (runner === undefined) {
    const createSupervisor =
      options.createSupervisor ?? injected.createSupervisor ?? createProcessSupervisor
    ownedSupervisor = await createSupervisor(processMode, root)
    try {
      await ownedSupervisor.preflight()
    } catch (error) {
      const cleanupFailures: CleanupFailure[] = []
      await collectCleanupFailure(cleanupFailures, "example process supervisor close", () =>
        ownedSupervisor?.close()
      )
      finalizeWithCleanup(
        error,
        cleanupFailures,
        "example process supervisor preflight and close failed"
      )
      throw error
    }
    runner = ownedSupervisor.run
  }
  return Object.freeze({
    signal: options.signal,
    startedAt,
    deadline,
    logicalDeadline,
    graceDeadline,
    hardDeadline,
    dockerDeadline,
    timeoutMs,
    gracePeriodMs,
    hardTerminationReserveMs,
    dockerCleanupTimeoutMs,
    pollIntervalMs: boundedPositiveInteger(
      options.pollIntervalMs,
      DefaultPollIntervalMs,
      "example poll interval"
    ),
    workerDriverDrainMs: boundedPositiveInteger(
      options.workerDriverDrainMs,
      DefaultWorkerDriverDrainMs,
      "example worker driver drain"
    ),
    processMode,
    dockerEnvironment: snapshotDockerEnvironment(),
    resourceEventTestHook:
      options.resourceEventTestHook === undefined || options.resourceEventTestHook === "none"
        ? "none"
        : options.resourceEventTestHook === "kill-worker-before-registration" ||
            options.resourceEventTestHook === "kill-worker-after-ack-before-scenario" ||
            options.resourceEventTestHook === "kill-worker-after-first"
          ? options.resourceEventTestHook
          : (() => {
              throw new RangeError("example resource event test hook is unsupported")
            })(),
    dockerDiagnosticsPolicy:
      options.dockerDiagnosticsPolicy === undefined ||
      options.dockerDiagnosticsPolicy === "metadata-only"
        ? "metadata-only"
        : options.dockerDiagnosticsPolicy === "safe-redacted-logs"
          ? "safe-redacted-logs"
          : (() => {
              throw new RangeError("example Docker diagnostics policy is unsupported")
            })(),
    runner,
    ownedSupervisor,
    currentIdentity: options.currentIdentity ?? injected.currentIdentity ?? currentProcessIdentity,
    identityReader: options.identityReader ?? injected.identityReader ?? readProcessIdentity,
    dockerBackstop:
      options.dockerBackstop ?? injected.dockerBackstop ?? verifyDockerInvocationCleanup,
    workerDriver: options.workerDriver ?? injected.workerDriver,
    monotonicNow,
    now: options.now ?? injected.now ?? (() => new Date())
  })
}

function pendingFailure(
  state: Pick<CoordinatorState, "pendingFailures">,
  code: string,
  category: FailureCategory,
  exampleId: string | null,
  value: unknown,
  fallback: string,
  cleanup = false
): void {
  state.pendingFailures.push(Object.freeze({ code, category, exampleId, value, fallback, cleanup }))
}

function renderedFailure(value: PendingFailure, secrets: readonly string[]): FailureRecord {
  const summary =
    typeof value.value === "string"
      ? redactText(value.value, { knownSecrets: secrets })
      : errorSummary(value.value, { knownSecrets: secrets })
  return failureRecord(value.code, value.category, summary.length === 0 ? value.fallback : summary)
}

function settle<T>(promise: Promise<T>): Promise<PromiseSettlement<T>> {
  return promise.then(
    (value) => Object.freeze({ status: "fulfilled" as const, value }),
    (reason: unknown) => Object.freeze({ status: "rejected" as const, reason })
  )
}

function createRootControl(
  signal: AbortSignal | undefined,
  deadline: number,
  monotonicNow: () => number
): RootControl {
  if (!Number.isFinite(deadline)) throw new Error("examples logical deadline is invalid")
  let selected: RootTermination | null = null
  let resolveControl: ((value: RootTermination) => void) | null = null
  const promise = new Promise<RootTermination>((resolveValue) => {
    resolveControl = resolveValue
  })
  const finish = (value: RootTermination): void => {
    if (selected !== null) return
    selected = Object.freeze(value)
    resolveControl?.(selected)
  }
  const aborted = (): void => {
    finish({ kind: "signal", reason: signal?.reason })
  }
  const expired = (): void => {
    finish({ kind: "deadline", reason: new Error("examples logical deadline exceeded") })
  }
  signal?.addEventListener("abort", aborted, { once: true })
  if (signal?.aborted === true) aborted()
  const remaining = Math.ceil(deadline - monotonicNow())
  const timer = remaining > 0 ? setTimeout(expired, remaining) : null
  if (remaining <= 0) expired()
  return Object.freeze({
    promise,
    state: () => selected,
    close(): void {
      if (timer !== null) clearTimeout(timer)
      signal?.removeEventListener("abort", aborted)
    }
  })
}

function errorHasCode(value: unknown, code: string, seen = new Set<unknown>()): boolean {
  if (value === null || value === undefined || seen.has(value)) return false
  seen.add(value)
  if (typeof value === "object") {
    if ("code" in value && value.code === code) return true
    if (value instanceof AggregateError) {
      for (const nested of value.errors) {
        if (errorHasCode(nested, code, seen)) return true
      }
    }
    if (value instanceof Error && errorHasCode(value.cause, code, seen)) return true
  }
  return false
}

async function tryReadDurable(
  directory: DurableJsonDirectory,
  component: string
): Promise<{ readonly kind: "missing" } | { readonly kind: "value"; readonly value: unknown }> {
  try {
    return Object.freeze({
      kind: "value" as const,
      value: await readDurableJson(directory, component)
    })
  } catch (error) {
    if (errorHasCode(error, "ENOENT")) return Object.freeze({ kind: "missing" as const })
    throw error
  }
}

function protocolComponent(id: string): string {
  return `${id}.json`
}

function durableRegistrationComponent(id: string): string {
  return `registered-${id}.json`
}

function staleExampleEnvironment(): Readonly<Record<string, undefined>> {
  const keys = new Set(StaleExampleEnvironmentKeys)
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("GO_LIKE_E2E_") && key !== "GO_LIKE_E2E_CGROUP_PARENT") keys.add(key)
  }
  return Object.freeze(Object.fromEntries(Array.from(keys).map((key) => [key, undefined])))
}

function canonicalTimestamp(now: () => Date): string {
  const value = now()
  const timestamp = value.toISOString()
  if (new Date(timestamp).toISOString() !== timestamp) {
    throw new Error("example coordinator clock returned an invalid timestamp")
  }
  return timestamp
}

function sameInput(participant: ExampleParticipant, input: ExampleExecutionInput): boolean {
  return (
    participant.id === input.id &&
    participant.packageName === input.packageName &&
    participant.cwdRealpath === input.cwdRealpath
  )
}

function allowedEntry(state: CoordinatorState, id: string): AllowedExampleEntry {
  const matches = state.capability.allowedExamples.filter((entry) => entry.id === id)
  const entry = matches[0]
  if (matches.length !== 1 || entry === undefined) {
    throw new Error("example participant is not uniquely present in the invocation capability")
  }
  return entry
}

async function validateParticipant(
  state: CoordinatorState,
  component: string,
  participant: ExampleParticipant
): Promise<ExampleExecutionInput> {
  const input = state.inputById.get(participant.id)
  if (input === undefined) throw new Error("unexpected example participant identity")
  const entry = allowedEntry(state, participant.id)
  if (
    component !== protocolComponent(participant.id) ||
    !sameInput(participant, input) ||
    participant.childOwner !== entry.childOwner ||
    participant.parentInvocation !== state.capability.invocation
  ) {
    throw new Error("example participant does not match its exact execution capability")
  }
  let observed: ProcessIdentity
  try {
    observed = await state.options.identityReader(participant.workerPid)
  } catch {
    throw new Error("example participant live process identity is unavailable or changed")
  }
  if (
    observed.pid !== participant.workerPid ||
    observed.startIdentity !== participant.workerStartIdentity ||
    observed.principal !== state.capability.rootPrincipal
  ) {
    throw new Error("example participant live process identity is unavailable or changed")
  }
  return input
}

function controlBinding(
  state: CoordinatorState,
  participant: ExampleParticipant,
  requestId: string
): AuthenticatedControlBinding {
  const entry = allowedEntry(state, participant.id)
  return Object.freeze({
    invocation: state.capability.invocation,
    capabilityDigest: state.capabilityDigest,
    id: participant.id,
    workerPid: participant.workerPid,
    workerStartIdentity: participant.workerStartIdentity,
    childOwner: entry.childOwner,
    requestId
  })
}

async function registerParticipant(
  state: CoordinatorState,
  participant: ExampleParticipant,
  acknowledge: boolean,
  workerRequestId: string | null
): Promise<RegistrationState> {
  const existing = state.registrations.get(participant.id)
  if (existing !== undefined) return existing
  const input = state.inputById.get(participant.id)
  if (input === undefined || participant.childOwner === null) {
    throw new Error("example participant cannot be durably registered")
  }
  const requestId = workerRequestId ?? generateRequestId()
  const binding = controlBinding(state, participant, requestId)
  const record: ExampleRegistrationRecord = Object.freeze({
    schemaVersion: 1,
    invocation: state.capability.invocation,
    capabilityDigest: state.capabilityDigest,
    id: participant.id,
    packageName: input.packageName,
    cwdRealpath: input.cwdRealpath,
    workerPid: participant.workerPid,
    workerStartIdentity: participant.workerStartIdentity,
    childOwner: participant.childOwner,
    requestId,
    registeredAt: canonicalTimestamp(state.options.now)
  })
  await writeDurableJson(
    state.handles.registrations,
    durableRegistrationComponent(participant.id),
    record,
    { readOnly: true }
  )
  state.registeredOwners.add(participant.childOwner)
  let acknowledged = false
  if (acknowledge) {
    const ack = createRegistrationAck(state.nonce, binding)
    state.secrets.push(ack.ackToken)
    await writeDurableJson(state.handles.acks, protocolComponent(participant.id), ack, {
      readOnly: true
    })
    acknowledged = true
  }
  const registered = Object.freeze({ record, participant, acknowledged })
  state.registrations.set(participant.id, registered)
  return registered
}

async function observeParticipant(
  state: CoordinatorState,
  component: string,
  value: unknown,
  acknowledge: boolean,
  workerRequestId: string | null
): Promise<{ readonly valid: boolean; readonly acknowledged: boolean }> {
  if (state.observedParticipantComponents.has(component)) {
    const observed = state.participantObservations.find(
      (candidate) => candidate.component === component
    )
    const registration =
      observed?.value === null || observed?.value === undefined
        ? undefined
        : state.registrations.get(observed.value.id)
    return Object.freeze({
      valid: observed?.valid === true,
      acknowledged: registration?.acknowledged === true
    })
  }
  state.observedParticipantComponents.add(component)
  let participant: ExampleParticipant
  try {
    participant = parseExampleParticipant(value)
  } catch (error) {
    state.participantObservations.push(Object.freeze({ component, value: null, valid: false }))
    pendingFailure(
      state,
      "example-participant-invalid",
      "security",
      null,
      error,
      "example participant validation failed"
    )
    return Object.freeze({ valid: false, acknowledged: false })
  }
  if (!state.inputById.has(participant.id)) {
    state.participantObservations.push(
      Object.freeze({ component, value: participant, valid: false })
    )
    pendingFailure(
      state,
      "example-unexpected-participant",
      "security",
      participant.id,
      "unexpected example participant",
      "unexpected example participant"
    )
    return Object.freeze({ valid: false, acknowledged: false })
  }
  try {
    await validateParticipant(state, component, participant)
  } catch (error) {
    state.participantObservations.push(
      Object.freeze({ component, value: participant, valid: false })
    )
    pendingFailure(
      state,
      "example-participant-invalid",
      "security",
      participant.id,
      error,
      "example participant validation failed"
    )
    return Object.freeze({ valid: false, acknowledged: false })
  }
  const previous = state.validParticipants.get(participant.id)
  state.participantObservations.push(
    Object.freeze({ component, value: participant, valid: previous === undefined })
  )
  if (previous !== undefined) return Object.freeze({ valid: false, acknowledged: false })
  state.validParticipants.set(participant.id, participant)
  try {
    const registration = await registerParticipant(state, participant, acknowledge, workerRequestId)
    return Object.freeze({ valid: true, acknowledged: registration.acknowledged })
  } catch (error) {
    pendingFailure(
      state,
      "example-registration-failed",
      "filesystem",
      participant.id,
      error,
      "example durable registration or ACK failed"
    )
    return Object.freeze({ valid: true, acknowledged: false })
  }
}

function expectedOwner(state: CoordinatorState, id: string): string | null {
  const matches = state.capability.allowedExamples.filter((entry) => entry.id === id)
  return matches.length === 1 ? (matches[0]?.childOwner ?? null) : null
}

function observeResult(
  state: CoordinatorState,
  component: string,
  value: unknown
): { readonly valid: boolean } {
  if (state.observedResultComponents.has(component)) {
    const observed = state.resultObservations.find((candidate) => candidate.component === component)
    return Object.freeze({ valid: observed?.valid === true })
  }
  state.observedResultComponents.add(component)
  let result: ExampleResult
  try {
    result = parseExampleResult(value)
  } catch (error) {
    state.resultObservations.push(Object.freeze({ component, value: null, valid: false }))
    pendingFailure(
      state,
      "example-result-invalid",
      "security",
      null,
      error,
      "example result validation failed"
    )
    return Object.freeze({ valid: false })
  }
  if (!state.inputById.has(result.id)) {
    state.resultObservations.push(Object.freeze({ component, value: result, valid: false }))
    pendingFailure(
      state,
      "example-unexpected-result",
      "security",
      result.id,
      "unexpected example result",
      "unexpected example result"
    )
    return Object.freeze({ valid: false })
  }
  if (
    component !== protocolComponent(result.id) ||
    result.childOwner !== expectedOwner(state, result.id)
  ) {
    state.resultObservations.push(Object.freeze({ component, value: result, valid: false }))
    pendingFailure(
      state,
      "example-result-invalid",
      "security",
      result.id,
      "example result does not match its execution capability",
      "example result validation failed"
    )
    return Object.freeze({ valid: false })
  }
  const previous = state.validResults.get(result.id)
  state.resultObservations.push(
    Object.freeze({ component, value: result, valid: previous === undefined })
  )
  if (previous !== undefined) return Object.freeze({ valid: false })
  state.validResults.set(result.id, result)
  return Object.freeze({ valid: true })
}

async function readWorkerRegistrationRequest(
  state: CoordinatorState,
  id: string
): Promise<string | null> {
  const observed = await tryReadDurable(state.handles.registrations, protocolComponent(id))
  if (observed.kind === "missing") return null
  if (
    !plainObject(observed.value) ||
    Reflect.ownKeys(observed.value).length !== 1 ||
    typeof observed.value.requestId !== "string"
  ) {
    throw new Error("example worker registration request is invalid")
  }
  return observed.value.requestId
}

async function readKnownParticipant(
  state: CoordinatorState,
  id: string,
  acknowledge: boolean
): Promise<"missing" | "waiting-registration" | "valid" | "invalid"> {
  const component = protocolComponent(id)
  try {
    const observed = await tryReadDurable(state.handles.participants, component)
    if (observed.kind === "missing") return "missing"
    const workerRequestId = acknowledge ? await readWorkerRegistrationRequest(state, id) : null
    if (acknowledge && workerRequestId === null) return "waiting-registration"
    const result = await observeParticipant(
      state,
      component,
      observed.value,
      acknowledge,
      workerRequestId
    )
    return result.valid && (!acknowledge || result.acknowledged) ? "valid" : "invalid"
  } catch (error) {
    pendingFailure(
      state,
      "example-participant-read-failed",
      "filesystem",
      id,
      error,
      "example participant read failed"
    )
    return "invalid"
  }
}

async function readKnownResult(
  state: CoordinatorState,
  id: string
): Promise<"missing" | "valid" | "invalid"> {
  const component = protocolComponent(id)
  try {
    const observed = await tryReadDurable(state.handles.results, component)
    if (observed.kind === "missing") return "missing"
    return observeResult(state, component, observed.value).valid ? "valid" : "invalid"
  } catch (error) {
    pendingFailure(
      state,
      "example-result-read-failed",
      "filesystem",
      id,
      error,
      "example result read failed"
    )
    return "invalid"
  }
}

async function waitForDurableControl(
  directory: DurableJsonDirectory,
  component: string,
  signal: AbortSignal,
  pollIntervalMs: number
): Promise<unknown> {
  while (true) {
    signal.throwIfAborted()
    const observed = await tryReadDurable(directory, component)
    if (observed.kind === "value") return observed.value
    await Bun.sleep(pollIntervalMs)
  }
}

function workerDriverContext(
  state: CoordinatorState,
  execution: ExecutionState
): ExampleWorkerDriverContext {
  const component = protocolComponent(execution.input.id)
  return Object.freeze({
    input: execution.input,
    capability: state.capability,
    capabilityDigest: state.capabilityDigest,
    capabilityPath: state.paths.capability,
    nonce: state.nonce,
    paths: state.paths,
    command: execution.commandDefinition,
    commandPromise: execution.commandPromise,
    signal: execution.internalController.signal,
    publishRegistrationRequest: async (requestId = generateRequestId()): Promise<string> => {
      await writeDurableJson(
        state.handles.registrations,
        component,
        { requestId },
        {
          readOnly: true
        }
      )
      return requestId
    },
    publishParticipant: async (value: unknown, selectedComponent = component): Promise<void> => {
      await writeDurableJson(state.handles.participants, selectedComponent, value, {
        readOnly: true
      })
    },
    publishResult: async (value: unknown, selectedComponent = component): Promise<void> => {
      await writeDurableJson(state.handles.results, selectedComponent, value, { readOnly: true })
    },
    readRegistration: async (): Promise<unknown> =>
      await readDurableJson(
        state.handles.registrations,
        durableRegistrationComponent(execution.input.id)
      ),
    readAck: async (): Promise<unknown> => await readDurableJson(state.handles.acks, component),
    readGraceful: async (): Promise<unknown> =>
      await readDurableJson(state.handles.graceful, component),
    waitForRegistration: async (): Promise<unknown> =>
      await waitForDurableControl(
        state.handles.registrations,
        durableRegistrationComponent(execution.input.id),
        execution.internalController.signal,
        state.options.pollIntervalMs
      ),
    waitForAck: async (): Promise<unknown> =>
      await waitForDurableControl(
        state.handles.acks,
        component,
        execution.internalController.signal,
        state.options.pollIntervalMs
      ),
    waitForGraceful: async (): Promise<unknown> =>
      await waitForDurableControl(
        state.handles.graceful,
        component,
        execution.internalController.signal,
        state.options.pollIntervalMs
      )
  })
}

function deadlineTimeout(deadline: number, label: string, monotonicNow: () => number): number {
  const remaining = Math.floor(deadline - monotonicNow())
  if (remaining < 1) throw new Error(`${label} deadline is exhausted`)
  return remaining
}

function commandTimeout(state: CoordinatorState): number {
  return deadlineTimeout(state.options.hardDeadline, "example command", state.options.monotonicNow)
}

function startExecution(
  state: CoordinatorState,
  input: ExampleExecutionInput,
  rootCommand: ExampleRootCommand
): ExecutionState {
  const command = rootCommand.command
  const extractedSecrets = extractSensitiveValues(command, process.env)
  for (const secret of extractedSecrets) {
    if (!state.secrets.includes(secret)) state.secrets.push(secret)
  }
  // Enforce registry bounds before the package command can observe any extracted secret.
  redactText("", { knownSecrets: state.secrets })
  const internalController = new AbortController()
  const commandDefinition: CommandDefinition = Object.freeze({
    cwd: rootCommand.cwd,
    command: Object.freeze(command.slice()),
    timeoutMs: commandTimeout(state),
    terminationPolicy: "hard-only",
    environment: staleExampleEnvironment(),
    signal: internalController.signal,
    forwardOutput: false,
    knownSecrets: Object.freeze(state.secrets.slice())
  })
  let commandPromise: Promise<CommandResult>
  try {
    commandPromise = state.options.runner(state.root, commandDefinition)
  } catch (error) {
    commandPromise = Promise.reject(error)
  }
  const execution: ExecutionState = {
    input,
    commandDefinition,
    internalController,
    commandPromise,
    commandEvent: settle(commandPromise),
    commandSettlement: null,
    driverEvent: null,
    driverSettlement: null,
    gracefulRequested: false
  }
  state.executions.set(input.id, execution)
  if (state.options.workerDriver !== undefined) {
    try {
      execution.driverEvent = settle(
        Promise.resolve(state.options.workerDriver(workerDriverContext(state, execution)))
      )
    } catch (error) {
      execution.driverEvent = Promise.resolve(
        Object.freeze({ status: "rejected" as const, reason: error })
      )
    }
  }
  return execution
}

async function nextExecutionEvent(
  state: CoordinatorState,
  execution: ExecutionState
): Promise<"command" | "control" | "driver" | "poll"> {
  const waits: Array<Promise<"command" | "control" | "driver" | "poll">> = [
    execution.commandEvent.then(() => "command" as const),
    state.control.promise.then(() => "control" as const),
    Bun.sleep(state.options.pollIntervalMs).then(() => "poll" as const)
  ]
  if (execution.driverEvent !== null && execution.driverSettlement === null) {
    waits.push(execution.driverEvent.then(() => "driver" as const))
  }
  return await Promise.race(waits)
}

async function captureCommandSettlement(
  state: CoordinatorState,
  execution: ExecutionState
): Promise<void> {
  if (execution.commandSettlement !== null) return
  execution.commandSettlement = await execution.commandEvent
  if (execution.commandSettlement.status === "fulfilled") {
    state.completedCommandIds.add(execution.input.id)
  } else {
    state.supervisorFailed = true
    pendingFailure(
      state,
      "example-command-supervisor-failed",
      "process-cleanup",
      execution.input.id,
      execution.commandSettlement.reason,
      "example command supervisor failed"
    )
  }
}

function captureDriverSettlement(state: CoordinatorState, execution: ExecutionState): void {
  if (execution.driverSettlement?.status === "rejected") {
    pendingFailure(
      state,
      "example-worker-driver-failed",
      "primary",
      execution.input.id,
      execution.driverSettlement.reason,
      "injected example worker driver failed"
    )
  }
}

async function hardAbortAndWait(
  state: CoordinatorState,
  execution: ExecutionState,
  reason: string
): Promise<void> {
  if (execution.commandSettlement === null && !execution.internalController.signal.aborted) {
    execution.internalController.abort(new Error(reason))
  }
  await captureCommandSettlement(state, execution)
}

async function writeGracefulControl(
  state: CoordinatorState,
  execution: ExecutionState,
  participant: ExampleParticipant
): Promise<boolean> {
  if (execution.gracefulRequested) return true
  execution.gracefulRequested = true
  const binding = controlBinding(state, participant, generateRequestId())
  const graceful = createGracefulControl(state.nonce, binding)
  state.secrets.push(graceful.gracefulToken)
  try {
    await writeDurableJson(state.handles.graceful, protocolComponent(participant.id), graceful, {
      readOnly: true
    })
    return true
  } catch (error) {
    pendingFailure(
      state,
      "example-graceful-control-failed",
      "filesystem",
      participant.id,
      error,
      "authenticated graceful control publication failed"
    )
    return false
  }
}

async function gracefulThenHard(
  state: CoordinatorState,
  execution: ExecutionState,
  participant: ExampleParticipant
): Promise<void> {
  const registration = state.registrations.get(participant.id)
  if (registration?.acknowledged !== true) {
    await hardAbortAndWait(state, execution, "example root terminated before worker ACK")
    return
  }
  const published = await writeGracefulControl(state, execution, participant)
  if (!published) {
    await hardAbortAndWait(state, execution, "example graceful control publication failed")
    return
  }
  const graceDeadline = Math.min(
    state.options.monotonicNow() + state.options.gracePeriodMs,
    state.options.graceDeadline
  )
  while (execution.commandSettlement === null && state.options.monotonicNow() < graceDeadline) {
    if (!state.validResults.has(execution.input.id)) {
      const result = await readKnownResult(state, execution.input.id)
      if (result === "invalid") break
    }
    const remaining = Math.max(1, Math.ceil(graceDeadline - state.options.monotonicNow()))
    const event = await Promise.race([
      execution.commandEvent.then(() => "command" as const),
      Bun.sleep(Math.min(state.options.pollIntervalMs, remaining)).then(() => "poll" as const)
    ])
    if (event === "command") await captureCommandSettlement(state, execution)
  }
  if (execution.commandSettlement === null) {
    await hardAbortAndWait(state, execution, "example graceful period elapsed")
  }
  if (!state.validResults.has(execution.input.id)) {
    await readKnownResult(state, execution.input.id)
  }
}

async function drainWorkerDriver(
  state: CoordinatorState,
  execution: ExecutionState
): Promise<void> {
  if (execution.driverEvent === null || execution.driverSettlement !== null) return
  const remaining = Math.floor(state.options.hardDeadline - state.options.monotonicNow())
  const drainMs = Math.min(state.options.workerDriverDrainMs, Math.max(0, remaining))
  const settlement =
    drainMs === 0
      ? Object.freeze({ kind: "timeout" as const })
      : await Promise.race([
          execution.driverEvent.then((value) => Object.freeze({ kind: "driver" as const, value })),
          Bun.sleep(drainMs).then(() => Object.freeze({ kind: "timeout" as const }))
        ])
  if (settlement.kind === "timeout") {
    if (!execution.internalController.signal.aborted) {
      execution.internalController.abort(new Error("injected example worker driver did not settle"))
    }
    pendingFailure(
      state,
      "example-worker-driver-unsettled",
      "process-cleanup",
      execution.input.id,
      "injected example worker driver did not settle",
      "injected example worker driver did not settle"
    )
    return
  }
  execution.driverSettlement = settlement.value
  captureDriverSettlement(state, execution)
}

async function executeOne(
  state: CoordinatorState,
  input: ExampleExecutionInput,
  rootCommand: ExampleRootCommand
): Promise<void> {
  if (state.directory === null) throw new Error("example invocation temp handle is unavailable")
  await verifyTempDirectory(state.directory)
  const execution = startExecution(state, input, rootCommand)
  try {
    let participantReady = false
    while (execution.commandSettlement === null && !participantReady) {
      const participant = await readKnownParticipant(state, input.id, true)
      if (participant === "valid") {
        participantReady = true
        break
      }
      if (participant === "invalid") {
        await hardAbortAndWait(state, execution, "example participant protocol failed")
        break
      }
      const control = state.control.state()
      if (control !== null) {
        await hardAbortAndWait(state, execution, "example root terminated before registration")
        break
      }
      const event = await nextExecutionEvent(state, execution)
      if (event === "command") {
        await captureCommandSettlement(state, execution)
        const commandSettlement =
          execution.commandSettlement as PromiseSettlement<CommandResult> | null
        if (commandSettlement?.status === "fulfilled") {
          await readKnownParticipant(state, input.id, false)
        }
      } else if (event === "control") {
        await hardAbortAndWait(state, execution, "example root terminated before registration")
      } else if (event === "driver" && execution.driverEvent !== null) {
        execution.driverSettlement = await execution.driverEvent
        captureDriverSettlement(state, execution)
        if (execution.driverSettlement.status === "rejected") {
          await hardAbortAndWait(state, execution, "injected example worker driver failed")
        }
      }
    }

    const participant = state.validParticipants.get(input.id)
    const registration = state.registrations.get(input.id)
    if (
      execution.commandSettlement === null &&
      participant !== undefined &&
      registration?.acknowledged === true
    ) {
      while (execution.commandSettlement === null) {
        const result = await readKnownResult(state, input.id)
        if (result === "invalid") {
          await hardAbortAndWait(state, execution, "example result protocol failed")
          break
        }
        if (state.control.state() !== null) {
          await gracefulThenHard(state, execution, participant)
          break
        }
        const event = await nextExecutionEvent(state, execution)
        if (event === "command") {
          await captureCommandSettlement(state, execution)
          await readKnownResult(state, input.id)
        } else if (event === "control") {
          await gracefulThenHard(state, execution, participant)
        } else if (event === "driver" && execution.driverEvent !== null) {
          execution.driverSettlement = await execution.driverEvent
          captureDriverSettlement(state, execution)
          if (execution.driverSettlement.status === "rejected") {
            await hardAbortAndWait(state, execution, "injected example worker driver failed")
          }
        }
      }
    }
    if (execution.commandSettlement === null) {
      await captureCommandSettlement(state, execution)
    }
  } catch (error) {
    state.supervisorFailed = true
    pendingFailure(
      state,
      "example-coordinator-failed",
      "primary",
      input.id,
      error,
      "example coordinator failed"
    )
    await hardAbortAndWait(state, execution, "example coordinator failed")
  } finally {
    await drainWorkerDriver(state, execution)
  }
}

async function scanDirectory(
  state: CoordinatorState,
  kind: "participant" | "result"
): Promise<void> {
  const path = kind === "participant" ? state.paths.participants : state.paths.results
  const handle = kind === "participant" ? state.handles.participants : state.handles.results
  const observed =
    kind === "participant" ? state.observedParticipantComponents : state.observedResultComponents
  let components: readonly string[]
  try {
    components = Object.freeze(
      (await readdir(path)).sort((left, right) => left.localeCompare(right))
    )
  } catch (error) {
    pendingFailure(
      state,
      `example-${kind}-directory-read-failed`,
      "filesystem",
      null,
      error,
      `example ${kind} directory read failed`
    )
    return
  }
  for (const component of components) {
    if (observed.has(component)) continue
    try {
      const value = await readDurableJson(handle, component)
      if (kind === "participant") {
        await observeParticipant(state, component, value, false, null)
      } else observeResult(state, component, value)
    } catch (error) {
      if (kind === "participant") {
        state.observedParticipantComponents.add(component)
        state.participantObservations.push(Object.freeze({ component, value: null, valid: false }))
      } else {
        state.observedResultComponents.add(component)
        state.resultObservations.push(Object.freeze({ component, value: null, valid: false }))
      }
      pendingFailure(
        state,
        `example-${kind}-invalid`,
        "security",
        null,
        error,
        `example ${kind} artifact is invalid`
      )
    }
  }
}

function sortedSet(values: Iterable<string>): readonly string[] {
  return Object.freeze(Array.from(new Set(values)).sort((left, right) => left.localeCompare(right)))
}

function difference(left: readonly string[], right: ReadonlySet<string>): readonly string[] {
  return Object.freeze(left.filter((value) => !right.has(value)))
}

function duplicateIds<T extends { readonly value: { readonly id: string } | null }>(
  values: readonly T[]
): readonly string[] {
  const counts = new Map<string, number>()
  for (const value of values) {
    if (value.value !== null) counts.set(value.value.id, (counts.get(value.value.id) ?? 0) + 1)
  }
  return sortedSet(Array.from(counts.entries()).flatMap(([id, count]) => (count > 1 ? [id] : [])))
}

function completeness(state: CoordinatorState): ExamplesCompleteness {
  const executionInputIds = sortedSet(state.inputs.map((input) => input.id))
  const participantIds = sortedSet(
    state.participantObservations.flatMap((observation) =>
      observation.value === null ? [] : [observation.value.id]
    )
  )
  const resultIds = sortedSet(
    state.resultObservations.flatMap((observation) =>
      observation.value === null ? [] : [observation.value.id]
    )
  )
  const completedCommandIds = sortedSet(state.completedCommandIds)
  const expected = new Set(executionInputIds)
  const participants = new Set(participantIds)
  const results = new Set(resultIds)
  const completed = new Set(completedCommandIds)
  return Object.freeze({
    executionInputIds,
    participantIds,
    resultIds,
    completedCommandIds,
    missingParticipantIds: difference(executionInputIds, participants),
    unexpectedParticipantIds: Object.freeze(participantIds.filter((id) => !expected.has(id))),
    duplicateParticipantIds: duplicateIds(state.participantObservations),
    missingResultIds: difference(executionInputIds, results),
    unexpectedResultIds: Object.freeze(resultIds.filter((id) => !expected.has(id))),
    duplicateResultIds: duplicateIds(state.resultObservations),
    missingCompletedCommandIds: difference(executionInputIds, completed),
    unexpectedCompletedCommandIds: Object.freeze(
      completedCommandIds.filter((id) => !expected.has(id))
    )
  })
}

function resultCommandConsistent(result: ExampleResult, command: CommandResult): boolean {
  const wrapperPassed =
    command.termination === "exit" &&
    command.exitCode === 0 &&
    !command.timedOut &&
    command.signal === null
  return result.status === "passed" ? wrapperPassed : !wrapperPassed
}

function successfulCommand(command: CommandResult | null): boolean {
  return (
    command !== null &&
    command.termination === "exit" &&
    command.exitCode === 0 &&
    !command.timedOut &&
    command.cleanupFailures.length === 0 &&
    command.residual !== "present" &&
    command.residual !== "inconclusive"
  )
}

function sanitizeCommandResult(value: CommandResult, secrets: readonly string[]): CommandResult {
  return Object.freeze({
    exitCode: value.exitCode,
    signal: value.signal,
    termination: value.termination,
    timedOut: value.timedOut,
    abortReason:
      value.abortReason === null ? null : redactText(value.abortReason, { knownSecrets: secrets }),
    durationMs: value.durationMs,
    stdout: redactText(value.stdout, { knownSecrets: secrets }),
    stderr: redactText(value.stderr, { knownSecrets: secrets }),
    cleanupFailures: Object.freeze(
      value.cleanupFailures.map((failure) =>
        failureRecord(
          failure.code,
          failure.category,
          redactText(failure.summary, { knownSecrets: secrets })
        )
      )
    ),
    containment: value.containment,
    residual: value.residual
  })
}

function addCompletenessFailures(state: CoordinatorState, value: ExamplesCompleteness): void {
  for (const id of value.duplicateParticipantIds) {
    pendingFailure(
      state,
      "example-duplicate-participant",
      "security",
      id,
      "duplicate example participant",
      "duplicate example participant"
    )
  }
  for (const id of value.duplicateResultIds) {
    pendingFailure(
      state,
      "example-duplicate-result",
      "security",
      id,
      "duplicate example result",
      "duplicate example result"
    )
  }
}

function classifyExamples(
  state: CoordinatorState,
  sanitizedCommands: ReadonlyMap<string, CommandResult>,
  renderedFailures: readonly FailureRecord[],
  renderedPending: readonly PendingFailure[]
): readonly ExampleRunRecord[] {
  const records: ExampleRunRecord[] = []
  for (const input of state.inputs) {
    const command = sanitizedCommands.get(input.id) ?? null
    const participant = state.validParticipants.get(input.id) ?? null
    const result = state.validResults.get(input.id) ?? null
    const registration = state.registrations.get(input.id) ?? null
    let classification: ExampleRunClassification
    if (!state.executions.has(input.id)) classification = "not-run"
    else if (participant === null && result !== null) classification = "result-without-participant"
    else if (participant === null) {
      classification = successfulCommand(command) ? "wrapper-not-entered" : "missing-participant"
    } else if (result === null) classification = "registered-but-unreported"
    else
      classification =
        result.status === "passed" && successfulCommand(command) ? "passed" : "failed"

    if (
      participant !== null &&
      result !== null &&
      command !== null &&
      !resultCommandConsistent(result, command)
    ) {
      classification = "failed"
    }

    if (classification !== "passed") {
      const code =
        classification === "wrapper-not-entered"
          ? "example-wrapper-not-entered"
          : classification === "registered-but-unreported"
            ? "example-registered-but-unreported"
            : classification === "result-without-participant"
              ? "example-result-without-participant"
              : classification === "missing-participant"
                ? "example-missing-participant"
                : classification === "not-run"
                  ? "example-not-run"
                  : "example-result-failed"
      pendingFailure(
        state,
        code,
        classification === "result-without-participant" ? "security" : "primary",
        input.id,
        classification,
        classification
      )
    }
    if (participant !== null && result !== null && registration?.acknowledged !== true) {
      pendingFailure(
        state,
        "example-result-without-ack",
        "security",
        input.id,
        "example result exists without a durable registration ACK",
        "example result exists without a durable registration ACK"
      )
    }
    if (result !== null && command !== null && !resultCommandConsistent(result, command)) {
      pendingFailure(
        state,
        "example-result-command-inconsistent",
        "security",
        input.id,
        "example result and command outcome are inconsistent",
        "example result and command outcome are inconsistent"
      )
    }
    if (command !== null && command.cleanupFailures.length > 0) {
      for (const failure of command.cleanupFailures) {
        pendingFailure(
          state,
          failure.code,
          failure.category,
          input.id,
          failure.summary,
          "example command cleanup failed"
        )
      }
    }
    if (command !== null && !successfulCommand(command) && classification !== "failed") {
      pendingFailure(
        state,
        "example-command-failed",
        commandFailureCategory(command),
        input.id,
        `example command ended with ${command.termination}`,
        "example command failed"
      )
    }
    records.push(
      Object.freeze({
        id: input.id,
        input,
        classification,
        wrapperEntered: participant !== null,
        command,
        participant,
        result,
        registration: registration?.record ?? null,
        acknowledged: registration?.acknowledged === true,
        gracefulRequested: state.executions.get(input.id)?.gracefulRequested === true,
        failures: Object.freeze([])
      })
    )
  }

  const allRendered = state.pendingFailures.map((failure) =>
    renderedFailure(failure, state.secrets)
  )
  const pendingIndexes = new Map<PendingFailure, number>(
    state.pendingFailures.map((failure, index) => [failure, index])
  )
  return Object.freeze(
    records.map((record) => {
      const failures = renderedPending.flatMap((pending) => {
        if (pending.exampleId !== record.id) return []
        const index = pendingIndexes.get(pending)
        const rendered = index === undefined ? undefined : allRendered[index]
        return rendered === undefined ? [] : [rendered]
      })
      return Object.freeze({ ...record, failures: Object.freeze(failures) })
    })
  )
}

function commandFailureCategory(command: CommandResult): FailureCategory {
  if (command.timedOut || command.termination === "timeout") return "timeout"
  if (command.termination === "abort" || command.termination === "signal") return "signal"
  if (command.termination === "supervisor-error") return "process-cleanup"
  return "primary"
}

function aggregateContainment(values: readonly ContainmentClaim[]): ContainmentClaim {
  if (values.includes("unsupported")) return "unsupported"
  if (values.includes("not-claimed")) return "not-claimed"
  return values.includes("validated") ? "validated" : "not-claimed"
}

function aggregateResidual(
  values: readonly ResidualObservation[],
  cleanupFailures: readonly FailureRecord[],
  observedDockerLeak: boolean
): ResidualObservation {
  if (observedDockerLeak || values.includes("present")) return "present"
  if (cleanupFailures.length > 0 || values.includes("inconclusive")) return "inconclusive"
  if (values.includes("zero-observed")) return "zero-observed"
  return "n/a"
}

function invocationPaths(root: string, directories: readonly string[]): ExampleInvocationPaths {
  const [participants, registrations, acks, results, graceful, resources] = directories
  if (
    participants === undefined ||
    registrations === undefined ||
    acks === undefined ||
    results === undefined ||
    graceful === undefined ||
    resources === undefined
  ) {
    throw new Error("example invocation directory layout was not created exactly")
  }
  return Object.freeze({
    root,
    participants,
    registrations,
    acks,
    results,
    graceful,
    resources,
    executionInput: join(root, ExecutionInputComponent),
    capability: join(root, CapabilityComponent)
  })
}

async function openInvocationHandles(paths: ExampleInvocationPaths): Promise<InvocationHandles> {
  const opened: DurableJsonDirectory[] = []
  try {
    const root = await openDurableJsonDirectory(paths.root)
    opened.push(root)
    const participants = await openDurableJsonDirectory(paths.participants, {
      containedRoot: paths.root
    })
    opened.push(participants)
    const registrations = await openDurableJsonDirectory(paths.registrations, {
      containedRoot: paths.root
    })
    opened.push(registrations)
    const acks = await openDurableJsonDirectory(paths.acks, { containedRoot: paths.root })
    opened.push(acks)
    const results = await openDurableJsonDirectory(paths.results, { containedRoot: paths.root })
    opened.push(results)
    const graceful = await openDurableJsonDirectory(paths.graceful, {
      containedRoot: paths.root
    })
    opened.push(graceful)
    const resources = await openDurableJsonDirectory(paths.resources, {
      containedRoot: paths.root
    })
    opened.push(resources)
    return Object.freeze({
      root,
      participants,
      registrations,
      acks,
      results,
      graceful,
      resources
    })
  } catch (error) {
    const cleanup = await Promise.allSettled(
      opened.reverse().map(async (directory) => await closeDurableJsonDirectory(directory))
    )
    const failures = cleanup.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    )
    if (failures.length > 0) {
      throw new AggregateError([error, ...failures], "example invocation handles failed to open")
    }
    throw error
  }
}

async function closeInvocationHandles(
  handles: InvocationHandles,
  failures: CleanupFailure[]
): Promise<void> {
  const values: readonly [string, DurableJsonDirectory][] = [
    ["example resources handle close", handles.resources],
    ["example graceful handle close", handles.graceful],
    ["example results handle close", handles.results],
    ["example ACK handle close", handles.acks],
    ["example registrations handle close", handles.registrations],
    ["example participants handle close", handles.participants],
    ["example invocation handle close", handles.root]
  ]
  for (const [label, handle] of values) {
    await collectCleanupFailure(failures, label, () => closeDurableJsonDirectory(handle))
  }
}

async function createCapability(
  inputs: readonly ExampleExecutionInput[],
  paths: ExampleInvocationPaths,
  invocation: string,
  nonce: string,
  options: ResolvedOptions
): Promise<InvocationCapability> {
  const rootIdentity = await options.currentIdentity()
  if (rootIdentity.pid !== process.pid) {
    throw new Error("example invocation root identity does not match the coordinator process")
  }
  const allowedExamples = inputs.map((input) =>
    Object.freeze({
      id: input.id,
      packageName: input.packageName,
      cwdRealpath: input.cwdRealpath,
      childOwner: generateChildOwner(input.id)
    })
  )
  return parseInvocationCapability({
    schemaVersion: 1,
    invocation,
    nonceDigest: digestInvocationNonce(nonce),
    rootPid: rootIdentity.pid,
    rootStartIdentity: rootIdentity.startIdentity,
    rootPrincipal: rootIdentity.principal,
    resultDirRealpath: paths.root,
    dockerEnvironmentDigest: digestDockerEnvironment(options.dockerEnvironment),
    resourceEventTestHook: options.resourceEventTestHook,
    dockerDiagnosticsPolicy: options.dockerDiagnosticsPolicy,
    allowedExamples
  })
}

function commandForAggregate(
  input: ExampleExecutionInput,
  capabilityPath: string,
  nonce: string
): ExampleRootCommand {
  return Object.freeze({
    cwd: ".",
    command: Object.freeze([
      "bun",
      "run",
      "--cwd",
      input.cwdRealpath,
      "test:e2e",
      "--",
      "--worker",
      capabilityPath,
      nonce
    ])
  })
}

function commandForDirect(
  root: string,
  cwd: string,
  scenarioArgv: readonly string[],
  capabilityPath: string,
  nonce: string
): ExampleRootCommand {
  return Object.freeze({
    cwd,
    command: Object.freeze([
      "bun",
      resolve(root, "e2e/example-task.ts"),
      "--",
      ...scenarioArgv,
      "--worker",
      capabilityPath,
      nonce
    ])
  })
}

async function runExamplesCore(
  root: string,
  inputs: readonly ExampleExecutionInput[],
  options: ResolvedOptions,
  commandFactory: (
    input: ExampleExecutionInput,
    capabilityPath: string,
    nonce: string
  ) => ExampleRootCommand
): Promise<ExamplesRunResult> {
  const startedAt = options.startedAt
  const canonicalRoot = await realpath(resolve(root))
  const invocation = `examples-${randomUUID()}`
  const nonce = generateInvocationNonce()
  const pendingFailures: PendingFailure[] = []
  const secrets = [nonce]
  let directory: TempDirectory | null = null
  let handles: InvocationHandles | null = null
  let state: CoordinatorState | null = null
  let control: RootControl | null = null
  let observedDockerLeak = false
  const cleanupFailures: CleanupFailure[] = []

  try {
    directory = await createTempDirectory("go-like-examples-")
    const directories = await createTempSubdirectories(
      directory,
      ExampleInvocationDirectoryNames.map((name) => [name] as const)
    )
    const paths = invocationPaths(directory.path, directories)
    handles = await openInvocationHandles(paths)
    const capability = await createCapability(inputs, paths, invocation, nonce, options)
    const capabilityDigest = digestInvocationCapability(capability)
    await writeDurableJson(handles.root, ExecutionInputComponent, inputs, { readOnly: true })
    await writeDurableJson(handles.root, DockerEnvironmentComponent, options.dockerEnvironment, {
      readOnly: true
    })
    await writeDurableJson(handles.root, CapabilityComponent, capability, { readOnly: true })
    control = createRootControl(options.signal, options.logicalDeadline, options.monotonicNow)
    if (control.state() !== null) {
      throw new Error("examples logical deadline exhausted during invocation setup")
    }
    await verifyTempDirectory(directory)
    state = {
      root: canonicalRoot,
      directory,
      inputs,
      inputById: new Map(inputs.map((input) => [input.id, input])),
      capability,
      capabilityDigest,
      nonce,
      paths,
      handles,
      options,
      control,
      pendingFailures,
      secrets,
      participantObservations: [],
      resultObservations: [],
      observedParticipantComponents: new Set<string>(),
      observedResultComponents: new Set<string>(),
      validParticipants: new Map<string, ExampleParticipant>(),
      validResults: new Map<string, ExampleResult>(),
      registrations: new Map<string, RegistrationState>(),
      registeredOwners: new Set<string>(),
      completedCommandIds: new Set<string>(),
      executions: new Map<string, ExecutionState>(),
      supervisorFailed: false
    }

    for (const input of inputs) {
      if (state.control.state() !== null) break
      await executeOne(state, input, commandFactory(input, paths.capability, nonce))
    }
    await scanDirectory(state, "participant")
    await scanDirectory(state, "result")
  } catch (error) {
    pendingFailures.push(
      Object.freeze({
        code: "example-coordinator-failed",
        category: "primary",
        exampleId: null,
        value: error,
        fallback: "example coordinator failed",
        cleanup: false
      })
    )
    if (state !== null) state.supervisorFailed = true
  } finally {
    control?.close()
    if (state !== null) {
      const initializedState = state
      await collectCleanupFailure(cleanupFailures, "example Docker pair backstop", async () => {
        try {
          const dockerDeadline = Math.min(
            initializedState.options.monotonicNow() +
              initializedState.options.dockerCleanupTimeoutMs,
            initializedState.options.dockerDeadline
          )
          await initializedState.options.dockerBackstop(
            initializedState.root,
            initializedState.capability.invocation,
            initializedState.registeredOwners,
            dockerDeadline,
            withDockerEnvironment(
              initializedState.options.runner,
              initializedState.options.dockerEnvironment
            )
          )
        } catch (error) {
          const summary = errorSummary(error, { knownSecrets: initializedState.secrets })
          if (
            summary.includes("Docker owned resource observed") ||
            summary.includes("Docker owned resource remains")
          ) {
            observedDockerLeak = true
          }
          throw error
        }
      })
    }
    if (handles !== null) await closeInvocationHandles(handles, cleanupFailures)
    if (directory !== null) {
      const createdDirectory = directory
      await collectCleanupFailure(cleanupFailures, "example invocation temp cleanup", () =>
        removeTempDirectory(createdDirectory)
      )
    }
    if (options.ownedSupervisor !== null) {
      await collectCleanupFailure(cleanupFailures, "example process supervisor close", () =>
        options.ownedSupervisor?.close()
      )
    }
  }

  for (const cleanup of cleanupFailures) {
    const docker = cleanup.label.includes("Docker")
    const processCleanup = cleanup.label.includes("process supervisor")
    pendingFailures.push(
      Object.freeze({
        code: docker
          ? "example-docker-backstop-failed"
          : processCleanup
            ? "example-process-cleanup-failed"
            : "example-cleanup-failed",
        category: docker ? "docker" : processCleanup ? "process-cleanup" : "filesystem",
        exampleId: null,
        value: cleanup.error,
        fallback: `${cleanup.label} failed`,
        cleanup: true
      })
    )
  }

  const effectiveState: CoordinatorState =
    state ??
    ({
      root: canonicalRoot,
      directory,
      inputs,
      inputById: new Map(inputs.map((input) => [input.id, input])),
      capability: Object.freeze({
        schemaVersion: 1,
        invocation,
        nonceDigest: digestInvocationNonce(nonce),
        rootPid: process.pid,
        rootStartIdentity: "unavailable",
        rootPrincipal: `uid:${typeof process.getuid === "function" ? process.getuid() : 0}`,
        resultDirRealpath: directory?.path ?? canonicalRoot,
        dockerEnvironmentDigest: digestDockerEnvironment(options.dockerEnvironment),
        resourceEventTestHook: options.resourceEventTestHook,
        dockerDiagnosticsPolicy: options.dockerDiagnosticsPolicy,
        allowedExamples: Object.freeze([])
      }),
      capabilityDigest: "0".repeat(64),
      nonce,
      paths: invocationPaths(
        directory?.path ?? canonicalRoot,
        ExampleInvocationDirectoryNames.map((name) => join(directory?.path ?? canonicalRoot, name))
      ),
      handles: handles as never,
      options,
      control:
        control ??
        Object.freeze({
          promise: new Promise<RootTermination>(() => {}),
          state: () => null,
          close: () => {}
        }),
      pendingFailures,
      secrets,
      participantObservations: [],
      resultObservations: [],
      observedParticipantComponents: new Set<string>(),
      observedResultComponents: new Set<string>(),
      validParticipants: new Map<string, ExampleParticipant>(),
      validResults: new Map<string, ExampleResult>(),
      registrations: new Map<string, RegistrationState>(),
      registeredOwners: new Set<string>(),
      completedCommandIds: new Set<string>(),
      executions: new Map<string, ExecutionState>(),
      supervisorFailed: true
    } satisfies CoordinatorState)

  const complete = completeness(effectiveState)
  addCompletenessFailures(effectiveState, complete)
  const commandResults = new Map<string, CommandResult>()
  for (const [id, execution] of effectiveState.executions) {
    const settlement = execution.commandSettlement
    if (settlement?.status === "fulfilled" && settlement.value !== undefined) {
      commandResults.set(id, sanitizeCommandResult(settlement.value, effectiveState.secrets))
    }
  }

  const pendingBeforeClassification = effectiveState.pendingFailures.slice()
  let rendered = effectiveState.pendingFailures.map((failure) =>
    renderedFailure(failure, effectiveState.secrets)
  )
  let examples = classifyExamples(
    effectiveState,
    commandResults,
    rendered,
    pendingBeforeClassification
  )
  rendered = effectiveState.pendingFailures.map((failure) =>
    renderedFailure(failure, effectiveState.secrets)
  )
  examples = Object.freeze(
    examples.map((record) =>
      Object.freeze({
        ...record,
        failures: Object.freeze(
          effectiveState.pendingFailures.flatMap((pending, index) =>
            pending.exampleId === record.id && rendered[index] !== undefined
              ? [rendered[index] as FailureRecord]
              : []
          )
        )
      })
    )
  )
  const rootCleanupFailures = Object.freeze(
    effectiveState.pendingFailures.flatMap((pending, index) =>
      pending.cleanup && rendered[index] !== undefined ? [rendered[index] as FailureRecord] : []
    )
  )
  const commandCleanupFailures = Object.freeze(
    Array.from(commandResults.values()).flatMap((command) => command.cleanupFailures)
  )
  const aggregateCleanupFailures = Object.freeze([
    ...commandCleanupFailures,
    ...rootCleanupFailures
  ])
  const controlState = effectiveState.control.state()
  const status: ExamplesRunStatus =
    controlState?.kind === "deadline"
      ? "timed-out"
      : controlState?.kind === "signal"
        ? "aborted"
        : commandResults.size > 0 &&
            Array.from(commandResults.values()).every(
              (command) => command.termination !== "abort" && command.termination !== "timeout"
            ) &&
            rendered.length === 0
          ? "passed"
          : "failed"
  const termination: ProcessTermination =
    status === "timed-out"
      ? "timeout"
      : status === "aborted"
        ? "abort"
        : effectiveState.supervisorFailed
          ? "supervisor-error"
          : "exit"
  const commands = Array.from(commandResults.values())
  const stdout = redactText(commands.map((command) => command.stdout).join(""), {
    knownSecrets: effectiveState.secrets
  })
  const stderr = redactText(commands.map((command) => command.stderr).join(""), {
    knownSecrets: effectiveState.secrets
  })
  const registeredChildOwners = sortedSet(effectiveState.registeredOwners)
  return Object.freeze({
    status,
    invocation,
    examples,
    completeness: complete,
    executionInputIds: complete.executionInputIds,
    participantIds: complete.participantIds,
    resultIds: complete.resultIds,
    completedCommandIds: complete.completedCommandIds,
    registeredChildOwners,
    failures: Object.freeze(rendered),
    exitCode: termination === "exit" ? (rendered.length === 0 ? 0 : 1) : null,
    signal: null,
    termination,
    timedOut: status === "timed-out",
    abortReason:
      status === "aborted"
        ? errorSummary(controlState?.reason, { knownSecrets: effectiveState.secrets })
        : null,
    durationMs: Math.max(0, Math.round(options.monotonicNow() - startedAt)),
    stdout,
    stderr,
    cleanupFailures: aggregateCleanupFailures,
    containment: aggregateContainment(commands.map((command) => command.containment)),
    residual: aggregateResidual(
      commands.map((command) => command.residual),
      aggregateCleanupFailures,
      observedDockerLeak
    )
  })
}

/** Runs every currently discovered example exactly once, in stable sequential order. */
export async function runExamples(
  root: string,
  options: ExamplesRunOptions = Object.freeze({})
): Promise<ExamplesRunResult> {
  const monotonicNow =
    options.monotonicNow ?? options.dependencies?.monotonicNow ?? (() => performance.now())
  const startedAt = monotonicNow()
  const inputs = await discoverExampleExecutionInputs(root)
  const resolvedOptions = await resolveOptions(root, options, startedAt)
  return await runExamplesCore(root, inputs, resolvedOptions, commandForAggregate)
}

/** Runs one direct package through the same local-root capability and ACK coordinator core. */
export async function runSingleExampleLocalRoot(input: {
  readonly root?: string | undefined
  readonly cwd: string
  readonly scenarioArgv: readonly string[]
  readonly signal?: AbortSignal | undefined
  readonly options?: ExamplesRunOptions | undefined
}): Promise<ExamplesRunResult>
export async function runSingleExampleLocalRoot(
  root: string,
  cwd: string,
  scenarioArgv: readonly string[],
  options?: ExamplesRunOptions
): Promise<ExamplesRunResult>
export async function runSingleExampleLocalRoot(
  rootOrInput:
    | string
    | {
        readonly root?: string | undefined
        readonly cwd: string
        readonly scenarioArgv: readonly string[]
        readonly signal?: AbortSignal | undefined
        readonly options?: ExamplesRunOptions | undefined
      },
  selectedCwd?: string,
  selectedScenarioArgv?: readonly string[],
  selectedOptions: ExamplesRunOptions = Object.freeze({})
): Promise<ExamplesRunResult> {
  const objectInput = typeof rootOrInput === "string" ? null : rootOrInput
  const root =
    typeof rootOrInput === "string"
      ? rootOrInput
      : (rootOrInput.root ?? resolve(import.meta.dir, ".."))
  const cwd = typeof rootOrInput === "string" ? selectedCwd : rootOrInput.cwd
  const scenarioArgv =
    typeof rootOrInput === "string" ? selectedScenarioArgv : rootOrInput.scenarioArgv
  if (cwd === undefined || scenarioArgv === undefined) {
    throw new TypeError("direct example local root requires cwd and scenario argv")
  }
  const options: ExamplesRunOptions =
    objectInput === null
      ? selectedOptions
      : { ...objectInput.options, signal: objectInput.signal ?? objectInput.options?.signal }
  const monotonicNow =
    options.monotonicNow ?? options.dependencies?.monotonicNow ?? (() => performance.now())
  const startedAt = monotonicNow()
  const invocation = parseTerminalWorkerFrame(scenarioArgv)
  if (invocation.mode !== "direct") {
    throw new Error("direct example local root cannot accept an internal worker frame")
  }
  const input = await resolveSingleExampleExecutionInput(root, cwd)
  const resolvedOptions = await resolveOptions(root, options, startedAt)
  return await runExamplesCore(
    root,
    Object.freeze([input]),
    resolvedOptions,
    (_input, path, nonce) =>
      commandForDirect(root, input.cwdRealpath, invocation.scenarioArgv, path, nonce)
  )
}
