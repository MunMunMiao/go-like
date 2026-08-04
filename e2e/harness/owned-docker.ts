import { randomUUID, timingSafeEqual } from "node:crypto"
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path"

import { boundedTail, errorSummary, redactText } from "./diagnostics"
import {
  closeDurableJsonDirectory,
  openDurableJsonDirectory,
  readDurableJson,
  writeDurableJson,
  type DurableJsonDirectory
} from "./durable-json"
import {
  canonicalJson,
  digestInvocationCapability,
  parseAuthenticatedControlBinding,
  parseInvocationCapability,
  parseRegistrationAck,
  parseResourceEvent,
  readProcessIdentity,
  validateAbsoluteProtocolPath,
  type AllowedExampleEntry,
  type AuthenticatedControlBinding,
  type ExampleResourceType,
  type InvocationCapability,
  type ProcessIdentity,
  type RegistrationAck,
  type ResourceEvent
} from "./example-protocol"
import {
  applyDockerEnvironment,
  digestDockerEnvironment,
  dockerEnvironmentOverrides,
  parseDockerEnvironmentSnapshot,
  type DockerEnvironmentSnapshot
} from "./docker-environment"
import { DockerInvocationLabelKey, DockerOwnerLabelKey } from "./docker-pairs"
import {
  runCommand,
  type CommandDefinition,
  type CommandResult,
  type ProcessSupervisor
} from "./process"
import { canonicalTempRoot } from "./temp"

declare const OwnedDockerContextBrand: unique symbol

/** An opaque runtime capability issued only after a complete worker authority check. */
export interface OwnedDockerContext {
  readonly [OwnedDockerContextBrand]: true
}

export type OwnedDockerDiagnosticsPolicy = "metadata-only" | "safe-redacted-logs"

/**
 * The complete bearer authority handed to a scenario by its authenticated worker. Ambient
 * labels or partial environment variables are deliberately insufficient to create a context.
 */
export interface ScenarioDockerAuthority {
  readonly schemaVersion: 1
  /** Canonical immutable capability file; the aggregate capability itself never enters env. */
  readonly capabilityPath: string
  readonly capabilityDigest: string
  readonly workerPid: number
  readonly workerStartIdentity: string
  readonly registrationAck: RegistrationAck
}

export interface OwnedDockerResource<Type extends ExampleResourceType = ExampleResourceType> {
  readonly type: Type
  readonly id: string
  readonly display: string
}

export interface OwnedDockerCreateOptions {
  readonly timeoutMs?: number | undefined
  readonly knownSecrets?: readonly string[] | undefined
}

export interface OwnedDockerLogOptions {
  readonly timeoutMs?: number | undefined
  readonly maximumCharacters?: number | undefined
  readonly knownSecrets?: readonly string[] | undefined
}

export interface OwnedDockerDependencies {
  readonly runner?: ProcessSupervisor["run"] | undefined
  /** Injectable because the current protocol's native reader supports only macOS and Linux. */
  readonly identityReader?: ((pid: number) => Promise<ProcessIdentity>) | undefined
  readonly now?: (() => Date) | undefined
  /** Test-only deterministic cut point. It runs after durable event publication and is awaited. */
  readonly afterEvent?:
    | ((event: ResourceEvent, resource: OwnedDockerResource) => void | Promise<void>)
    | undefined
}

export const OwnedDockerEnvironmentKey = "GO_LIKE_E2E_OWNED_DOCKER_AUTHORITY_V1"
export const OwnedDockerEnvironmentKeys = Object.freeze([OwnedDockerEnvironmentKey] as const)

export type OwnedDockerEnvironment = Readonly<
  Record<(typeof OwnedDockerEnvironmentKeys)[number], string | undefined>
>

interface VerifiedAuthority {
  readonly authority: ScenarioDockerAuthority
  readonly capability: InvocationCapability
  readonly currentExample: AllowedExampleEntry
  readonly dockerEnvironment: DockerEnvironmentSnapshot
  readonly resourceEventPath: string
  readonly diagnosticsPolicy: OwnedDockerDiagnosticsPolicy
}

interface ContextState {
  readonly verified: VerifiedAuthority
  readonly eventDirectory: DurableJsonDirectory
  readonly runner: ProcessSupervisor["run"]
  readonly identityReader: (pid: number) => Promise<ProcessIdentity>
  readonly now: () => Date
  readonly afterEvent:
    | ((event: ResourceEvent, resource: OwnedDockerResource) => void | Promise<void>)
    | undefined
  readonly createdResources: Map<OwnedDockerResource, ExampleResourceType>
  queue: Promise<void>
  status: "open" | "closing"
}

interface ParsedCreateOptions {
  readonly timeoutMs: number
  readonly knownSecrets: readonly string[]
}

interface ParsedLogOptions {
  readonly timeoutMs: number
  readonly maximumCharacters: number
  readonly knownSecrets: readonly string[]
}

type JsonRecord = Readonly<Record<string, unknown>>

const AuthorityKeys = Object.freeze([
  "schemaVersion",
  "capabilityPath",
  "capabilityDigest",
  "workerPid",
  "workerStartIdentity",
  "registrationAck"
])
const CreateOptionKeys = Object.freeze(["timeoutMs", "knownSecrets"])
const LogOptionKeys = Object.freeze(["timeoutMs", "maximumCharacters", "knownSecrets"])
const LowerHex256Pattern = /^[a-f0-9]{64}$/u
const DockerCreateIdPattern = /^[a-f0-9]{64}$/u
const DockerVolumeNamePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{1,127}$/u
const EnvironmentAuthorityMaximumCharacters = 4_096
const DockerEnvironmentComponent = "docker-environment.json"
const MaximumArgumentCount = 256
const MaximumArgumentCharacters = 32_768
const MaximumArgumentBytes = 128 * 1024
const MaximumCallerKnownSecrets = 254
const MaximumDockerOutputCharacters = 4_096
const DefaultCreateTimeoutMs = 30_000
const MaximumCreateTimeoutMs = 120_000
const DefaultLogTimeoutMs = 10_000
const MaximumLogTimeoutMs = 30_000
const DefaultLogCharacters = 8_192
const MaximumLogCharacters = 65_536
const DockerLogTailLines = 200
const OwnershipLabelKeys = new Set([DockerOwnerLabelKey, DockerInvocationLabelKey])
const issuedContexts = new WeakMap<object, ContextState>()
const encoder = new TextEncoder()

function exactRecord(value: unknown, label: string, expectedKeys: readonly string[]): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`)
  }
  const keys = Reflect.ownKeys(value)
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) {
    throw new Error(`${label} must contain exactly the expected fields`)
  }
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error(`${label} must contain plain enumerable data fields`)
    }
  }
  return value as JsonRecord
}

function exactOptionalRecord(
  value: unknown,
  label: string,
  allowedKeys: readonly string[]
): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`)
  }
  const keys = Reflect.ownKeys(value)
  if (keys.some((key) => typeof key !== "string" || !allowedKeys.includes(key))) {
    throw new Error(`${label} contains an unknown field`)
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error(`${label} must contain plain enumerable data fields`)
    }
  }
  return value as JsonRecord
}

function exactDenseArray(value: unknown, label: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`${label} is outside the supported bounds`)
  }
  const keys = Reflect.ownKeys(value)
  if (
    keys.length !== value.length + 1 ||
    keys.some(
      (key) =>
        key !== "length" &&
        (typeof key !== "string" ||
          !/^(?:0|[1-9][0-9]*)$/u.test(key) ||
          Number(key) >= value.length)
    )
  ) {
    throw new Error(`${label} must be a dense array without additional fields`)
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error(`${label} must contain plain enumerable data elements`)
    }
  }
  return value
}

function lowerHex256(value: unknown, label: string): string {
  if (typeof value !== "string" || !LowerHex256Pattern.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 value`)
  }
  return value
}

function safeInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${label} is outside the supported bounds`)
  }
  return value
}

function authorityPolicy(value: unknown): OwnedDockerDiagnosticsPolicy {
  if (value !== "metadata-only" && value !== "safe-redacted-logs") {
    throw new Error("scenario Docker diagnostics policy is unsupported")
  }
  return value
}

/** Strictly snapshots the exact compact worker-to-scenario bearer without granting it yet. */
export function parseScenarioDockerAuthority(value: unknown): ScenarioDockerAuthority {
  const record = exactRecord(value, "scenario Docker authority", AuthorityKeys)
  if (record.schemaVersion !== 1) {
    throw new Error("scenario Docker authority schema version must equal 1")
  }
  const registrationAck = parseRegistrationAck(record.registrationAck)
  const capabilityDigest = lowerHex256(record.capabilityDigest, "scenario capability digest")
  const workerPid = safeInteger(record.workerPid, "scenario worker PID", 1, 2_147_483_647)
  const workerStartIdentity = parseAuthenticatedControlBinding({
    invocation: registrationAck.id,
    capabilityDigest,
    id: registrationAck.id,
    workerPid,
    workerStartIdentity: record.workerStartIdentity,
    childOwner: registrationAck.childOwner,
    requestId: registrationAck.requestId
  }).workerStartIdentity
  return Object.freeze({
    schemaVersion: 1,
    capabilityPath: validateAbsoluteProtocolPath(record.capabilityPath),
    capabilityDigest,
    workerPid,
    workerStartIdentity,
    registrationAck
  })
}

function hexEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex")
  const rightBytes = Buffer.from(right, "hex")
  return (
    leftBytes.byteLength === 32 &&
    rightBytes.byteLength === 32 &&
    timingSafeEqual(leftBytes, rightBytes)
  )
}

function validObservedIdentity(value: unknown, requestedPid: number): ProcessIdentity | null {
  if (value === null || typeof value !== "object") return null
  const candidate = value as Partial<ProcessIdentity>
  if (
    candidate.pid !== requestedPid ||
    !Number.isSafeInteger(candidate.ppid) ||
    !Number.isSafeInteger(candidate.pgid) ||
    typeof candidate.startIdentity !== "string" ||
    candidate.startIdentity.length === 0 ||
    typeof candidate.principal !== "string" ||
    candidate.principal.length === 0
  ) {
    return null
  }
  return candidate as ProcessIdentity
}

async function observedIdentity(
  reader: (pid: number) => Promise<ProcessIdentity>,
  pid: number,
  label: "root" | "worker"
): Promise<ProcessIdentity> {
  try {
    const identity = validObservedIdentity(await reader(pid), pid)
    if (identity !== null) return identity
  } catch {
    // The fail-closed error below intentionally does not retain raw reader diagnostics.
  }
  throw new Error(`Owned Docker ${label} process identity is unavailable or expired`)
}

function capabilityEntry(
  capability: InvocationCapability,
  authority: ScenarioDockerAuthority
): AllowedExampleEntry {
  const ack = authority.registrationAck
  const matches = capability.allowedExamples.filter(
    (entry) => entry.id === ack.id && entry.childOwner === ack.childOwner
  )
  const selected = matches[0]
  if (matches.length !== 1 || selected === undefined) {
    throw new Error("Owned Docker current example is not authorized by the capability")
  }
  return selected
}

function authorityBinding(
  capability: InvocationCapability,
  authority: ScenarioDockerAuthority,
  currentExample: AllowedExampleEntry
): AuthenticatedControlBinding {
  return parseAuthenticatedControlBinding({
    invocation: capability.invocation,
    capabilityDigest: authority.capabilityDigest,
    id: currentExample.id,
    workerPid: authority.workerPid,
    workerStartIdentity: authority.workerStartIdentity,
    childOwner: currentExample.childOwner,
    requestId: authority.registrationAck.requestId
  })
}

interface RegistrationArtifact {
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

const RegistrationArtifactKeys = Object.freeze([
  "schemaVersion",
  "invocation",
  "capabilityDigest",
  "id",
  "packageName",
  "cwdRealpath",
  "workerPid",
  "workerStartIdentity",
  "childOwner",
  "requestId",
  "registeredAt"
])

function parseRegistrationArtifact(value: unknown): RegistrationArtifact {
  const record = exactRecord(value, "Owned Docker durable registration", RegistrationArtifactKeys)
  const binding = parseAuthenticatedControlBinding({
    invocation: record.invocation,
    capabilityDigest: record.capabilityDigest,
    id: record.id,
    workerPid: record.workerPid,
    workerStartIdentity: record.workerStartIdentity,
    childOwner: record.childOwner,
    requestId: record.requestId
  })
  const registeredAt = typeof record.registeredAt === "string" ? record.registeredAt : ""
  const registeredTime = Date.parse(registeredAt)
  if (
    record.schemaVersion !== 1 ||
    typeof record.packageName !== "string" ||
    typeof record.cwdRealpath !== "string" ||
    !Number.isFinite(registeredTime) ||
    new Date(registeredTime).toISOString() !== registeredAt
  ) {
    throw new Error("Owned Docker durable registration is invalid")
  }
  return Object.freeze({
    schemaVersion: 1,
    ...binding,
    packageName: record.packageName,
    cwdRealpath: validateAbsoluteProtocolPath(record.cwdRealpath),
    registeredAt
  })
}

async function verifyAuthority(
  authority: ScenarioDockerAuthority,
  identityReader: (pid: number) => Promise<ProcessIdentity>
): Promise<VerifiedAuthority> {
  const invocationRoot = dirname(authority.capabilityPath)
  if (basename(authority.capabilityPath) !== "capability.json") {
    throw new Error("Owned Docker capability path does not match the invocation layout")
  }
  let rootDirectory: DurableJsonDirectory | null = null
  let registrations: DurableJsonDirectory | null = null
  let acks: DurableJsonDirectory | null = null
  try {
    rootDirectory = await openDurableJsonDirectory(invocationRoot)
    registrations = await openDurableJsonDirectory(join(invocationRoot, "registrations"), {
      containedRoot: invocationRoot
    })
    acks = await openDurableJsonDirectory(join(invocationRoot, "acks"), {
      containedRoot: invocationRoot
    })
    const capability = parseInvocationCapability(
      await readDurableJson(rootDirectory, "capability.json")
    )
    if (
      capability.resultDirRealpath !== invocationRoot ||
      authority.capabilityPath !== join(invocationRoot, "capability.json") ||
      !hexEqual(digestInvocationCapability(capability), authority.capabilityDigest)
    ) {
      throw new Error("Owned Docker capability digest authentication failed")
    }
    const dockerEnvironment = parseDockerEnvironmentSnapshot(
      await readDurableJson(rootDirectory, DockerEnvironmentComponent)
    )
    if (!hexEqual(digestDockerEnvironment(dockerEnvironment), capability.dockerEnvironmentDigest)) {
      throw new Error("Owned Docker environment digest authentication failed")
    }
    const currentExample = capabilityEntry(capability, authority)
    const binding = authorityBinding(capability, authority, currentExample)
    const registration = parseRegistrationArtifact(
      await readDurableJson(registrations, `registered-${currentExample.id}.json`)
    )
    const rootAck = parseRegistrationAck(await readDurableJson(acks, `${currentExample.id}.json`))
    const ack = authority.registrationAck
    if (
      registration.invocation !== binding.invocation ||
      registration.capabilityDigest !== binding.capabilityDigest ||
      registration.id !== binding.id ||
      registration.workerPid !== binding.workerPid ||
      registration.workerStartIdentity !== binding.workerStartIdentity ||
      registration.childOwner !== binding.childOwner ||
      registration.requestId !== binding.requestId ||
      registration.packageName !== currentExample.packageName ||
      registration.cwdRealpath !== currentExample.cwdRealpath ||
      rootAck.id !== binding.id ||
      rootAck.childOwner !== binding.childOwner ||
      rootAck.requestId !== binding.requestId ||
      !hexEqual(rootAck.ackToken, ack.ackToken) ||
      ack.id !== binding.id ||
      ack.childOwner !== binding.childOwner ||
      ack.requestId !== binding.requestId
    ) {
      throw new Error("Owned Docker registration ACK authentication failed")
    }

    const [root, worker] = await Promise.all([
      observedIdentity(identityReader, capability.rootPid, "root"),
      observedIdentity(identityReader, authority.workerPid, "worker")
    ])
    if (
      root.startIdentity !== capability.rootStartIdentity ||
      root.principal !== capability.rootPrincipal
    ) {
      throw new Error("Owned Docker root process identity is unavailable or expired")
    }
    if (
      worker.startIdentity !== authority.workerStartIdentity ||
      worker.principal !== capability.rootPrincipal
    ) {
      throw new Error("Owned Docker worker process identity is unavailable or expired")
    }
    return Object.freeze({
      authority,
      capability,
      currentExample,
      dockerEnvironment,
      resourceEventPath: join(capability.resultDirRealpath, "resources"),
      diagnosticsPolicy: authorityPolicy(capability.dockerDiagnosticsPolicy)
    })
  } finally {
    if (acks !== null) await closeDurableJsonDirectory(acks).catch(() => {})
    if (registrations !== null) await closeDurableJsonDirectory(registrations).catch(() => {})
    if (rootDirectory !== null) await closeDurableJsonDirectory(rootDirectory).catch(() => {})
  }
}

function isContainedOrEqual(root: string, candidate: string): boolean {
  if (root === candidate) return true
  const child = relative(root, candidate)
  return child.length > 0 && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

async function openEventDirectory(verified: VerifiedAuthority): Promise<DurableJsonDirectory> {
  let resultDirectory: DurableJsonDirectory | null = null
  let eventDirectory: DurableJsonDirectory | null = null
  try {
    const trustedTemp = await canonicalTempRoot()
    const resultPath = verified.capability.resultDirRealpath
    const eventPath = verified.resourceEventPath
    if (!isContainedOrEqual(resultPath, eventPath)) {
      throw new Error("invalid event directory containment")
    }
    resultDirectory = await openDurableJsonDirectory(resultPath, {
      containedRoot: trustedTemp
    })
    if (eventPath === resultPath) return resultDirectory
    eventDirectory = await openDurableJsonDirectory(eventPath, {
      containedRoot: trustedTemp
    })
    await closeDurableJsonDirectory(resultDirectory)
    resultDirectory = null
    return eventDirectory
  } catch {
    if (eventDirectory !== null) await closeDurableJsonDirectory(eventDirectory).catch(() => {})
    if (resultDirectory !== null) await closeDurableJsonDirectory(resultDirectory).catch(() => {})
    throw new Error("Owned Docker resource event directory validation failed")
  }
}

/**
 * Produces the one exact child-environment override. Passing null/undefined gives direct wrappers
 * an explicit way to remove a stale inherited capability.
 */
export function authorityToEnvironment(
  authority?: ScenarioDockerAuthority | null
): OwnedDockerEnvironment {
  return Object.freeze({
    [OwnedDockerEnvironmentKey]:
      authority === null || authority === undefined
        ? undefined
        : canonicalJson(parseScenarioDockerAuthority(authority))
  })
}

function environmentAuthority(
  environment: Readonly<Record<string, string | undefined>>
): ScenarioDockerAuthority {
  if (environment === null || typeof environment !== "object") {
    throw new Error("Owned Docker environment transport must be an explicit object")
  }
  const unexpected = Object.keys(environment).filter(
    (key) =>
      key.startsWith("GO_LIKE_E2E_OWNED_DOCKER_") &&
      !OwnedDockerEnvironmentKeys.includes(key as never)
  )
  if (unexpected.length !== 0) {
    throw new Error("Owned Docker environment contains an unknown authority key")
  }
  const descriptor = Object.getOwnPropertyDescriptor(environment, OwnedDockerEnvironmentKey)
  if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
    throw new Error("Owned Docker environment does not contain an explicit authority")
  }
  const encoded = descriptor.value
  if (
    typeof encoded !== "string" ||
    encoded.length === 0 ||
    encoded.length > EnvironmentAuthorityMaximumCharacters ||
    encoded.includes("\0")
  ) {
    throw new Error("Owned Docker environment authority transport is invalid")
  }
  let value: unknown
  try {
    value = JSON.parse(encoded) as unknown
  } catch {
    throw new Error("Owned Docker environment authority transport is invalid")
  }
  return parseScenarioDockerAuthority(value)
}

/** Constructs an opaque context from one explicit worker-issued authority. */
export async function ownedDockerContextFromAuthority(
  value: unknown,
  dependencies: OwnedDockerDependencies = Object.freeze({})
): Promise<OwnedDockerContext> {
  const authority = parseScenarioDockerAuthority(value)
  const identityReader = dependencies.identityReader ?? readProcessIdentity
  const verified = await verifyAuthority(authority, identityReader)
  const eventDirectory = await openEventDirectory(verified)
  const context = Object.freeze({}) as OwnedDockerContext
  issuedContexts.set(context, {
    verified,
    eventDirectory,
    runner: dependencies.runner ?? runCommand,
    identityReader,
    now: dependencies.now ?? (() => new Date()),
    afterEvent: dependencies.afterEvent,
    createdResources: new Map<OwnedDockerResource, ExampleResourceType>(),
    queue: Promise.resolve(),
    status: "open"
  })
  return context
}

/** Alias emphasizing that construction, rather than a type cast, grants the capability. */
export async function createOwnedDockerContext(
  authority: unknown,
  dependencies: OwnedDockerDependencies = Object.freeze({})
): Promise<OwnedDockerContext> {
  return await ownedDockerContextFromAuthority(authority, dependencies)
}

/**
 * Decodes only the explicitly supplied environment object, then performs the same complete
 * cryptographic, live-identity, example, and filesystem checks as direct authority construction.
 */
export async function ownedDockerContextFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  dependencies: OwnedDockerDependencies = Object.freeze({})
): Promise<OwnedDockerContext> {
  return await ownedDockerContextFromAuthority(environmentAuthority(environment), dependencies)
}

function contextState(context: OwnedDockerContext): ContextState {
  if ((typeof context !== "object" && typeof context !== "function") || context === null) {
    throw new Error("unknown or expired OwnedDockerContext")
  }
  const state = issuedContexts.get(context)
  if (state === undefined || state.status !== "open") {
    throw new Error("unknown or expired OwnedDockerContext")
  }
  return state
}

/** Applies this opaque context's authenticated Docker selector and removes the bearer authority. */
export function scenarioDockerEnvironment(
  context: OwnedDockerContext,
  environment: Readonly<Record<string, string | undefined>> = process.env
): Readonly<Record<string, string | undefined>> {
  const state = contextState(context)
  return Object.freeze({
    ...applyDockerEnvironment(state.verified.dockerEnvironment, environment),
    ...authorityToEnvironment(null)
  })
}

function contextOperation<T>(
  context: OwnedDockerContext,
  operation: (state: ContextState) => Promise<T>
): Promise<T> {
  const state = contextState(context)
  const result = state.queue.then(async () => await operation(state))
  state.queue = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

/** Closes the retained event-directory handle and permanently expires the context. */
export async function closeOwnedDockerContext(context: OwnedDockerContext): Promise<void> {
  const state = contextState(context)
  state.status = "closing"
  const closing = state.queue.then(
    async () => await closeDurableJsonDirectory(state.eventDirectory)
  )
  state.queue = closing.then(
    () => undefined,
    () => undefined
  )
  try {
    await closing
  } finally {
    issuedContexts.delete(context)
  }
}

function argumentTail(value: unknown): readonly string[] {
  const values = exactDenseArray(value, "Owned Docker argument tail", MaximumArgumentCount)
  const snapshot: string[] = []
  let bytes = 0
  for (const value of values) {
    if (
      typeof value !== "string" ||
      value.length > MaximumArgumentCharacters ||
      value.includes("\0")
    ) {
      throw new Error("Owned Docker argument tail contains an unsafe argument")
    }
    bytes += encoder.encode(value).byteLength
    if (bytes > MaximumArgumentBytes) {
      throw new Error("Owned Docker argument tail exceeds the byte bound")
    }
    snapshot.push(value)
  }
  return Object.freeze(snapshot)
}

function ownershipLabel(value: string): boolean {
  const separator = value.indexOf("=")
  const key = separator < 0 ? value : value.slice(0, separator)
  return OwnershipLabelKeys.has(key)
}

function rejectCallerLabels(arguments_: readonly string[]): void {
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === undefined) continue
    let label: string | null = null
    if (argument === "--label" || argument === "-l") {
      label = arguments_[index + 1] ?? null
      if (label === null || label.length === 0) {
        throw new Error("Owned Docker caller label option is missing its value")
      }
      index += 1
    } else if (argument.startsWith("--label=")) {
      label = argument.slice("--label=".length)
    } else if (argument.startsWith("-l=") || (argument.startsWith("-l") && argument.length > 2)) {
      label = argument.startsWith("-l=") ? argument.slice(3) : argument.slice(2)
    } else if (argument === "--label-file" || argument.startsWith("--label-file=")) {
      throw new Error("Owned Docker caller label files are not allowed")
    } else if (/^-[^-]/u.test(argument)) {
      for (let offset = 1; offset < argument.length; offset += 1) {
        if (argument[offset] !== "l") continue
        const attached = argument.slice(offset + 1).replace(/^=/u, "")
        if (ownershipLabel(attached)) {
          throw new Error("Owned Docker caller cannot set an ownership label")
        }
      }
    }
    if (label !== null && (label.length === 0 || ownershipLabel(label))) {
      throw new Error("Owned Docker caller cannot set an ownership label")
    }
  }
}

function longOption(argument: string, option: string): boolean {
  return argument === option || argument.startsWith(`${option}=`)
}

function shortOption(argument: string, option: "-f" | "-H"): boolean {
  return argument === option || argument.startsWith(`${option}=`) || argument.startsWith(option)
}

function rejectDaemonSelectionAndFilters(arguments_: readonly string[]): void {
  for (const argument of arguments_) {
    if (
      longOption(argument, "--filter") ||
      shortOption(argument, "-f") ||
      longOption(argument, "--context") ||
      longOption(argument, "--host") ||
      shortOption(argument, "-H")
    ) {
      throw new Error("Owned Docker caller cannot select Docker filters, contexts, or hosts")
    }
  }
}

function rejectContainerDetach(arguments_: readonly string[]): void {
  for (const argument of arguments_) {
    if (
      longOption(argument, "--detach") ||
      argument === "-d" ||
      argument.startsWith("-d=") ||
      (/^-[dit]+$/u.test(argument) && argument.includes("d"))
    ) {
      throw new Error("Owned Docker container detach mode is mandatory and cannot be repeated")
    }
  }
}

function validatedArguments(value: unknown, type: ExampleResourceType): readonly string[] {
  const arguments_ = argumentTail(value)
  rejectCallerLabels(arguments_)
  rejectDaemonSelectionAndFilters(arguments_)
  if (type === "container") rejectContainerDetach(arguments_)
  return arguments_
}

function validatedVolumeArguments(value: unknown): readonly string[] {
  const arguments_ = validatedArguments(value, "volume")
  const optionsWithSeparateValue = new Set(["--driver", "-d", "--opt", "-o", "--label", "-l"])
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === undefined) continue
    if (optionsWithSeparateValue.has(argument)) {
      const optionValue = arguments_[index + 1]
      if (optionValue === undefined || optionValue.length === 0) {
        throw new Error("Owned Docker volume option is missing its value")
      }
      index += 1
      continue
    }
    if (
      /^(?:--driver|--opt|--label)=[^=].*$/u.test(argument) ||
      /^(?:-d|-o|-l)=[^=].*$/u.test(argument)
    ) {
      continue
    }
    throw new Error("Owned Docker volume caller-selected names are not allowed")
  }
  return arguments_
}

function parsedCreateOptions(value: unknown): ParsedCreateOptions {
  if (value === undefined) {
    return Object.freeze({
      timeoutMs: DefaultCreateTimeoutMs,
      knownSecrets: Object.freeze([])
    })
  }
  const record = exactOptionalRecord(value, "Owned Docker create options", CreateOptionKeys)
  const timeoutMs =
    record.timeoutMs === undefined
      ? DefaultCreateTimeoutMs
      : safeInteger(record.timeoutMs, "Owned Docker create timeout", 1, MaximumCreateTimeoutMs)
  const supplied =
    record.knownSecrets === undefined
      ? []
      : exactDenseArray(
          record.knownSecrets,
          "Owned Docker caller known secrets",
          MaximumCallerKnownSecrets
        )
  const knownSecrets: string[] = []
  for (const secret of supplied) {
    if (typeof secret !== "string") {
      throw new Error("Owned Docker caller known secrets must be strings")
    }
    knownSecrets.push(secret)
  }
  return Object.freeze({
    timeoutMs,
    knownSecrets: Object.freeze(knownSecrets)
  })
}

function parsedLogOptions(value: unknown): ParsedLogOptions {
  if (value === undefined) {
    return Object.freeze({
      timeoutMs: DefaultLogTimeoutMs,
      maximumCharacters: DefaultLogCharacters,
      knownSecrets: Object.freeze([])
    })
  }
  const record = exactOptionalRecord(value, "Owned Docker log options", LogOptionKeys)
  const timeoutMs =
    record.timeoutMs === undefined
      ? DefaultLogTimeoutMs
      : safeInteger(record.timeoutMs, "Owned Docker log timeout", 1, MaximumLogTimeoutMs)
  const maximumCharacters =
    record.maximumCharacters === undefined
      ? DefaultLogCharacters
      : safeInteger(
          record.maximumCharacters,
          "Owned Docker log character bound",
          1,
          MaximumLogCharacters
        )
  const supplied =
    record.knownSecrets === undefined
      ? []
      : exactDenseArray(
          record.knownSecrets,
          "Owned Docker log known secrets",
          MaximumCallerKnownSecrets
        )
  const knownSecrets: string[] = []
  for (const secret of supplied) {
    if (typeof secret !== "string") {
      throw new Error("Owned Docker log known secrets must be strings")
    }
    knownSecrets.push(secret)
  }
  return Object.freeze({
    timeoutMs,
    maximumCharacters,
    knownSecrets: Object.freeze(knownSecrets)
  })
}

function commandSecrets(
  state: ContextState,
  options: Pick<ParsedCreateOptions, "knownSecrets">
): readonly string[] {
  const knownSecrets = Object.freeze([
    state.verified.authority.registrationAck.ackToken,
    ...options.knownSecrets
  ])
  // Force the shared diagnostics sanitizer to enforce its count and size bounds before Docker.
  redactText("", { knownSecrets })
  return knownSecrets
}

function successful(result: CommandResult): boolean {
  return (
    !result.timedOut &&
    result.termination === "exit" &&
    result.exitCode === 0 &&
    result.cleanupFailures.length === 0
  )
}

function normalizedDiagnostic(value: unknown, knownSecrets: readonly string[]): string {
  return errorSummary(value, { knownSecrets }, 1_024)
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .trim()
}

function failedResultDiagnostic(result: CommandResult): Error {
  return new Error(
    [
      result.stdout,
      result.stderr,
      ...result.cleanupFailures.map((failure) => failure.summary)
    ].join("\n")
  )
}

function dockerCommandFailure(
  type: ExampleResourceType,
  operation: "create" | "logs",
  value: unknown,
  knownSecrets: readonly string[]
): Error {
  const diagnostic = normalizedDiagnostic(value, knownSecrets)
  const prefix = `Owned Docker command failed: type=${type} operation=${operation}`
  return new Error(diagnostic.length === 0 ? prefix : `${prefix} diagnostic=${diagnostic}`)
}

async function runDockerCommand(
  state: ContextState,
  type: ExampleResourceType,
  operation: "create",
  command: readonly string[],
  options: ParsedCreateOptions,
  knownSecrets: readonly string[]
): Promise<CommandResult> {
  const definition: CommandDefinition = Object.freeze({
    cwd: ".",
    command: Object.freeze(command.slice()),
    timeoutMs: options.timeoutMs,
    environment: Object.freeze({
      ...dockerEnvironmentOverrides(state.verified.dockerEnvironment),
      ...authorityToEnvironment(null)
    }),
    knownSecrets
  })
  let result: CommandResult
  try {
    result = await state.runner(state.verified.currentExample.cwdRealpath, definition)
  } catch (error) {
    throw dockerCommandFailure(type, operation, error, knownSecrets)
  }
  if (!successful(result)) {
    throw dockerCommandFailure(type, operation, failedResultDiagnostic(result), knownSecrets)
  }
  return result
}

function singleDockerOutput(output: string, type: "container" | "network" | "volume"): string {
  if (
    output.length === 0 ||
    output.length > MaximumDockerOutputCharacters ||
    output.includes("\0")
  ) {
    throw new Error(`Owned Docker ${type} create output is invalid`)
  }
  const value = output.endsWith("\r\n")
    ? output.slice(0, -2)
    : output.endsWith("\n")
      ? output.slice(0, -1)
      : output
  if (value.length === 0 || /[\r\n]/u.test(value) || value.trim() !== value) {
    throw new Error(`Owned Docker ${type} create output is invalid`)
  }
  return value
}

function parseCreateId(output: string, type: "container" | "network"): string {
  const value = singleDockerOutput(output, type)
  if (!DockerCreateIdPattern.test(value)) {
    throw new Error(`Owned Docker ${type} create output is invalid`)
  }
  return value
}

function parseVolumeCreateOutput(output: string): string {
  const value = singleDockerOutput(output, "volume")
  if (!DockerVolumeNamePattern.test(value) || value.includes("..")) {
    throw new Error("Owned Docker volume create output is invalid")
  }
  return value
}

function labelArguments(verified: VerifiedAuthority): readonly string[] {
  return Object.freeze([
    "--label",
    `${DockerOwnerLabelKey}=${verified.currentExample.childOwner}`,
    "--label",
    `${DockerInvocationLabelKey}=${verified.capability.invocation}`
  ])
}

function createdAt(state: ContextState): string {
  try {
    const value = state.now()
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error()
    return new Date(value.getTime()).toISOString()
  } catch {
    throw new Error("Owned Docker resource event timestamp is unavailable")
  }
}

async function publishResource(
  state: ContextState,
  type: ExampleResourceType,
  resourceId: string,
  knownSecrets: readonly string[]
): Promise<OwnedDockerResource> {
  // Keep authorization live through the final side effect immediately preceding publication.
  await verifyAuthority(state.verified.authority, state.identityReader)
  const event = parseResourceEvent({
    schemaVersion: 1,
    id: state.verified.currentExample.id,
    resourceType: type,
    resourceId,
    invocation: state.verified.capability.invocation,
    childOwner: state.verified.currentExample.childOwner,
    createdAt: createdAt(state)
  })
  try {
    await writeDurableJson(state.eventDirectory, `resource-${randomUUID()}.json`, event, {
      readOnly: true
    })
  } catch {
    throw new Error(`Owned Docker resource event publication failed: type=${type}`)
  }
  const sanitizedId = redactText(resourceId, { knownSecrets })
  const resource = Object.freeze({
    type,
    id: sanitizedId,
    display: sanitizedId
  })
  state.createdResources.set(resource, type)
  if (state.afterEvent !== undefined) {
    try {
      await state.afterEvent(event, resource)
    } catch {
      throw new Error(`Owned Docker after-event hook failed: type=${type}`)
    }
  }
  return resource
}

async function createResource<Type extends "container" | "network">(
  context: OwnedDockerContext,
  type: Type,
  value: unknown,
  optionsValue: unknown
): Promise<OwnedDockerResource<Type>> {
  const arguments_ = validatedArguments(value, type)
  const options = parsedCreateOptions(optionsValue)
  return await contextOperation(context, async (state) => {
    await verifyAuthority(state.verified.authority, state.identityReader)
    const knownSecrets = commandSecrets(state, options)
    const prefix =
      type === "container" ? ["docker", "run", "--detach"] : ["docker", "network", "create"]
    const command = [...prefix, ...labelArguments(state.verified), ...arguments_]
    const result = await runDockerCommand(state, type, "create", command, options, knownSecrets)
    const resourceId = parseCreateId(result.stdout, type)
    return (await publishResource(
      state,
      type,
      resourceId,
      knownSecrets
    )) as OwnedDockerResource<Type>
  })
}

/** Runs `docker run --detach` with the mandatory immutable owner/invocation label pair. */
export async function createContainer(
  context: OwnedDockerContext,
  arguments_: readonly string[],
  options?: OwnedDockerCreateOptions
): Promise<OwnedDockerResource<"container">> {
  return await createResource(context, "container", arguments_, options)
}

/**
 * Returns a bounded, redacted tail from one container created by this exact context. The default
 * metadata-only authority cannot read logs, and no arbitrary container identifier is accepted.
 */
export async function readContainerLogs(
  context: OwnedDockerContext,
  resource: OwnedDockerResource<"container">,
  options?: OwnedDockerLogOptions
): Promise<string> {
  const parsedOptions = parsedLogOptions(options)
  return await contextOperation(context, async (state) => {
    await verifyAuthority(state.verified.authority, state.identityReader)
    if (state.verified.diagnosticsPolicy !== "safe-redacted-logs") {
      throw new Error("Owned Docker container logs require safe-redacted-logs authority")
    }
    if (
      resource === null ||
      typeof resource !== "object" ||
      Reflect.ownKeys(resource).sort().join("\0") !== "display\0id\0type" ||
      resource.type !== "container" ||
      typeof resource.id !== "string" ||
      resource.display !== resource.id ||
      !DockerCreateIdPattern.test(resource.id) ||
      state.createdResources.get(resource) !== "container"
    ) {
      throw new Error("Owned Docker container logs require a container created by this context")
    }
    const knownSecrets = commandSecrets(state, parsedOptions)
    const command = ["docker", "logs", "--tail", String(DockerLogTailLines), resource.id]
    let result: CommandResult
    try {
      result = await state.runner(state.verified.currentExample.cwdRealpath, {
        cwd: ".",
        command: Object.freeze(command),
        timeoutMs: parsedOptions.timeoutMs,
        environment: Object.freeze({
          ...dockerEnvironmentOverrides(state.verified.dockerEnvironment),
          ...authorityToEnvironment(null)
        }),
        knownSecrets
      })
    } catch (error) {
      throw dockerCommandFailure("container", "logs", error, knownSecrets)
    }
    if (!successful(result)) {
      throw dockerCommandFailure("container", "logs", failedResultDiagnostic(result), knownSecrets)
    }
    return boundedTail(
      redactText(`${result.stdout}${result.stderr}`, { knownSecrets }),
      parsedOptions.maximumCharacters
    )
  })
}

/** Runs `docker network create` with the mandatory immutable owner/invocation label pair. */
export async function createNetwork(
  context: OwnedDockerContext,
  arguments_: readonly string[],
  options?: OwnedDockerCreateOptions
): Promise<OwnedDockerResource<"network">> {
  return await createResource(context, "network", arguments_, options)
}

/**
 * Creates a daemon-named volume with the mandatory owner/invocation pair. Caller-selected names
 * are deliberately unsupported because Docker treats named create as idempotent, which can adopt
 * an existing foreign volume between a precheck and create.
 */
export async function createVolume(
  context: OwnedDockerContext,
  arguments_: readonly string[] = Object.freeze([]),
  options?: OwnedDockerCreateOptions
): Promise<OwnedDockerResource<"volume">> {
  const validated = validatedVolumeArguments(arguments_)
  const parsedOptions = parsedCreateOptions(options)
  return await contextOperation(context, async (state) => {
    await verifyAuthority(state.verified.authority, state.identityReader)
    const knownSecrets = commandSecrets(state, parsedOptions)
    const command = ["docker", "volume", "create", ...labelArguments(state.verified), ...validated]
    const result = await runDockerCommand(
      state,
      "volume",
      "create",
      command,
      parsedOptions,
      knownSecrets
    )
    const resourceId = parseVolumeCreateOutput(result.stdout)
    return (await publishResource(
      state,
      "volume",
      resourceId,
      knownSecrets
    )) as OwnedDockerResource<"volume">
  })
}
