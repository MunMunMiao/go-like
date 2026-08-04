import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { readFile } from "node:fs/promises"
import { isAbsolute, normalize } from "node:path"

import type { FailureCategory, FailureRecord } from "./result"
import { readSecureDarwinProcessIdentity } from "./secure-filesystem"

export type { FailureRecord } from "./result"

export const ExampleProtocolLimits = Object.freeze({
  maximumAllowedExamples: 256,
  maximumCleanupFailures: 64,
  maximumCanonicalJsonBytes: 4 * 1024 * 1024,
  maximumIdentifierCharacters: 128,
  maximumPathCharacters: 4_096,
  maximumRequestClaims: 4_096,
  maximumScenarioArguments: 256
})

export interface AllowedExampleEntry {
  readonly id: string
  readonly packageName: string
  readonly cwdRealpath: string
  readonly childOwner: string
}

export type AllowedExample = AllowedExampleEntry
export type InvocationCapabilityAllowedEntry = AllowedExampleEntry

export type ResourceEventTestHook =
  | "none"
  | "kill-worker-before-registration"
  | "kill-worker-after-ack-before-scenario"
  | "kill-worker-after-first"
export type DockerDiagnosticsPolicy = "metadata-only" | "safe-redacted-logs"

export interface InvocationCapability {
  readonly schemaVersion: 1
  readonly invocation: string
  readonly nonceDigest: string
  readonly rootPid: number
  readonly rootStartIdentity: string
  readonly rootPrincipal: string
  readonly resultDirRealpath: string
  /** SHA-256 of the root-captured Docker CLI environment; selector values never enter IPC. */
  readonly dockerEnvironmentDigest: string
  readonly resourceEventTestHook: ResourceEventTestHook
  readonly dockerDiagnosticsPolicy: DockerDiagnosticsPolicy
  readonly allowedExamples: readonly AllowedExampleEntry[]
}

export interface ExampleParticipant {
  readonly schemaVersion: 1
  readonly id: string
  readonly packageName: string
  readonly cwdRealpath: string
  readonly workerPid: number
  readonly workerStartIdentity: string
  readonly childOwner: string | null
  readonly parentInvocation: string
  readonly startedAt: string
}

export type ExampleStatus = "passed" | "failed" | "timed-out" | "aborted"

export interface ExampleResult {
  readonly schemaVersion: 1
  readonly id: string
  readonly durationMs: number
  readonly exitCode: number | null
  readonly signal: string | null
  readonly timedOut: boolean
  readonly aborted: boolean
  readonly abortReason: string | null
  readonly cleanupFailures: readonly FailureRecord[]
  readonly childOwner: string | null
  readonly status: ExampleStatus
}

/** Authenticated payload sent after the root durably records one participant owner. */
export interface RegistrationAck {
  readonly id: string
  readonly childOwner: string
  readonly ackToken: string
  readonly requestId: string
}

/** Authenticated, replay-protected request to begin the worker's exactly-once graceful path. */
export interface GracefulControl {
  readonly id: string
  readonly childOwner: string
  readonly gracefulToken: string
  readonly requestId: string
}

export type ExampleResourceType = "container" | "network" | "volume"

/** Durable metadata written only after an owned resource create succeeds. */
export interface ResourceEvent {
  readonly schemaVersion: 1
  readonly id: string
  readonly resourceType: ExampleResourceType
  readonly resourceId: string
  readonly invocation: string
  readonly childOwner: string
  readonly createdAt: string
}

/** All non-secret values to which an ACK or graceful MAC is bound. */
export interface AuthenticatedControlBinding {
  readonly invocation: string
  readonly capabilityDigest: string
  readonly id: string
  readonly workerPid: number
  readonly workerStartIdentity: string
  readonly childOwner: string
  readonly requestId: string
}

/** A process observation used only for equality checks, never as signal authorization. */
export interface ProcessIdentity {
  readonly pid: number
  readonly ppid: number
  readonly pgid: number
  readonly startIdentity: string
  readonly principal: string
}

export interface DirectExampleInvocation {
  readonly mode: "direct"
  readonly scenarioArgv: readonly string[]
}

export interface WorkerExampleInvocation {
  readonly mode: "worker"
  readonly scenarioArgv: readonly string[]
  readonly capabilityPath: string
  readonly nonce: string
}

export type ExampleInvocation = DirectExampleInvocation | WorkerExampleInvocation

export interface ProtocolReplayGuard {
  readonly size: number
  readonly capacity: number
}

type JsonRecord = Readonly<Record<string, unknown>>
type ControlDomain = "registration-ack" | "graceful-control"

interface ReplayState {
  readonly claims: Set<string>
  readonly capacity: number
}

const IdentifierPattern = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/u
const OpaqueIdentityPattern = /^[A-Za-z0-9](?:[A-Za-z0-9_.:+-]{0,254}[A-Za-z0-9])?$/u
const OwnerPattern = /^[a-z0-9](?:[a-z0-9_.-]{0,126}[a-z0-9])?$/u
const RequestIdPattern = /^[a-z0-9](?:[a-z0-9_.:-]{0,126}[a-z0-9])?$/u
const PackageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const LowerHex256Pattern = /^[a-f0-9]{64}$/u
const ResourceIdPattern = /^[A-Za-z0-9](?:[A-Za-z0-9_.:-]{0,254}[A-Za-z0-9])?$/u
const FailureCodePattern = /^[a-z0-9](?:[a-z0-9_.-]{0,126}[a-z0-9])?$/u
const SignalPattern = /^SIG[A-Z0-9]{1,27}$/u
const ControlCharacterPattern = /[\u0000-\u001f\u007f]/u
const WorkerMarker = "--worker"
const MaximumPackageNameCharacters = 214
const MaximumFailureSummaryCharacters = 2_048
const MaximumAbortReasonCharacters = 2_048
const MaximumResourceDurationMs = 7 * 24 * 60 * 60 * 1_000
const MaximumCanonicalDepth = 64
const MaximumCanonicalNodes = 100_000
const MaximumCanonicalStringCharacters = 2 * 1024 * 1024
const MaximumProcessId = 2_147_483_647
const MaximumUid = 0xffff_ffff
const MaximumExitCode = 0xffff_ffff
const RegistrationAckDomain = "go-like-e2e/registration-ack/v1"
const GracefulControlDomain = "go-like-e2e/graceful-control/v1"
const replayStates = new WeakMap<ProtocolReplayGuard, ReplayState>()
const FailureCategories = Object.freeze([
  "primary",
  "signal",
  "timeout",
  "process-cleanup",
  "stream-drain",
  "docker",
  "filesystem",
  "security",
  "prerequisite"
] satisfies readonly FailureCategory[])

const AllowedExampleKeys = Object.freeze(["id", "packageName", "cwdRealpath", "childOwner"])
const InvocationCapabilityKeys = Object.freeze([
  "schemaVersion",
  "invocation",
  "nonceDigest",
  "rootPid",
  "rootStartIdentity",
  "rootPrincipal",
  "resultDirRealpath",
  "dockerEnvironmentDigest",
  "resourceEventTestHook",
  "dockerDiagnosticsPolicy",
  "allowedExamples"
])
const ParticipantKeys = Object.freeze([
  "schemaVersion",
  "id",
  "packageName",
  "cwdRealpath",
  "workerPid",
  "workerStartIdentity",
  "childOwner",
  "parentInvocation",
  "startedAt"
])
const ResultKeys = Object.freeze([
  "schemaVersion",
  "id",
  "durationMs",
  "exitCode",
  "signal",
  "timedOut",
  "aborted",
  "abortReason",
  "cleanupFailures",
  "childOwner",
  "status"
])
const FailureRecordKeys = Object.freeze(["code", "category", "summary"])
const RegistrationAckKeys = Object.freeze(["id", "childOwner", "ackToken", "requestId"])
const GracefulControlKeys = Object.freeze(["id", "childOwner", "gracefulToken", "requestId"])
const ResourceEventKeys = Object.freeze([
  "schemaVersion",
  "id",
  "resourceType",
  "resourceId",
  "invocation",
  "childOwner",
  "createdAt"
])
const AuthenticatedControlBindingKeys = Object.freeze([
  "invocation",
  "capabilityDigest",
  "id",
  "workerPid",
  "workerStartIdentity",
  "childOwner",
  "requestId"
])

function protocolError(message: string): Error {
  return new Error(message)
}

function exactRecord(value: unknown, label: string, expectedKeys: readonly string[]): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw protocolError(`${label} must be a plain object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw protocolError(`${label} must be a plain object`)
  }
  const keys = Reflect.ownKeys(value)
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) {
    throw protocolError(`${label} must contain exactly the protocol fields`)
  }
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw protocolError(`${label} must contain plain enumerable data fields`)
    }
  }
  return value as JsonRecord
}

function boundedArray(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number
): readonly unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw protocolError(`${label} is outside protocol array bounds`)
  }
  const ownKeys = Reflect.ownKeys(value)
  if (
    ownKeys.length !== value.length + 1 ||
    ownKeys.some(
      (key) =>
        key !== "length" &&
        (typeof key !== "string" ||
          !/^(?:0|[1-9][0-9]*)$/u.test(key) ||
          Number(key) >= value.length)
    )
  ) {
    throw protocolError(`${label} must be a dense array without additional fields`)
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw protocolError(`${label} must contain plain enumerable data elements`)
    }
  }
  return value
}

function boundedString(value: unknown, label: string, minimum: number, maximum: number): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
    throw protocolError(`${label} is outside protocol string bounds`)
  }
  return value
}

function patternedString(value: unknown, label: string, maximum: number, pattern: RegExp): string {
  const selected = boundedString(value, label, 1, maximum)
  if (!pattern.test(selected)) throw protocolError(`${label} has invalid syntax`)
  return selected
}

function safeInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw protocolError(`${label} is outside protocol integer bounds`)
  }
  return value
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw protocolError(`${label} must be a boolean`)
  return value
}

function schemaVersion(value: unknown, label: string): 1 {
  if (value !== 1) throw protocolError(`${label} must equal 1`)
  return 1
}

function enumValue<const Value extends string>(
  value: unknown,
  label: string,
  allowed: readonly Value[]
): Value {
  if (typeof value !== "string" || !allowed.includes(value as Value)) {
    throw protocolError(`${label} is not a supported protocol value`)
  }
  return value as Value
}

/** Validates one traversal-safe example identifier. */
export function validateExampleId(value: unknown): string {
  return patternedString(
    value,
    "example id",
    ExampleProtocolLimits.maximumIdentifierCharacters,
    IdentifierPattern
  )
}

/** Validates one bounded npm-style package identity. */
export function validateExamplePackageName(value: unknown): string {
  const selected = patternedString(
    value,
    "example package name",
    MaximumPackageNameCharacters,
    PackageNamePattern
  )
  if (selected.includes("..") || selected.endsWith(".") || selected.endsWith("/")) {
    throw protocolError("example package name has invalid syntax")
  }
  return selected
}

/** Validates one invocation label without treating it as a filesystem component. */
export function validateInvocation(value: unknown): string {
  const selected = patternedString(
    value,
    "invocation",
    ExampleProtocolLimits.maximumIdentifierCharacters,
    OwnerPattern
  )
  if (selected.includes("..")) throw protocolError("invocation has invalid syntax")
  return selected
}

/** Validates one preallocated child owner label. */
export function validateChildOwner(value: unknown): string {
  const selected = patternedString(
    value,
    "child owner",
    ExampleProtocolLimits.maximumIdentifierCharacters,
    OwnerPattern
  )
  if (selected.includes("..")) throw protocolError("child owner has invalid syntax")
  return selected
}

/** Validates one bounded control request identity. */
export function validateRequestId(value: unknown): string {
  const selected = patternedString(
    value,
    "request id",
    ExampleProtocolLimits.maximumIdentifierCharacters,
    RequestIdPattern
  )
  if (selected.includes("..")) throw protocolError("request id has invalid syntax")
  return selected
}

/** Validates a normalized absolute path without consulting the filesystem. */
export function validateAbsoluteProtocolPath(value: unknown): string {
  const selected = boundedString(
    value,
    "protocol path",
    1,
    ExampleProtocolLimits.maximumPathCharacters
  )
  if (
    ControlCharacterPattern.test(selected) ||
    !isAbsolute(selected) ||
    normalize(selected) !== selected
  ) {
    throw protocolError("protocol path must be normalized and absolute")
  }
  return selected
}

function opaqueIdentity(value: unknown, label: string): string {
  return patternedString(value, label, 256, OpaqueIdentityPattern)
}

function principal(value: unknown): string {
  const selected = boundedString(value, "process principal", 5, 64)
  if (!/^uid:(?:0|[1-9][0-9]{0,19})$/u.test(selected)) {
    throw protocolError("process principal has invalid syntax")
  }
  return selected
}

function lowerHex256(value: unknown, label: string): string {
  return patternedString(value, label, 64, LowerHex256Pattern)
}

function canonicalTimestamp(value: unknown, label: string): string {
  const selected = boundedString(value, label, 24, 24)
  const timestamp = Date.parse(selected)
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== selected) {
    throw protocolError(`${label} must be a canonical UTC timestamp`)
  }
  return selected
}

function nullableOwner(value: unknown): string | null {
  return value === null ? null : validateChildOwner(value)
}

function nullableSignal(value: unknown): string | null {
  if (value === null) return null
  return patternedString(value, "example result signal", 32, SignalPattern)
}

function nullableAbortReason(value: unknown): string | null {
  if (value === null) return null
  const selected = boundedString(
    value,
    "example result abort reason",
    1,
    MaximumAbortReasonCharacters
  )
  if (ControlCharacterPattern.test(selected)) {
    throw protocolError("example result abort reason contains control characters")
  }
  return selected
}

/** Strictly validates and freezes one capability allowed-example entry. */
export function parseAllowedExampleEntry(value: unknown): AllowedExampleEntry {
  const record = exactRecord(value, "allowed example entry", AllowedExampleKeys)
  return Object.freeze({
    id: validateExampleId(record.id),
    packageName: validateExamplePackageName(record.packageName),
    cwdRealpath: validateAbsoluteProtocolPath(record.cwdRealpath),
    childOwner: validateChildOwner(record.childOwner)
  })
}

/** Strictly validates and freezes an invocation capability. */
export function parseInvocationCapability(value: unknown): InvocationCapability {
  const record = exactRecord(value, "invocation capability", InvocationCapabilityKeys)
  const entries = boundedArray(
    record.allowedExamples,
    "invocation capability allowed examples",
    1,
    ExampleProtocolLimits.maximumAllowedExamples
  ).map(parseAllowedExampleEntry)
  const ids = new Set<string>()
  const packages = new Set<string>()
  const owners = new Set<string>()
  for (const entry of entries) {
    if (ids.has(entry.id) || packages.has(entry.packageName) || owners.has(entry.childOwner)) {
      throw protocolError("invocation capability contains a duplicate allowed identity")
    }
    ids.add(entry.id)
    packages.add(entry.packageName)
    owners.add(entry.childOwner)
  }
  return Object.freeze({
    schemaVersion: schemaVersion(record.schemaVersion, "invocation capability schema version"),
    invocation: validateInvocation(record.invocation),
    nonceDigest: lowerHex256(record.nonceDigest, "invocation capability nonce digest"),
    rootPid: safeInteger(record.rootPid, "invocation capability root PID", 1, MaximumProcessId),
    rootStartIdentity: opaqueIdentity(
      record.rootStartIdentity,
      "invocation capability root start identity"
    ),
    rootPrincipal: principal(record.rootPrincipal),
    resultDirRealpath: validateAbsoluteProtocolPath(record.resultDirRealpath),
    dockerEnvironmentDigest: lowerHex256(
      record.dockerEnvironmentDigest,
      "invocation capability Docker environment digest"
    ),
    resourceEventTestHook: enumValue(
      record.resourceEventTestHook,
      "invocation capability resource event test hook",
      [
        "none",
        "kill-worker-before-registration",
        "kill-worker-after-ack-before-scenario",
        "kill-worker-after-first"
      ] as const
    ),
    dockerDiagnosticsPolicy: enumValue(
      record.dockerDiagnosticsPolicy,
      "invocation capability Docker diagnostics policy",
      ["metadata-only", "safe-redacted-logs"] as const
    ),
    allowedExamples: Object.freeze(entries)
  })
}

/** Strictly validates and freezes one worker participant record. */
export function parseExampleParticipant(value: unknown): ExampleParticipant {
  const record = exactRecord(value, "example participant", ParticipantKeys)
  return Object.freeze({
    schemaVersion: schemaVersion(record.schemaVersion, "example participant schema version"),
    id: validateExampleId(record.id),
    packageName: validateExamplePackageName(record.packageName),
    cwdRealpath: validateAbsoluteProtocolPath(record.cwdRealpath),
    workerPid: safeInteger(record.workerPid, "example participant worker PID", 1, MaximumProcessId),
    workerStartIdentity: opaqueIdentity(
      record.workerStartIdentity,
      "example participant worker start identity"
    ),
    childOwner: nullableOwner(record.childOwner),
    parentInvocation: validateInvocation(record.parentInvocation),
    startedAt: canonicalTimestamp(record.startedAt, "example participant start time")
  })
}

/** Strictly validates and freezes one sanitized durable failure. */
export function parseFailureRecord(value: unknown): FailureRecord {
  const record = exactRecord(value, "failure record", FailureRecordKeys)
  const summary = boundedString(
    record.summary,
    "failure record summary",
    1,
    MaximumFailureSummaryCharacters
  )
  if (ControlCharacterPattern.test(summary)) {
    throw protocolError("failure record summary contains control characters")
  }
  return Object.freeze({
    code: patternedString(record.code, "failure record code", 128, FailureCodePattern),
    category: enumValue(record.category, "failure record category", FailureCategories),
    summary
  })
}

/** Strictly validates and freezes one example result record. */
export function parseExampleResult(value: unknown): ExampleResult {
  const record = exactRecord(value, "example result", ResultKeys)
  const timedOut = booleanValue(record.timedOut, "example result timedOut")
  const aborted = booleanValue(record.aborted, "example result aborted")
  const status = enumValue(record.status, "example result status", [
    "passed",
    "failed",
    "timed-out",
    "aborted"
  ] as const)
  const exitCode =
    record.exitCode === null
      ? null
      : safeInteger(record.exitCode, "example result exit code", 0, MaximumExitCode)
  const signal = nullableSignal(record.signal)
  const abortReason = nullableAbortReason(record.abortReason)
  const cleanupFailures = boundedArray(
    record.cleanupFailures,
    "example result cleanup failures",
    0,
    ExampleProtocolLimits.maximumCleanupFailures
  ).map(parseFailureRecord)
  if (timedOut && aborted) throw protocolError("example result cannot be timed out and aborted")
  if ((status === "timed-out") !== timedOut || (status === "aborted") !== aborted) {
    throw protocolError("example result status and termination flags disagree")
  }
  if ((abortReason !== null) !== aborted) {
    throw protocolError("example result abort reason and aborted flag disagree")
  }
  if (status === "passed" && (exitCode !== 0 || signal !== null || cleanupFailures.length !== 0)) {
    throw protocolError("passed example result contains a failure outcome")
  }
  return Object.freeze({
    schemaVersion: schemaVersion(record.schemaVersion, "example result schema version"),
    id: validateExampleId(record.id),
    durationMs: safeInteger(
      record.durationMs,
      "example result duration",
      0,
      MaximumResourceDurationMs
    ),
    exitCode,
    signal,
    timedOut,
    aborted,
    abortReason,
    cleanupFailures: Object.freeze(cleanupFailures),
    childOwner: nullableOwner(record.childOwner),
    status
  })
}

/** Strictly validates and freezes one registration acknowledgement. */
export function parseRegistrationAck(value: unknown): RegistrationAck {
  const record = exactRecord(value, "registration ACK", RegistrationAckKeys)
  return Object.freeze({
    id: validateExampleId(record.id),
    childOwner: validateChildOwner(record.childOwner),
    ackToken: lowerHex256(record.ackToken, "registration ACK token"),
    requestId: validateRequestId(record.requestId)
  })
}

/** Strictly validates and freezes one graceful control request. */
export function parseGracefulControl(value: unknown): GracefulControl {
  const record = exactRecord(value, "graceful control", GracefulControlKeys)
  return Object.freeze({
    id: validateExampleId(record.id),
    childOwner: validateChildOwner(record.childOwner),
    gracefulToken: lowerHex256(record.gracefulToken, "graceful control token"),
    requestId: validateRequestId(record.requestId)
  })
}

/** Strictly validates and freezes one durable owned-resource event. */
export function parseResourceEvent(value: unknown): ResourceEvent {
  const record = exactRecord(value, "resource event", ResourceEventKeys)
  return Object.freeze({
    schemaVersion: schemaVersion(record.schemaVersion, "resource event schema version"),
    id: validateExampleId(record.id),
    resourceType: enumValue(record.resourceType, "resource event type", [
      "container",
      "network",
      "volume"
    ] as const),
    resourceId: patternedString(
      record.resourceId,
      "resource event resource id",
      256,
      ResourceIdPattern
    ),
    invocation: validateInvocation(record.invocation),
    childOwner: validateChildOwner(record.childOwner),
    createdAt: canonicalTimestamp(record.createdAt, "resource event creation time")
  })
}

/** Strictly validates and freezes the complete MAC binding context. */
export function parseAuthenticatedControlBinding(value: unknown): AuthenticatedControlBinding {
  const record = exactRecord(
    value,
    "authenticated control binding",
    AuthenticatedControlBindingKeys
  )
  return Object.freeze({
    invocation: validateInvocation(record.invocation),
    capabilityDigest: lowerHex256(record.capabilityDigest, "capability digest"),
    id: validateExampleId(record.id),
    workerPid: safeInteger(record.workerPid, "control binding worker PID", 1, MaximumProcessId),
    workerStartIdentity: opaqueIdentity(
      record.workerStartIdentity,
      "control binding worker start identity"
    ),
    childOwner: validateChildOwner(record.childOwner),
    requestId: validateRequestId(record.requestId)
  })
}

interface CanonicalState {
  nodes: number
  remainingCodeUnits: number
  readonly active: WeakSet<object>
}

function consumeCanonicalCodeUnits(state: CanonicalState, count: number): void {
  state.remainingCodeUnits -= count
  if (state.remainingCodeUnits < 0) throw protocolError("canonical JSON exceeds byte bounds")
}

function canonicalObject(value: object, state: CanonicalState, depth: number): string {
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw protocolError("canonical JSON accepts only plain objects")
  }
  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.some((key) => typeof key !== "string")) {
    throw protocolError("canonical JSON does not accept symbol keys")
  }
  const keys = (ownKeys as string[]).sort()
  consumeCanonicalCodeUnits(state, 2 + Math.max(0, keys.length - 1))
  const fields: string[] = []
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw protocolError("canonical JSON accepts only enumerable data fields")
    }
    if (
      key.length > MaximumCanonicalStringCharacters ||
      key.length + 3 > state.remainingCodeUnits
    ) {
      throw protocolError("canonical JSON exceeds byte bounds")
    }
    const encodedKey = JSON.stringify(key)
    consumeCanonicalCodeUnits(state, encodedKey.length + 1)
    fields.push(`${encodedKey}:${canonicalValue(descriptor.value, state, depth + 1)}`)
  }
  return `{${fields.join(",")}}`
}

function canonicalArray(value: readonly unknown[], state: CanonicalState, depth: number): string {
  const ownKeys = Reflect.ownKeys(value)
  if (
    ownKeys.length !== value.length + 1 ||
    ownKeys.some(
      (key) =>
        key !== "length" &&
        (typeof key !== "string" ||
          !/^(?:0|[1-9][0-9]*)$/u.test(key) ||
          Number(key) >= value.length)
    )
  ) {
    throw protocolError("canonical JSON arrays must be dense and have no additional fields")
  }
  consumeCanonicalCodeUnits(state, 2 + Math.max(0, value.length - 1))
  const values: string[] = []
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw protocolError("canonical JSON arrays must contain enumerable data elements")
    }
    values.push(canonicalValue(descriptor.value, state, depth + 1))
  }
  return `[${values.join(",")}]`
}

function canonicalValue(value: unknown, state: CanonicalState, depth: number): string {
  if (depth > MaximumCanonicalDepth) throw protocolError("canonical JSON exceeds depth bounds")
  state.nodes += 1
  if (state.nodes > MaximumCanonicalNodes) throw protocolError("canonical JSON exceeds node bounds")
  if (value === null) {
    consumeCanonicalCodeUnits(state, 4)
    return "null"
  }
  if (typeof value === "boolean") {
    consumeCanonicalCodeUnits(state, value ? 4 : 5)
    return value ? "true" : "false"
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw protocolError("canonical JSON numbers must be finite")
    const encoded = JSON.stringify(value)
    consumeCanonicalCodeUnits(state, encoded.length)
    return encoded
  }
  if (typeof value === "string") {
    if (value.length > MaximumCanonicalStringCharacters) {
      throw protocolError("canonical JSON string exceeds bounds")
    }
    if (value.length + 2 > state.remainingCodeUnits) {
      throw protocolError("canonical JSON exceeds byte bounds")
    }
    const encoded = JSON.stringify(value)
    consumeCanonicalCodeUnits(state, encoded.length)
    return encoded
  }
  if (typeof value !== "object") throw protocolError("value is not canonical JSON data")
  if (state.active.has(value)) throw protocolError("canonical JSON must not contain cycles")
  state.active.add(value)
  try {
    return Array.isArray(value)
      ? canonicalArray(value, state, depth)
      : canonicalObject(value, state, depth)
  } finally {
    state.active.delete(value)
  }
}

/** Encodes JSON data with recursively sorted object keys and stable ECMAScript scalar encoding. */
export function canonicalJson(value: unknown): string {
  const encoded = canonicalValue(
    value,
    {
      nodes: 0,
      remainingCodeUnits: ExampleProtocolLimits.maximumCanonicalJsonBytes,
      active: new WeakSet<object>()
    },
    0
  )
  if (
    new TextEncoder().encode(encoded).byteLength > ExampleProtocolLimits.maximumCanonicalJsonBytes
  ) {
    throw protocolError("canonical JSON exceeds byte bounds")
  }
  return encoded
}

function decodeHex256(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || !LowerHex256Pattern.test(value)) return null
  return Uint8Array.from(Buffer.from(value, "hex"))
}

function constantTimeHex256Equal(expected: Uint8Array, candidate: unknown): boolean {
  const decoded = decodeHex256(candidate)
  const compared = decoded ?? new Uint8Array(32)
  const equal = timingSafeEqual(expected, compared)
  return decoded !== null && equal
}

/** Generates a 256-bit invocation nonce encoded as lowercase hexadecimal. */
export function generateInvocationNonce(): string {
  return randomBytes(32).toString("hex")
}

/** Generates one bounded replay identity for an authenticated control request. */
export function generateRequestId(): string {
  return validateRequestId(randomUUID())
}

/** Generates a cryptographically unique owner while retaining a bounded example prefix. */
export function generateChildOwner(exampleId: string): string {
  const id = validateExampleId(exampleId)
  return validateChildOwner(`${id.slice(0, 90)}-${randomBytes(16).toString("hex")}`)
}

/** Computes SHA-256 over the nonce bytes rather than over its hexadecimal presentation. */
export function digestInvocationNonce(nonce: string): string {
  const bytes = decodeHex256(nonce)
  if (bytes === null) throw protocolError("invocation nonce is invalid")
  return createHash("sha256").update(bytes).digest("hex")
}

/** Compares a supplied nonce with its expected digest in constant time. */
export function verifyInvocationNonce(nonce: unknown, expectedDigest: unknown): boolean {
  const bytes = decodeHex256(nonce)
  const expected = decodeHex256(expectedDigest)
  const actual = bytes === null ? new Uint8Array(32) : createHash("sha256").update(bytes).digest()
  const compared = expected ?? new Uint8Array(32)
  const equal = timingSafeEqual(actual, compared)
  return bytes !== null && expected !== null && equal
}

/** Computes SHA-256 over the strict canonical invocation capability. */
export function digestInvocationCapability(value: unknown): string {
  const capability = parseInvocationCapability(value)
  return createHash("sha256").update(canonicalJson(capability), "utf8").digest("hex")
}

function controlDomain(domain: ControlDomain): string {
  return domain === "registration-ack" ? RegistrationAckDomain : GracefulControlDomain
}

function controlMac(
  key: Uint8Array,
  domain: ControlDomain,
  binding: AuthenticatedControlBinding
): Uint8Array {
  return createHmac("sha256", key)
    .update(controlDomain(domain), "utf8")
    .update("\0", "utf8")
    .update(canonicalJson(binding), "utf8")
    .digest()
}

function generateControlToken(
  nonce: string,
  domain: ControlDomain,
  value: AuthenticatedControlBinding
): string {
  const binding = parseAuthenticatedControlBinding(value)
  const key = decodeHex256(nonce)
  if (key === null) throw protocolError("invocation nonce is invalid")
  return Buffer.from(controlMac(key, domain, binding)).toString("hex")
}

function verifyControlToken(
  nonce: unknown,
  token: unknown,
  domain: ControlDomain,
  value: AuthenticatedControlBinding
): boolean {
  const binding = parseAuthenticatedControlBinding(value)
  const supplied = decodeHex256(nonce)
  const expected = controlMac(supplied ?? new Uint8Array(32), domain, binding)
  const equal = constantTimeHex256Equal(expected, token)
  return supplied !== null && equal
}

/** Generates a domain-separated ACK MAC bound to the complete worker identity. */
export function generateRegistrationAckToken(
  nonce: string,
  binding: AuthenticatedControlBinding
): string {
  return generateControlToken(nonce, "registration-ack", binding)
}

/** Constant-time authentication check for an ACK token; replay handling is separate. */
export function verifyRegistrationAckToken(
  nonce: unknown,
  token: unknown,
  binding: AuthenticatedControlBinding
): boolean {
  return verifyControlToken(nonce, token, "registration-ack", binding)
}

/** Generates a separately domain-separated graceful-control MAC. */
export function generateGracefulToken(nonce: string, binding: AuthenticatedControlBinding): string {
  return generateControlToken(nonce, "graceful-control", binding)
}

/** Constant-time authentication check for a graceful token; replay handling is separate. */
export function verifyGracefulToken(
  nonce: unknown,
  token: unknown,
  binding: AuthenticatedControlBinding
): boolean {
  return verifyControlToken(nonce, token, "graceful-control", binding)
}

/** Creates one exact registration ACK payload. */
export function createRegistrationAck(
  nonce: string,
  value: AuthenticatedControlBinding
): RegistrationAck {
  const binding = parseAuthenticatedControlBinding(value)
  return Object.freeze({
    id: binding.id,
    childOwner: binding.childOwner,
    ackToken: generateRegistrationAckToken(nonce, binding),
    requestId: binding.requestId
  })
}

/** Creates one exact graceful control payload. */
export function createGracefulControl(
  nonce: string,
  value: AuthenticatedControlBinding
): GracefulControl {
  const binding = parseAuthenticatedControlBinding(value)
  return Object.freeze({
    id: binding.id,
    childOwner: binding.childOwner,
    gracefulToken: generateGracefulToken(nonce, binding),
    requestId: binding.requestId
  })
}

/** Creates a bounded fail-closed replay ledger. Capacity exhaustion never evicts old claims. */
export function createProtocolReplayGuard(capacity = 256): ProtocolReplayGuard {
  const selectedCapacity = safeInteger(
    capacity,
    "protocol replay guard capacity",
    1,
    ExampleProtocolLimits.maximumRequestClaims
  )
  const state: ReplayState = { claims: new Set<string>(), capacity: selectedCapacity }
  const guard = {
    get size(): number {
      return state.claims.size
    },
    capacity: selectedCapacity
  }
  Object.freeze(guard)
  replayStates.set(guard, state)
  return guard
}

function claimControlRequest(
  guard: ProtocolReplayGuard,
  domain: ControlDomain,
  binding: AuthenticatedControlBinding
): void {
  const state = replayStates.get(guard)
  if (state === undefined) throw protocolError("unknown protocol replay guard")
  const claim = createHash("sha256")
    .update(controlDomain(domain), "utf8")
    .update("\0", "utf8")
    .update(canonicalJson(binding), "utf8")
    .digest("hex")
  if (state.claims.has(claim)) throw protocolError("authenticated control request replay rejected")
  if (state.claims.size >= state.capacity) {
    throw protocolError("protocol replay guard capacity exhausted")
  }
  state.claims.add(claim)
}

function frameMatchesBinding(
  frame: { readonly id: string; readonly childOwner: string; readonly requestId: string },
  binding: AuthenticatedControlBinding
): boolean {
  return (
    frame.id === binding.id &&
    frame.childOwner === binding.childOwner &&
    frame.requestId === binding.requestId
  )
}

/** Authenticates and claims an ACK exactly once, failing without exposing token material. */
export function verifyRegistrationAck(
  value: unknown,
  nonce: unknown,
  expectedBinding: AuthenticatedControlBinding,
  replayGuard: ProtocolReplayGuard
): RegistrationAck {
  const ack = parseRegistrationAck(value)
  const binding = parseAuthenticatedControlBinding(expectedBinding)
  const authenticated = verifyRegistrationAckToken(nonce, ack.ackToken, binding)
  if (!frameMatchesBinding(ack, binding) || !authenticated) {
    throw protocolError("registration ACK authentication failed")
  }
  claimControlRequest(replayGuard, "registration-ack", binding)
  return ack
}

/** Authenticates and claims a graceful request exactly once, without exposing token material. */
export function verifyGracefulControl(
  value: unknown,
  nonce: unknown,
  expectedBinding: AuthenticatedControlBinding,
  replayGuard: ProtocolReplayGuard
): GracefulControl {
  const control = parseGracefulControl(value)
  const binding = parseAuthenticatedControlBinding(expectedBinding)
  const authenticated = verifyGracefulToken(nonce, control.gracefulToken, binding)
  if (!frameMatchesBinding(control, binding) || !authenticated) {
    throw protocolError("graceful control authentication failed")
  }
  claimControlRequest(replayGuard, "graceful-control", binding)
  return control
}

function scenarioArguments(value: readonly unknown[]): readonly string[] {
  if (value.length === 0 || value.length > ExampleProtocolLimits.maximumScenarioArguments) {
    throw protocolError("scenario argv is outside protocol bounds")
  }
  const argumentsSnapshot: string[] = []
  for (const argument of value) {
    if (typeof argument !== "string" || argument.length > 32_768) {
      throw protocolError("scenario argv contains an invalid argument")
    }
    argumentsSnapshot.push(argument)
  }
  if ((argumentsSnapshot[0]?.length ?? 0) === 0) {
    throw protocolError("scenario argv must begin with a non-empty argument")
  }
  return Object.freeze(argumentsSnapshot)
}

/**
 * Parses only a complete terminal `--worker <absolute capability path> <nonce>` frame.
 * Ambient environment variables are deliberately not inputs to this decision.
 */
export function parseTerminalWorkerFrame(argv: readonly unknown[]): ExampleInvocation {
  if (!Array.isArray(argv)) throw protocolError("example argv must be an array")
  if (argv.length === 0 || argv.length > ExampleProtocolLimits.maximumScenarioArguments + 3) {
    throw protocolError("example argv is outside protocol bounds")
  }
  const snapshot: string[] = []
  for (const argument of argv) {
    if (typeof argument !== "string" || argument.length > 32_768) {
      throw protocolError("example argv contains an invalid argument")
    }
    snapshot.push(argument)
  }
  const markerIndexes = snapshot.flatMap((argument, index) =>
    argument === WorkerMarker ? [index] : []
  )
  if (markerIndexes.length === 0) {
    return Object.freeze({ mode: "direct", scenarioArgv: scenarioArguments(snapshot) })
  }
  const markerIndex = markerIndexes[0]
  if (
    markerIndexes.length !== 1 ||
    markerIndex === undefined ||
    snapshot[markerIndex] !== WorkerMarker ||
    markerIndex !== snapshot.length - 3
  ) {
    throw protocolError("internal worker control frame is invalid")
  }
  const scenarioArgv = scenarioArguments(snapshot.slice(0, markerIndex))
  return Object.freeze({
    mode: "worker",
    scenarioArgv,
    capabilityPath: validateAbsoluteProtocolPath(snapshot[markerIndex + 1]),
    nonce: lowerHex256(snapshot[markerIndex + 2], "worker invocation nonce")
  })
}

function processId(value: unknown): number {
  return safeInteger(value, "process PID", 1, MaximumProcessId)
}

function parseDecimalInteger(value: string, minimum: number, maximum: number): number | null {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) return null
  const selected = Number(value)
  return Number.isSafeInteger(selected) && selected >= minimum && selected <= maximum
    ? selected
    : null
}

interface LinuxStatIdentity {
  readonly pid: number
  readonly ppid: number
  readonly pgid: number
  readonly state: string
  readonly startIdentity: string
}

function parseLinuxStat(value: string, expectedPid: number): LinuxStatIdentity | null {
  const commandEnd = value.lastIndexOf(")")
  const commandStart = value.indexOf("(")
  if (commandStart < 1 || commandEnd <= commandStart || value[commandEnd + 1] !== " ") return null
  const observedPid = parseDecimalInteger(value.slice(0, commandStart).trim(), 1, MaximumProcessId)
  const fields = value
    .slice(commandEnd + 2)
    .trim()
    .split(/\s+/u)
  const state = fields[0]
  const ppidField = fields[1]
  const pgidField = fields[2]
  const startField = fields[19]
  if (
    observedPid !== expectedPid ||
    state === undefined ||
    state.length !== 1 ||
    state === "Z" ||
    state === "X" ||
    ppidField === undefined ||
    pgidField === undefined ||
    startField === undefined
  ) {
    return null
  }
  const ppid = parseDecimalInteger(ppidField, 0, MaximumProcessId)
  const pgid = parseDecimalInteger(pgidField, 1, MaximumProcessId)
  if (ppid === null || pgid === null || !/^[1-9][0-9]*$/u.test(startField)) return null
  return Object.freeze({
    pid: expectedPid,
    ppid,
    pgid,
    state,
    startIdentity: `linux:${startField}`
  })
}

function parseLinuxPrincipal(value: string): string | null {
  const uidLine = value.split("\n").find((line) => line.startsWith("Uid:"))
  if (uidLine === undefined) return null
  const fields = uidLine.trim().split(/\s+/u)
  const realUid = fields[1]
  if (realUid === undefined || parseDecimalInteger(realUid, 0, MaximumUid) === null) {
    return null
  }
  return `uid:${realUid}`
}

async function readLinuxProcessIdentity(pid: number): Promise<ProcessIdentity> {
  try {
    const first = parseLinuxStat(await readFile(`/proc/${pid}/stat`, "utf8"), pid)
    if (first === null) throw protocolError("process identity is unavailable")
    const observedPrincipal = parseLinuxPrincipal(await readFile(`/proc/${pid}/status`, "utf8"))
    const second = parseLinuxStat(await readFile(`/proc/${pid}/stat`, "utf8"), pid)
    if (
      observedPrincipal === null ||
      second === null ||
      first.startIdentity !== second.startIdentity ||
      first.ppid !== second.ppid ||
      first.pgid !== second.pgid
    ) {
      throw protocolError("process identity is unavailable")
    }
    return Object.freeze({
      pid,
      ppid: second.ppid,
      pgid: second.pgid,
      startIdentity: second.startIdentity,
      principal: observedPrincipal
    })
  } catch {
    throw protocolError("process identity is unavailable")
  }
}

async function readDarwinProcessIdentity(pid: number): Promise<ProcessIdentity> {
  try {
    const observed = await readSecureDarwinProcessIdentity(pid)
    if (
      observed.pid !== pid ||
      observed.ppid < 0 ||
      observed.ppid > MaximumProcessId ||
      observed.pgid < 1 ||
      observed.pgid > MaximumProcessId ||
      observed.uid < 0 ||
      observed.uid > MaximumUid ||
      observed.startMicroseconds < 1n
    ) {
      throw protocolError("process identity is unavailable")
    }
    return Object.freeze({
      pid,
      ppid: observed.ppid,
      pgid: observed.pgid,
      startIdentity: `darwin:${observed.startMicroseconds}`,
      principal: `uid:${observed.uid}`
    })
  } catch {
    throw protocolError("process identity is unavailable")
  }
}

/** Returns the current POSIX principal without consulting ambient environment variables. */
export function currentPrincipal(): string {
  if (typeof process.getuid !== "function") {
    throw protocolError("current process principal is unavailable on this platform")
  }
  return principal(`uid:${process.getuid()}`)
}

/** Reads a live PID/start identity on Linux or macOS for later exact matching only. */
export async function readProcessIdentity(pidValue: number): Promise<ProcessIdentity> {
  const pid = processId(pidValue)
  if (process.platform === "linux") return await readLinuxProcessIdentity(pid)
  if (process.platform === "darwin") return await readDarwinProcessIdentity(pid)
  throw protocolError("process identity is unavailable on this platform")
}

/** Reads and verifies the current process identity against the current principal. */
export async function currentProcessIdentity(): Promise<ProcessIdentity> {
  const identity = await readProcessIdentity(process.pid)
  if (identity.principal !== currentPrincipal()) {
    throw protocolError("current process identity does not match the current principal")
  }
  return identity
}

/**
 * Matches a capability root to a live start identity and the current principal.
 * This observation intentionally grants no authority to signal the numeric PID.
 */
export async function assertInvocationRootIdentity(value: unknown): Promise<ProcessIdentity> {
  const capability = parseInvocationCapability(value)
  if (capability.rootPrincipal !== currentPrincipal()) {
    throw protocolError("invocation root identity does not match the current principal")
  }
  let observed: ProcessIdentity
  try {
    observed = await readProcessIdentity(capability.rootPid)
  } catch {
    throw protocolError("invocation root process identity is unavailable or changed")
  }
  if (
    observed.principal !== capability.rootPrincipal ||
    observed.startIdentity !== capability.rootStartIdentity
  ) {
    throw protocolError("invocation root process identity is unavailable or changed")
  }
  return observed
}
