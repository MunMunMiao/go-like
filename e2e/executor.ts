import { lstat } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"

import {
  ExamplesInProcessCommand,
  findSuiteDefinition,
  suiteDefinitions,
  type SuiteDefinition
} from "./definitions"
import {
  ExamplesCoordinatorReserveMs,
  runExamples,
  type ExampleExecutionInput,
  type ExampleRegistrationRecord,
  type ExampleRunRecord,
  type ExamplesCompleteness,
  type ExamplesRunResult
} from "./examples"
import { collectCleanupFailure, type CleanupFailure, finalizeWithCleanup } from "./harness/cleanup"
import { newDockerOwner, verifyDockerOwnerCleanup } from "./harness/docker-owner"
import { boundedTail, errorSummary } from "./harness/diagnostics"
import {
  parseExampleParticipant,
  parseExampleResult,
  parseFailureRecord,
  type ExampleParticipant,
  type ExampleResult
} from "./harness/example-protocol"
import {
  createProcessSupervisor,
  type CommandResult,
  type ContainmentClaim,
  type ProcessPreflightResult,
  type ProcessSupervisor,
  type ProcessTermination,
  type ResidualObservation
} from "./harness/process"
import {
  availableTimeout,
  DockerCleanupReserveMs,
  errorValue,
  ProcessTerminationReserveMs,
  type FailureRecord
} from "./harness/result"
import { E2eUsage, parseE2eArguments, selectExecutionPlan, type E2eRequest } from "./selection"
import {
  assertRequiredRuntimeVersions,
  probeRequiredRuntimeVersions,
  renderRuntimePreflight,
  requiredToolsForPlan,
  type RuntimeProbeDependencies
} from "./runtime-versions"

export interface RunE2eDependencies {
  readonly definitions?: readonly SuiteDefinition[] | undefined
  readonly runtimeProbe?: RuntimeProbeDependencies | undefined
  /** Test seam for deterministic monotonic deadline evidence. */
  readonly monotonicNow?: (() => number) | undefined
  readonly validatePlan?:
    | ((root: string, definitions: readonly SuiteDefinition[]) => Promise<void>)
    | undefined
  readonly createSupervisor?:
    | ((
        root: string,
        request: Exclude<E2eRequest, { readonly kind: "help" }>
      ) => Promise<ProcessSupervisor>)
    | undefined
  readonly executeDefinition?:
    | ((
        root: string,
        definition: SuiteDefinition,
        supervisor: ProcessSupervisor,
        signal?: AbortSignal
      ) => Promise<CommandResult>)
    | undefined
  readonly runExamples?:
    | ((
        root: string,
        options: {
          readonly supervisor: ProcessSupervisor
          readonly signal?: AbortSignal | undefined
          readonly deadline: number
          readonly timeoutMs: number
          readonly processMode: ProcessSupervisor["mode"]
          readonly monotonicNow?: (() => number) | undefined
        }
      ) => Promise<ExamplesRunResult>)
    | undefined
  readonly write?: ((value: string) => void) | undefined
}

interface PackageManifest {
  readonly scripts?: Readonly<Record<string, unknown>> | undefined
}

class DefinitionExecutionError extends Error {
  readonly result: CommandResult

  constructor(message: string, result: CommandResult, options?: ErrorOptions) {
    super(message, options)
    this.name = "DefinitionExecutionError"
    this.result = result
  }
}

interface DefinitionExecutionDependencies {
  readonly monotonicNow?: (() => number) | undefined
  readonly runExamples?:
    | ((
        root: string,
        options: {
          readonly supervisor: ProcessSupervisor
          readonly signal?: AbortSignal | undefined
          readonly deadline: number
          readonly timeoutMs: number
          readonly processMode: ProcessSupervisor["mode"]
          readonly monotonicNow?: (() => number) | undefined
        }
      ) => Promise<ExamplesRunResult>)
    | undefined
}

function isRuntimeDefinition(definition: SuiteDefinition): boolean {
  return definition.tags.includes("runtime")
}

function prerequisite(message: string): Error {
  return new Error(`prerequisite-runtime-plan-invalid: ${message}`)
}

export async function validateRegisteredRuntimeDefinition(
  root: string,
  definition: SuiteDefinition
): Promise<void> {
  if (!isRuntimeDefinition(definition)) return
  const cwd = resolve(root, definition.cwd)
  let cwdEntry: Awaited<ReturnType<typeof lstat>>
  try {
    cwdEntry = await lstat(cwd)
  } catch (error) {
    throw prerequisite(
      `${definition.id} cwd is unavailable: ${definition.cwd}; ${errorSummary(error)}`
    )
  }
  if (!cwdEntry.isDirectory()) throw prerequisite(`${definition.id} cwd is not a directory`)

  const manifestPath = resolve(cwd, "package.json")
  let manifest: PackageManifest
  try {
    const value: unknown = await Bun.file(manifestPath).json()
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("manifest root is not an object")
    }
    manifest = value as PackageManifest
  } catch (error) {
    throw prerequisite(`${definition.id} package.json is invalid: ${errorSummary(error)}`)
  }
  if (typeof manifest.scripts !== "object" || manifest.scripts === null) {
    throw prerequisite(`${definition.id} package.json has no scripts object`)
  }
  const script = manifest.scripts["test:e2e:runtimes"]
  if (typeof script !== "string" || script.trim().length === 0) {
    throw prerequisite(`${definition.id} has no non-empty test:e2e:runtimes script`)
  }
  if (definition.command.join("\0") !== ["bun", "run", "test:e2e:runtimes"].join("\0")) {
    throw prerequisite(`${definition.id} does not use the registered runtime argv contract`)
  }
}

export async function validateExecutionPlan(
  root: string,
  definitions: readonly SuiteDefinition[]
): Promise<void> {
  if (definitions.length === 0) throw prerequisite("execution plan is empty")
  const ids = new Set<string>()
  for (const definition of definitions) {
    if (ids.has(definition.id)) throw prerequisite(`duplicate suite id ${definition.id}`)
    ids.add(definition.id)
    if (definition.command.length === 0) throw prerequisite(`${definition.id} has no command`)
    if (definition.requiredTools.length === 0) {
      throw prerequisite(`${definition.id} has no required tools`)
    }
    if (definition.requiresDocker !== definition.requiredTools.includes("docker")) {
      throw prerequisite(`${definition.id} Docker requirement metadata is inconsistent`)
    }
    if (definition.dockerOwnership === "suite" && !definition.requiresDocker) {
      throw prerequisite(`${definition.id} suite Docker ownership requires Docker`)
    }
    const isExamplesId = definition.id === "examples"
    const isExamplesSentinel = definition.command.join("\0") === ExamplesInProcessCommand.join("\0")
    const isChildOwned = definition.dockerOwnership === "children-with-invocation-backstop"
    if (isExamplesId !== isExamplesSentinel || isExamplesId !== isChildOwned) {
      throw prerequisite(
        `${definition.id} must satisfy examples id, in-process command, and child Docker ownership together`
      )
    }
    if (isChildOwned && !definition.requiresDocker) {
      throw prerequisite(`${definition.id} child Docker ownership requires Docker`)
    }
  }
  for (const definition of definitions) {
    await validateRegisteredRuntimeDefinition(root, definition)
  }
}

export async function runDefinition(
  root: string,
  definition: SuiteDefinition,
  supervisor: ProcessSupervisor,
  signal?: AbortSignal,
  dependencies: DefinitionExecutionDependencies = Object.freeze({})
): Promise<CommandResult> {
  const monotonicNow = dependencies.monotonicNow ?? (() => performance.now())
  const deadline = monotonicNow() + definition.timeoutMs
  const owner = definition.dockerOwnership === "suite" ? newDockerOwner(definition.id) : null
  let result: CommandResult | null = null
  let primary: Error | null = null
  try {
    const reserveMs =
      definition.dockerOwnership === "children-with-invocation-backstop"
        ? ExamplesCoordinatorReserveMs
        : owner === null
          ? ProcessTerminationReserveMs
          : DockerCleanupReserveMs
    const timeoutMs = availableTimeout(
      deadline,
      reserveMs,
      definition.timeoutMs,
      `${definition.id} command`,
      monotonicNow
    )
    if (definition.dockerOwnership === "children-with-invocation-backstop") {
      if (
        definition.id !== "examples" ||
        definition.command.join("\0") !== ExamplesInProcessCommand.join("\0")
      ) {
        throw prerequisite(`${definition.id} child Docker ownership is reserved for examples`)
      }
      const executeExamples = dependencies.runExamples ?? runExamples
      const aggregate = await executeExamples(root, {
        supervisor,
        signal,
        deadline,
        timeoutMs,
        processMode: supervisor.mode,
        monotonicNow: dependencies.monotonicNow
      })
      let commandResult: CommandResult
      try {
        commandResult = parseCommandResultBoundary(aggregate, "examples aggregate result")
      } catch (error) {
        throw new Error(
          `examples coordinator returned an invalid command result: ${errorSummary(error)}`
        )
      }
      try {
        result = parseExamplesRunResult(aggregate)
      } catch (error) {
        throw new DefinitionExecutionError(
          `examples coordinator returned an invalid aggregate result: ${errorSummary(error)}`,
          commandResult,
          { cause: error }
        )
      }
    } else {
      result = await supervisor.run(root, {
        cwd: definition.cwd,
        command: definition.command,
        timeoutMs,
        environment: owner === null ? undefined : { LIKEGO_E2E_OWNER: owner },
        signal,
        forwardOutput: true
      })
    }
    const output = `${result.stdout}\n${result.stderr}`
    if (result.cleanupFailures.length > 0) {
      throw new DefinitionExecutionError(
        `${definition.id} process cleanup failed: ${result.cleanupFailures
          .map((failure) => `${failure.code}: ${failure.summary}`)
          .join("; ")}`,
        result
      )
    }
    if (result.timedOut) {
      throw new DefinitionExecutionError(`${definition.id} exceeded ${timeoutMs}ms`, result)
    }
    if (result.termination === "signal") {
      throw new DefinitionExecutionError(
        `${definition.id} terminated by ${result.signal ?? "signal"}`,
        result
      )
    }
    if (result.termination !== "exit" || result.exitCode === null) {
      throw new DefinitionExecutionError(
        `${definition.id} ended with ${result.termination}`,
        result
      )
    }
    if (result.exitCode !== 0) {
      throw new DefinitionExecutionError(
        `${definition.id} exited ${result.exitCode}: ${boundedTail(output, 12_000)}`,
        result
      )
    }
  } catch (error) {
    primary = errorValue(error, `${definition.id} failed`)
  }
  const cleanupFailures: CleanupFailure[] = []
  if (owner !== null) {
    await collectCleanupFailure(cleanupFailures, "Docker owner cleanup", () =>
      verifyDockerOwnerCleanup(root, owner, deadline, supervisor.run)
    )
  }
  try {
    finalizeWithCleanup(
      primary,
      cleanupFailures,
      `${definition.id} failed and leaked Docker resources`
    )
  } catch (error) {
    if (result !== null && !(error instanceof DefinitionExecutionError)) {
      throw new DefinitionExecutionError(errorSummary(error), result, { cause: error })
    }
    throw error
  }
  if (result === null) throw new Error(`${definition.id} completed without a command result`)
  return result
}

export async function runSuite(root: string, suite: string, signal?: AbortSignal): Promise<void> {
  const definition = findSuiteDefinition(suite)
  if (definition === undefined) throw new Error(`unknown E2E suite ${suite}`)
  const supervisor = await createProcessSupervisor("managed", root)
  let primary: unknown = null
  try {
    await supervisor.preflight()
    await runDefinition(root, definition, supervisor, signal)
  } catch (error) {
    primary = error
  }
  const cleanupFailures: CleanupFailure[] = []
  await collectCleanupFailure(cleanupFailures, "process supervisor close", () => supervisor.close())
  finalizeWithCleanup(
    primary,
    cleanupFailures,
    `${definition.id} failed and supervisor close failed`
  )
}

function aggregateContainment(
  values: readonly ContainmentClaim[],
  fallback: ContainmentClaim
): ContainmentClaim {
  if (values.includes("unsupported")) return "unsupported"
  if (values.includes("not-claimed")) return "not-claimed"
  if (values.includes("validated")) return "validated"
  return fallback
}

function aggregateResidual(values: readonly ResidualObservation[]): ResidualObservation {
  if (values.includes("present")) return "present"
  if (values.includes("inconclusive")) return "inconclusive"
  if (values.includes("zero-observed")) return "zero-observed"
  return "n/a"
}

function terminationCounts(values: readonly ProcessTermination[]): string {
  const counts = new Map<ProcessTermination, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return ["exit", "signal", "timeout", "abort", "supervisor-error"]
    .map((value) => `${value}=${counts.get(value as ProcessTermination) ?? 0}`)
    .join(",")
}

function summary(
  selected: number,
  started: number,
  passed: number,
  failed: number,
  status: "passed" | "failed",
  terminations: readonly ProcessTermination[] = Object.freeze([]),
  containments: readonly ContainmentClaim[] = Object.freeze([]),
  residuals: readonly ResidualObservation[] = Object.freeze([]),
  fallbackContainment: ContainmentClaim = "not-claimed"
): string {
  return `[e2e] SUMMARY selected=${selected} started=${started} passed=${passed} failed=${failed} notRun=${selected - started} termination=${terminationCounts(terminations)} containment=${aggregateContainment(containments, fallbackContainment)} residual=${aggregateResidual(residuals)} status=${status}`
}

async function defaultSupervisorFactory(
  _root: string,
  request: Exclude<E2eRequest, { readonly kind: "help" }>
): Promise<ProcessSupervisor> {
  return await createProcessSupervisor(request.processMode, _root)
}

function requestedContainment(
  request: Exclude<E2eRequest, { readonly kind: "help" }>
): ContainmentClaim {
  return request.processMode === "platform-containment" && process.platform === "darwin"
    ? "unsupported"
    : "not-claimed"
}

function startedLine(definition: SuiteDefinition, preflight: ProcessPreflightResult): string {
  return `[e2e] START ${definition.id} processMode=${preflight.processMode} strategy=${preflight.strategy}`
}

const ExampleRunClassifications = Object.freeze([
  "passed",
  "failed",
  "not-run",
  "missing-participant",
  "wrapper-not-entered",
  "registered-but-unreported",
  "result-without-participant"
] as const)
const ExampleRunStatuses = Object.freeze(["passed", "failed", "timed-out", "aborted"] as const)
const ProcessTerminations = Object.freeze([
  "exit",
  "signal",
  "timeout",
  "abort",
  "supervisor-error"
] as const)
const ContainmentClaims = Object.freeze(["validated", "not-claimed", "unsupported"] as const)
const ResidualObservations = Object.freeze([
  "zero-observed",
  "present",
  "inconclusive",
  "n/a"
] as const)
const CompletenessFields = Object.freeze([
  "executionInputIds",
  "participantIds",
  "resultIds",
  "completedCommandIds",
  "missingParticipantIds",
  "unexpectedParticipantIds",
  "duplicateParticipantIds",
  "missingResultIds",
  "unexpectedResultIds",
  "duplicateResultIds",
  "missingCompletedCommandIds",
  "unexpectedCompletedCommandIds"
] as const satisfies readonly (keyof ExamplesCompleteness)[])

function plainRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`)
  }
  return value as Readonly<Record<string, unknown>>
}

function finiteNumber(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    throw new Error(`${label} must be a finite number`)
  }
  return value
}

function safeInteger(value: unknown, label: string, minimum = 0): number {
  const selected = finiteNumber(value, label, minimum)
  if (!Number.isSafeInteger(selected)) throw new Error(`${label} must be a safe integer`)
  return selected
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`)
  return value
}

function nullableString(value: unknown, label: string): string | null {
  if (value !== null && typeof value !== "string")
    throw new Error(`${label} must be a string or null`)
  return value as string | null
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  values: T,
  label: string
): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new Error(`${label} is invalid`)
  }
  return value as T[number]
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be a string array`)
  }
  return Object.freeze(value.slice())
}

function stringSet(value: unknown, label: string): readonly string[] {
  const selected = stringArray(value, label)
  if (new Set(selected).size !== selected.length) {
    throw new Error(`${label} must not contain duplicates`)
  }
  return selected
}

function stringSetEqual(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    new Set(left).size === left.length &&
    new Set(right).size === right.length &&
    left.every((value) => right.includes(value))
  )
}

function stringSetDifference(left: readonly string[], right: readonly string[]): readonly string[] {
  const excluded = new Set(right)
  return Object.freeze(left.filter((value) => !excluded.has(value)))
}

function requireStringSetEqual(
  observed: readonly string[],
  expected: readonly string[],
  label: string
): void {
  if (!stringSetEqual(observed, expected)) {
    throw new Error(`${label} disagrees with aggregate evidence`)
  }
}

function parseCommandResultBoundary(value: unknown, label: string): CommandResult {
  const record = plainRecord(value, label)
  const termination = enumValue(record.termination, ProcessTerminations, `${label} termination`)
  const exitCode =
    record.exitCode === null ? null : safeInteger(record.exitCode, `${label} exit code`)
  const signal = nullableString(record.signal, `${label} signal`)
  const timedOut = booleanValue(record.timedOut, `${label} timedOut`)
  const abortReason = nullableString(record.abortReason, `${label} abort reason`)
  if (typeof record.stdout !== "string" || typeof record.stderr !== "string") {
    throw new Error(`${label} streams must be strings`)
  }
  if (!Array.isArray(record.cleanupFailures)) {
    throw new Error(`${label} cleanup failures must be an array`)
  }
  const cleanupFailures = Object.freeze(record.cleanupFailures.map(parseFailureRecord))
  const containment = enumValue(record.containment, ContainmentClaims, `${label} containment`)
  const residual = enumValue(record.residual, ResidualObservations, `${label} residual`)
  if (timedOut !== (termination === "timeout")) {
    throw new Error(`${label} timeout fields disagree`)
  }
  if ((termination === "exit") !== (exitCode !== null)) {
    throw new Error(`${label} exit fields disagree`)
  }
  if ((termination === "signal") !== (signal !== null)) {
    throw new Error(`${label} signal fields disagree`)
  }
  if (termination === "abort" && abortReason === null) {
    throw new Error(`${label} abort fields disagree`)
  }
  if (termination !== "abort" && termination !== "supervisor-error" && abortReason !== null) {
    throw new Error(`${label} abort fields disagree`)
  }
  return Object.freeze({
    exitCode,
    signal,
    termination,
    timedOut,
    abortReason,
    durationMs: finiteNumber(record.durationMs, `${label} duration`),
    stdout: record.stdout,
    stderr: record.stderr,
    cleanupFailures,
    containment,
    residual
  })
}

function parseExecutionInput(value: unknown, label: string): ExampleExecutionInput {
  const record = plainRecord(value, label)
  if (
    typeof record.id !== "string" ||
    typeof record.packageName !== "string" ||
    typeof record.cwdRealpath !== "string" ||
    !isAbsolute(record.cwdRealpath) ||
    record.scriptName !== "test:e2e"
  ) {
    throw new Error(`${label} is invalid`)
  }
  return Object.freeze({
    id: record.id,
    packageName: record.packageName,
    cwdRealpath: record.cwdRealpath,
    scriptName: "test:e2e"
  })
}

function parseRegistration(value: unknown, label: string): ExampleRegistrationRecord {
  const record = plainRecord(value, label)
  if (
    record.schemaVersion !== 1 ||
    typeof record.invocation !== "string" ||
    typeof record.capabilityDigest !== "string" ||
    typeof record.id !== "string" ||
    typeof record.packageName !== "string" ||
    typeof record.cwdRealpath !== "string" ||
    !isAbsolute(record.cwdRealpath) ||
    typeof record.workerStartIdentity !== "string" ||
    typeof record.childOwner !== "string" ||
    typeof record.requestId !== "string" ||
    typeof record.registeredAt !== "string"
  ) {
    throw new Error(`${label} is invalid`)
  }
  return Object.freeze({
    schemaVersion: 1,
    invocation: record.invocation,
    capabilityDigest: record.capabilityDigest,
    id: record.id,
    packageName: record.packageName,
    cwdRealpath: record.cwdRealpath,
    workerPid: safeInteger(record.workerPid, `${label} worker PID`, 1),
    workerStartIdentity: record.workerStartIdentity,
    childOwner: record.childOwner,
    requestId: record.requestId,
    registeredAt: record.registeredAt
  })
}

function parseCompleteness(value: unknown): ExamplesCompleteness {
  const record = plainRecord(value, "examples completeness")
  const parsed = Object.fromEntries(
    CompletenessFields.map((field) => [
      field,
      stringSet(record[field], `examples completeness ${field}`)
    ])
  ) as unknown as ExamplesCompleteness
  return Object.freeze(parsed)
}

function successfulExampleCommand(command: CommandResult | null): boolean {
  return (
    command !== null &&
    command.termination === "exit" &&
    command.exitCode === 0 &&
    !command.timedOut &&
    command.signal === null &&
    command.cleanupFailures.length === 0 &&
    command.residual !== "present" &&
    command.residual !== "inconclusive"
  )
}

function exampleResultCommandConsistent(result: ExampleResult, command: CommandResult): boolean {
  const wrapperPassed =
    command.termination === "exit" &&
    command.exitCode === 0 &&
    !command.timedOut &&
    command.signal === null
  return result.status === "passed" ? wrapperPassed : !wrapperPassed
}

function expectedExampleClassification(
  command: CommandResult | null,
  participant: ExampleParticipant | null,
  result: ExampleResult | null
): ExampleRunRecord["classification"] {
  let classification: ExampleRunRecord["classification"]
  if (participant === null && result !== null) classification = "result-without-participant"
  else if (participant === null) {
    classification = successfulExampleCommand(command)
      ? "wrapper-not-entered"
      : "missing-participant"
  } else if (result === null) classification = "registered-but-unreported"
  else {
    classification =
      result.status === "passed" && successfulExampleCommand(command) ? "passed" : "failed"
  }
  if (result !== null && command !== null && !exampleResultCommandConsistent(result, command)) {
    classification = "failed"
  }
  return classification
}

function parseExampleRunRecord(value: unknown, invocation: string): ExampleRunRecord {
  const record = plainRecord(value, "example run record")
  if (typeof record.id !== "string" || !Array.isArray(record.failures)) {
    throw new Error("example run record is invalid")
  }
  const input = parseExecutionInput(record.input, `example ${record.id} input`)
  if (input.id !== record.id) throw new Error("example run record input identity disagrees")
  const participant: ExampleParticipant | null =
    record.participant === null ? null : parseExampleParticipant(record.participant)
  const result: ExampleResult | null =
    record.result === null ? null : parseExampleResult(record.result)
  const registration: ExampleRegistrationRecord | null =
    record.registration === null
      ? null
      : parseRegistration(record.registration, `example ${record.id} registration`)
  for (const identity of [participant?.id, result?.id, registration?.id]) {
    if (identity !== undefined && identity !== record.id) {
      throw new Error("example run record protocol identity disagrees")
    }
  }
  if (
    participant !== null &&
    (participant.packageName !== input.packageName ||
      participant.cwdRealpath !== input.cwdRealpath ||
      participant.parentInvocation !== invocation ||
      participant.childOwner === null)
  ) {
    throw new Error("example participant and execution input disagree")
  }
  if (registration !== null) {
    if (
      participant === null ||
      registration.invocation !== invocation ||
      registration.packageName !== input.packageName ||
      registration.cwdRealpath !== input.cwdRealpath ||
      registration.workerPid !== participant.workerPid ||
      registration.workerStartIdentity !== participant.workerStartIdentity ||
      registration.childOwner !== participant.childOwner
    ) {
      throw new Error("example registration evidence disagrees")
    }
  }
  if (result !== null && participant !== null && participant.childOwner !== result.childOwner) {
    throw new Error("example participant and result owner disagree")
  }
  const classification = enumValue(
    record.classification,
    ExampleRunClassifications,
    `example ${record.id} classification`
  )
  const wrapperEntered = booleanValue(record.wrapperEntered, `example ${record.id} wrapperEntered`)
  const acknowledged = booleanValue(record.acknowledged, `example ${record.id} acknowledged`)
  const gracefulRequested = booleanValue(
    record.gracefulRequested,
    `example ${record.id} gracefulRequested`
  )
  const command =
    record.command === null
      ? null
      : parseCommandResultBoundary(record.command, `example ${record.id} command`)
  if (wrapperEntered !== (participant !== null)) {
    throw new Error("example wrapper evidence disagrees")
  }
  if (acknowledged && registration === null) {
    throw new Error("example ACK exists without durable registration evidence")
  }
  if (classification === "not-run") {
    if (
      command !== null ||
      participant !== null ||
      result !== null ||
      registration !== null ||
      acknowledged ||
      gracefulRequested
    ) {
      throw new Error("example not-run classification contains execution evidence")
    }
  } else if (classification !== expectedExampleClassification(command, participant, result)) {
    throw new Error("example classification disagrees with protocol and command evidence")
  }
  return Object.freeze({
    id: record.id,
    input,
    classification,
    wrapperEntered,
    command,
    participant,
    result,
    registration,
    acknowledged,
    gracefulRequested,
    failures: Object.freeze(record.failures.map(parseFailureRecord))
  })
}

function parseExamplesRunResult(value: unknown): ExamplesRunResult {
  const command = parseCommandResultBoundary(value, "examples aggregate result")
  const record = plainRecord(value, "examples aggregate result")
  const status = enumValue(record.status, ExampleRunStatuses, "examples aggregate status")
  if (typeof record.invocation !== "string" || !Array.isArray(record.examples)) {
    throw new Error("examples aggregate identity or records are invalid")
  }
  if (!Array.isArray(record.failures)) throw new Error("examples aggregate failures are invalid")
  const completeness = parseCompleteness(record.completeness)
  const executionInputIds = stringSet(record.executionInputIds, "execution input IDs")
  const participantIds = stringSet(record.participantIds, "participant IDs")
  const resultIds = stringSet(record.resultIds, "result IDs")
  const completedCommandIds = stringSet(record.completedCommandIds, "completed command IDs")
  const aliases = [
    [executionInputIds, completeness.executionInputIds, "execution input"],
    [participantIds, completeness.participantIds, "participant"],
    [resultIds, completeness.resultIds, "result"],
    [completedCommandIds, completeness.completedCommandIds, "completed command"]
  ] as const
  for (const [alias, canonical, label] of aliases) {
    requireStringSetEqual(alias, canonical, `examples ${label} aliases`)
  }

  requireStringSetEqual(
    completeness.missingParticipantIds,
    stringSetDifference(executionInputIds, participantIds),
    "examples missing participant differential"
  )
  requireStringSetEqual(
    completeness.unexpectedParticipantIds,
    stringSetDifference(participantIds, executionInputIds),
    "examples unexpected participant differential"
  )
  requireStringSetEqual(
    completeness.missingResultIds,
    stringSetDifference(executionInputIds, resultIds),
    "examples missing result differential"
  )
  requireStringSetEqual(
    completeness.unexpectedResultIds,
    stringSetDifference(resultIds, executionInputIds),
    "examples unexpected result differential"
  )
  requireStringSetEqual(
    completeness.missingCompletedCommandIds,
    stringSetDifference(executionInputIds, completedCommandIds),
    "examples missing completed-command differential"
  )
  requireStringSetEqual(
    completeness.unexpectedCompletedCommandIds,
    stringSetDifference(completedCommandIds, executionInputIds),
    "examples unexpected completed-command differential"
  )
  if (
    completeness.duplicateParticipantIds.some((id) => !participantIds.includes(id)) ||
    completeness.duplicateResultIds.some((id) => !resultIds.includes(id))
  ) {
    throw new Error("examples duplicate evidence refers to an unobserved protocol ID")
  }

  const examples = Object.freeze(
    record.examples.map((entry) => parseExampleRunRecord(entry, record.invocation as string))
  )
  requireStringSetEqual(
    examples.map((example) => example.id),
    executionInputIds,
    "examples records"
  )
  for (const example of examples) {
    if (example.participant !== null && !participantIds.includes(example.id)) {
      throw new Error("example participant record is absent from aggregate observations")
    }
    if (example.result !== null && !resultIds.includes(example.id)) {
      throw new Error("example result record is absent from aggregate observations")
    }
    if ((example.command !== null) !== completedCommandIds.includes(example.id)) {
      throw new Error("example command record and completed-command evidence disagree")
    }
    if (
      example.classification === "passed" &&
      (example.participant === null ||
        example.result?.status !== "passed" ||
        example.registration === null ||
        !example.acknowledged ||
        !successfulExampleCommand(example.command))
    ) {
      throw new Error(
        "passed example lacks complete participant, result, command, registration, or ACK evidence"
      )
    }
  }

  const registeredChildOwners = stringSet(record.registeredChildOwners, "registered child owners")
  if (
    examples.some(
      (example) =>
        example.registration !== null &&
        !registeredChildOwners.includes(example.registration.childOwner)
    )
  ) {
    throw new Error("example durable registration owner is absent from the registered owner set")
  }
  const failures: readonly FailureRecord[] = Object.freeze(record.failures.map(parseFailureRecord))
  const completenessFailures = CompletenessFields.slice(4).some(
    (field) => completeness[field].length > 0
  )
  const passedEvidence =
    command.termination === "exit" &&
    command.exitCode === 0 &&
    command.cleanupFailures.length === 0 &&
    failures.length === 0 &&
    !completenessFailures &&
    examples.every((example) => example.classification === "passed")
  if ((status === "passed") !== passedEvidence) {
    throw new Error("examples aggregate status and command evidence disagree")
  }
  const failedTermination =
    command.termination === "supervisor-error" ||
    (command.termination === "exit" && command.exitCode !== null && command.exitCode !== 0)
  if (
    (status === "timed-out") !== command.timedOut ||
    (status === "aborted") !== (command.termination === "abort") ||
    (status === "failed") !== failedTermination
  ) {
    throw new Error("examples aggregate status and termination disagree")
  }
  return Object.freeze({
    ...command,
    status,
    invocation: record.invocation,
    examples,
    completeness,
    executionInputIds,
    participantIds,
    resultIds,
    completedCommandIds,
    registeredChildOwners,
    failures
  })
}

function examplesLines(result: ExamplesRunResult): readonly string[] {
  const lines = result.examples.map((example) => {
    const status =
      example.classification === "passed"
        ? "PASS"
        : example.classification === "registered-but-unreported"
          ? "UNREPORTED"
          : result.status === "timed-out"
            ? "TIMEOUT"
            : result.status === "aborted"
              ? "ABORT"
              : example.acknowledged
                ? "FAIL"
                : "REGISTRATION-FAIL"
    const failureDiagnostics =
      example.failures.length === 0
        ? "none"
        : boundedTail(
            example.failures
              .map((failure) => `${failure.code}/${failure.category}: ${failure.summary}`)
              .join(" | "),
            4_096
          )
    return `[e2e:example] ${status} ${example.id} classification=${example.classification} commandTermination=${example.command?.termination ?? "not-run"} exitCode=${example.command?.exitCode ?? "null"} signal=${example.command?.signal ?? "null"} timedOut=${example.command?.timedOut ?? false} failures=${failureDiagnostics}`
  })
  const failures = result.failures.map(
    (failure) =>
      `[e2e:example:failure] code=${failure.code} category=${failure.category} summary=${boundedTail(failure.summary, 2_048)}`
  )
  return Object.freeze([
    ...result.executionInputIds.map((id) => `[e2e:example] INPUT ${id}`),
    ...lines,
    ...failures,
    `[e2e:example] SUMMARY selected=${result.executionInputIds.length} participants=${result.participantIds.length} results=${result.resultIds.length} completed=${result.completedCommandIds.length} passed=${result.examples.filter((example) => example.classification === "passed").length} failed=${result.examples.filter((example) => example.classification !== "passed").length}`
  ])
}

export async function runE2eRequest(
  root: string,
  request: E2eRequest,
  signal?: AbortSignal,
  dependencies: RunE2eDependencies = Object.freeze({})
): Promise<void> {
  if (request.kind === "help") {
    const write = dependencies.write ?? ((value: string) => process.stdout.write(value))
    write(`${E2eUsage}\n`)
    return
  }
  const definitions = dependencies.definitions ?? suiteDefinitions()
  const selected = selectExecutionPlan(definitions, request)
  const write = dependencies.write ?? ((value: string) => process.stderr.write(value))
  const execute = async (
    selectedRoot: string,
    definition: SuiteDefinition,
    selectedSupervisor: ProcessSupervisor,
    selectedSignal?: AbortSignal
  ): Promise<CommandResult> => {
    if (definition.dockerOwnership === "children-with-invocation-backstop") {
      return await runDefinition(selectedRoot, definition, selectedSupervisor, selectedSignal, {
        monotonicNow: dependencies.monotonicNow,
        runExamples: dependencies.runExamples
      })
    }
    const injected = dependencies.executeDefinition
    return injected === undefined
      ? await runDefinition(selectedRoot, definition, selectedSupervisor, selectedSignal, {
          monotonicNow: dependencies.monotonicNow
        })
      : await injected(selectedRoot, definition, selectedSupervisor, selectedSignal)
  }
  const validate = dependencies.validatePlan ?? validateExecutionPlan
  const createSupervisor = dependencies.createSupervisor ?? defaultSupervisorFactory
  try {
    await validate(root, selected)
  } catch (error) {
    write(`${summary(selected.length, 0, 0, 0, "failed")}\n`)
    throw error
  }

  let supervisor: ProcessSupervisor | null = null
  let primary: unknown = null
  let selectedPreflight: ProcessPreflightResult | null = null
  let started = 0
  let passed = 0
  const terminations: ProcessTermination[] = []
  const containments: ContainmentClaim[] = []
  const residuals: ResidualObservation[] = []
  try {
    supervisor = await createSupervisor(root, request)
    selectedPreflight = await supervisor.preflight()
    const observations = await probeRequiredRuntimeVersions(
      root,
      requiredToolsForPlan(selected),
      supervisor.run,
      dependencies.runtimeProbe
    )
    write(`${renderRuntimePreflight(observations, selectedPreflight)}\n`)
    assertRequiredRuntimeVersions(observations)

    for (const definition of selected) {
      signal?.throwIfAborted()
      started += 1
      const startedAt = performance.now()
      write(`${startedLine(definition, selectedPreflight)}\n`)
      try {
        const result = await execute(root, definition, supervisor, signal)
        if (definition.dockerOwnership === "children-with-invocation-backstop") {
          for (const line of examplesLines(result as ExamplesRunResult)) write(`${line}\n`)
        }
        terminations.push(result.termination)
        containments.push(result.containment)
        residuals.push(result.residual)
        passed += 1
        write(
          `[e2e] PASS ${definition.id} durationMs=${result.durationMs} termination=${result.termination} containment=${result.containment} residual=${result.residual}\n`
        )
      } catch (error) {
        const result = error instanceof DefinitionExecutionError ? error.result : null
        if (definition.dockerOwnership === "children-with-invocation-backstop" && result !== null) {
          try {
            const aggregate = parseExamplesRunResult(result)
            for (const line of examplesLines(aggregate)) write(`${line}\n`)
          } catch {
            // The fail-closed DefinitionExecutionError below preserves the command-shaped evidence.
          }
        }
        const termination = result?.termination ?? "supervisor-error"
        const containment = result?.containment ?? selectedPreflight.containment
        const residual = result?.residual ?? "inconclusive"
        terminations.push(termination)
        containments.push(containment)
        residuals.push(residual)
        write(
          `[e2e] FAIL ${definition.id} durationMs=${result?.durationMs ?? Math.round(performance.now() - startedAt)} termination=${termination} containment=${containment} residual=${residual} summary=${errorSummary(error)}\n`
        )
        throw error
      }
    }
  } catch (error) {
    primary = error
  }

  const cleanupFailures: CleanupFailure[] = []
  if (supervisor !== null) {
    await collectCleanupFailure(cleanupFailures, "process supervisor close", () =>
      supervisor.close()
    )
  }
  if (cleanupFailures.length > 0) {
    terminations.push("supervisor-error")
    residuals.push("inconclusive")
    if (selectedPreflight !== null) containments.push(selectedPreflight.containment)
  }
  const fallbackContainment = selectedPreflight?.containment ?? requestedContainment(request)
  if (primary !== null || cleanupFailures.length > 0) {
    write(
      `${summary(
        selected.length,
        started,
        passed,
        started - passed,
        "failed",
        terminations,
        containments,
        residuals,
        fallbackContainment
      )}\n`
    )
    finalizeWithCleanup(primary, cleanupFailures, "E2E failed and supervisor close failed")
  }
  write(
    `${summary(
      selected.length,
      started,
      passed,
      0,
      "passed",
      terminations,
      containments,
      residuals,
      fallbackContainment
    )}\n`
  )
}

export async function runE2e(
  root: string,
  args: readonly string[],
  signal?: AbortSignal,
  dependencies?: RunE2eDependencies
): Promise<void> {
  await runE2eRequest(root, parseE2eArguments(args), signal, dependencies)
}
