import { Ajv2020, type AnySchema } from "ajv/dist/2020.js"
import { randomUUID, createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { lstat, mkdir, readFile, realpath, stat } from "node:fs/promises"
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path"
import {
  nodeAtomicWriterOperations,
  writeCanonicalFile,
  type AtomicDirectoryIdentity,
  type AtomicWriterOperations
} from "./atomic-writer"

export {
  nodeAtomicWriterOperations,
  writeCanonicalFile,
  type AtomicDirectoryIdentity,
  type AtomicFileHandle,
  type AtomicWriterOperations
} from "./atomic-writer"

export type GateMode = "fixture" | "repository" | "runtime-probe"
export type ReadinessPolicy = "evaluation-only" | "package-admission"
export type GateStatus = "pass" | "fail"
export type ReleaseReadiness = "not-evaluated" | "not-ready" | "ready"
export type CheckStatus = "pass" | "fail" | "skip"

export interface GateCheck {
  readonly id: string
  readonly status: CheckStatus
  readonly path?: string
  readonly expected?: string | number | boolean | null
  readonly actual?: string | number | boolean | null
  readonly detail?: string
}

export interface SnapshotFile {
  readonly Path: string
  readonly RealPath: string
  readonly Sha256: string
  readonly Bytes: Uint8Array
}

export interface InputSnapshot {
  readonly Sha256: string
  readonly Files: readonly SnapshotFile[]
}

export interface GateEvaluation {
  readonly SubjectsChecked: number
  readonly Checks: readonly GateCheck[]
  readonly ArtifactPaths?: readonly { readonly kind: string; readonly path: string }[]
}

export interface GateResult {
  readonly schemaVersion: 1
  readonly runId: string
  readonly gate: string
  readonly mode: GateMode
  readonly status: GateStatus
  readonly releaseReadiness: ReleaseReadiness
  readonly startedAt: string
  readonly completedAt: string
  readonly toolchain: Readonly<Record<string, string>>
  readonly inputsSha256: string | null
  readonly subjects: { readonly expected: number | null; readonly checked: number }
  readonly checks: readonly GateCheck[]
  readonly artifacts: readonly {
    readonly kind: string
    readonly path: string
    readonly sha256: string
  }[]
}

export interface RunGateOptions {
  readonly root: string
  readonly gate: string
  readonly mode: GateMode
  readonly readinessPolicy: ReadinessPolicy
  readonly expectedSubjects: number | null
  readonly inputPaths: readonly string[]
  readonly toolchain: Readonly<Record<string, string>>
  readonly runId?: string | undefined
}

export interface GateEmissionDependencies {
  readonly AtomicWriterOperations: AtomicWriterOperations
  /**
   * An injected implementation must acknowledge output atomically: resolve only after accepting the
   * complete line, or reject before exposing any of it. External stdout bytes cannot be retracted.
   */
  readonly WriteStdout: (value: string) => void | Promise<void>
}

interface ProcessWritable {
  readonly once: (event: "error", listener: (error: unknown) => void) => unknown
  readonly removeListener: (event: "error", listener: (error: unknown) => void) => unknown
  readonly write: (value: string, callback: (error?: Error | null) => void) => boolean
}

interface ArtifactResult {
  readonly kind: string
  readonly path: string
  readonly sha256: string
}

interface InternalSnapshotResult {
  readonly Snapshot: InputSnapshot | null
  readonly Checks: readonly GateCheck[]
  readonly RootRealPath: string | null
}

interface PreparedCanonicalResult {
  readonly CanonicalPath: string
  readonly Directory: AtomicDirectoryIdentity
}

interface RunGateAdmission {
  readonly Options: RunGateOptions | null
  readonly RunId: string
  readonly Error: string | null
}

const GatePattern = /^[a-z][a-z0-9-]{0,63}$/
const RunIdPattern = /^[a-z0-9][a-z0-9_-]{0,95}$/
const GateModes = new Set<string>(["fixture", "repository", "runtime-probe"])
const ReadinessPolicies = new Set<string>(["evaluation-only", "package-admission"])
const RunGateOptionKeys = new Set([
  "root",
  "gate",
  "mode",
  "readinessPolicy",
  "expectedSubjects",
  "inputPaths",
  "toolchain",
  "runId"
])
const ReservedGateCheckIds = new Set([
  "GATE_PROTOCOL_ERROR",
  "GATE_INPUT_ERROR",
  "GATE_INTERNAL_ERROR",
  "GATE_ARTIFACT_ERROR",
  "GATE_SUBJECTS_ZERO",
  "GATE_NO_PASS_CHECK",
  "GATE_SUBJECT_COUNT_MISMATCH"
])
const NullInputStageCheckIds = new Set(["GATE_PROTOCOL_ERROR", "GATE_INPUT_ERROR"])
const ProtocolFailureOptions: RunGateOptions = {
  root: ".",
  gate: "gate-protocol-error",
  mode: "repository",
  readinessPolicy: "evaluation-only",
  expectedSubjects: null,
  inputPaths: [],
  toolchain: {}
}
const GateResultSchemaUrl = new URL("../../schemas/gate-result.schema.json", import.meta.url)
const GateResultSchema = JSON.parse(readFileSync(GateResultSchemaUrl, "utf8")) as AnySchema
const GateResultAjv = new Ajv2020({ strict: true })
const ValidateGateResultSchema = GateResultAjv.compile(GateResultSchema)

function Sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

function ErrorMessage(error: unknown): string {
  try {
    if (error instanceof Error) {
      const message: unknown = error.message
      return typeof message === "string" ? message : "unprintable error"
    }
    return String(error)
  } catch {
    return "unprintable error"
  }
}

function FailedCheck(id: string, detail: string): GateCheck {
  return { id, status: "fail", detail }
}

function IsInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate)
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot))
  )
}

function CompareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function CanonicalLexicalPath(
  root: string,
  inputPath: string
): { readonly Absolute: string; readonly Path: string } {
  if (inputPath.length === 0 || isAbsolute(inputPath)) {
    throw new Error(`input path must be a non-empty relative path: ${inputPath}`)
  }
  const absolute = resolve(root, normalize(inputPath))
  if (!IsInside(root, absolute) || absolute === root) {
    throw new Error(`input path escapes the root: ${inputPath}`)
  }
  return {
    Absolute: absolute,
    Path: relative(root, absolute).split(sep).join("/")
  }
}

async function SnapshotInputsWithRoot(
  root: string,
  paths: readonly string[],
  knownRootRealPath: string | null = null
): Promise<InternalSnapshotResult> {
  try {
    const rootRealPath = knownRootRealPath ?? (await realpath(root))
    const rootStat = await stat(rootRealPath)
    if (!rootStat.isDirectory()) {
      throw new Error("gate root must be a directory")
    }

    const lexicalPaths = new Set<string>()
    const realPaths = new Set<string>()
    const files: SnapshotFile[] = []
    for (const inputPath of paths) {
      const canonical = CanonicalLexicalPath(rootRealPath, inputPath)
      if (lexicalPaths.has(canonical.Path)) {
        throw new Error(`duplicate lexical input path: ${canonical.Path}`)
      }
      lexicalPaths.add(canonical.Path)

      const inputRealPath = await realpath(canonical.Absolute)
      if (!IsInside(rootRealPath, inputRealPath)) {
        throw new Error(`input real path escapes the root: ${canonical.Path}`)
      }
      if (realPaths.has(inputRealPath)) {
        throw new Error(`duplicate input real path: ${canonical.Path}`)
      }
      if (inputRealPath !== canonical.Absolute) {
        throw new Error(
          `resolved input path differs from its canonical lexical path: ${canonical.Path}`
        )
      }
      realPaths.add(inputRealPath)

      const inputStat = await stat(inputRealPath)
      if (!inputStat.isFile()) {
        throw new Error(`input must be a regular file: ${canonical.Path}`)
      }
      const Bytes = new Uint8Array(await readFile(inputRealPath))
      files.push({
        Path: canonical.Path,
        RealPath: inputRealPath,
        Sha256: Sha256(Bytes),
        Bytes
      })
    }
    files.sort((left, right) => CompareCodeUnits(left.Path, right.Path))
    const inventory = files.map((file) => `${file.Path}\0${file.Sha256}\n`).join("")
    return {
      Snapshot: { Sha256: Sha256(inventory), Files: files },
      Checks: [],
      RootRealPath: rootRealPath
    }
  } catch (error) {
    return {
      Snapshot: null,
      Checks: [FailedCheck("GATE_INPUT_ERROR", ErrorMessage(error))],
      RootRealPath: knownRootRealPath
    }
  }
}

export async function snapshotInputs(
  root: string,
  paths: readonly string[]
): Promise<{ readonly Snapshot: InputSnapshot | null; readonly Checks: readonly GateCheck[] }> {
  const result = await SnapshotInputsWithRoot(root, paths)
  return { Snapshot: result.Snapshot, Checks: result.Checks }
}

function IsGateMode(value: unknown): value is GateMode {
  return typeof value === "string" && GateModes.has(value)
}

function IsReadinessPolicy(value: unknown): value is ReadinessPolicy {
  return typeof value === "string" && ReadinessPolicies.has(value)
}

function IsStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string")
  )
}

function IsObjectRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function HasOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>
): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}

function IsCheckValue(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
}

function NormalizeCheck(value: unknown): GateCheck {
  const allowed = new Set(["id", "status", "path", "expected", "actual", "detail"])
  if (!IsObjectRecord(value) || !HasOnlyKeys(value, allowed)) {
    throw new Error("evaluator checks must be fixed-shape objects")
  }
  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new Error("evaluator check id must be a non-empty string")
  }
  if (ReservedGateCheckIds.has(value.id)) {
    throw new Error(`evaluator check id is reserved: ${value.id}`)
  }
  if (value.status !== "pass" && value.status !== "fail" && value.status !== "skip") {
    throw new Error("evaluator check status is invalid")
  }
  if ("path" in value && typeof value.path !== "string") {
    throw new Error("evaluator check path must be a string")
  }
  if ("expected" in value && !IsCheckValue(value.expected)) {
    throw new Error("evaluator check expected value is invalid")
  }
  if ("actual" in value && !IsCheckValue(value.actual)) {
    throw new Error("evaluator check actual value is invalid")
  }
  if ("detail" in value && typeof value.detail !== "string") {
    throw new Error("evaluator check detail must be a string")
  }
  return {
    id: value.id,
    status: value.status,
    ...(typeof value.path === "string" ? { path: value.path } : {}),
    ...(IsCheckValue(value.expected) ? { expected: value.expected } : {}),
    ...(IsCheckValue(value.actual) ? { actual: value.actual } : {}),
    ...(typeof value.detail === "string" ? { detail: value.detail } : {})
  }
}

function NormalizeEvaluation(value: unknown): GateEvaluation {
  const allowed = new Set(["SubjectsChecked", "Checks", "ArtifactPaths"])
  if (!IsObjectRecord(value) || !HasOnlyKeys(value, allowed)) {
    throw new Error("evaluator result must be a fixed-shape object")
  }
  if (!Number.isInteger(value.SubjectsChecked) || (value.SubjectsChecked as number) < 0) {
    throw new Error("SubjectsChecked must be a non-negative integer")
  }
  if (!Array.isArray(value.Checks)) {
    throw new Error("evaluator Checks must be an array")
  }
  const Checks = value.Checks.map((check) => NormalizeCheck(check))
  if (!("ArtifactPaths" in value)) {
    return { SubjectsChecked: value.SubjectsChecked as number, Checks }
  }
  if (!Array.isArray(value.ArtifactPaths)) {
    throw new Error("evaluator ArtifactPaths must be an array")
  }
  const ArtifactPaths = value.ArtifactPaths.map((artifact) => {
    const artifactKeys = new Set(["kind", "path"])
    if (!IsObjectRecord(artifact) || !HasOnlyKeys(artifact, artifactKeys)) {
      throw new Error("artifact descriptors must be fixed-shape objects")
    }
    if (typeof artifact.kind !== "string" || artifact.kind.length === 0) {
      throw new Error("artifact kind must be a non-empty string")
    }
    if (typeof artifact.path !== "string" || artifact.path.length === 0) {
      throw new Error("artifact path must be a non-empty string")
    }
    return { kind: artifact.kind, path: artifact.path }
  })
  return { SubjectsChecked: value.SubjectsChecked as number, Checks, ArtifactPaths }
}

function AdmitRunGateOptions(value: unknown): RunGateAdmission {
  const generatedRunId = randomUUID()
  if (!IsObjectRecord(value) || !HasOnlyKeys(value, RunGateOptionKeys)) {
    return {
      Options: null,
      RunId: generatedRunId,
      Error: "gate options must be a fixed-shape object"
    }
  }

  const requestedRunId = value.runId
  const invalidRequestedRunId =
    requestedRunId !== undefined &&
    (typeof requestedRunId !== "string" || !RunIdPattern.test(requestedRunId))
  const runId =
    requestedRunId === undefined
      ? generatedRunId
      : typeof requestedRunId === "string" && RunIdPattern.test(requestedRunId)
        ? requestedRunId
        : generatedRunId
  if (invalidRequestedRunId) {
    return { Options: null, RunId: runId, Error: "invalid run id" }
  }
  if (typeof value.gate !== "string" || !GatePattern.test(value.gate)) {
    return { Options: null, RunId: runId, Error: "invalid gate id" }
  }
  if (!IsGateMode(value.mode)) {
    return { Options: null, RunId: runId, Error: "invalid gate mode" }
  }
  if (!IsReadinessPolicy(value.readinessPolicy)) {
    return {
      Options: null,
      RunId: runId,
      Error: "invalid readiness policy"
    }
  }
  if (
    value.expectedSubjects !== null &&
    (!Number.isInteger(value.expectedSubjects) || (value.expectedSubjects as number) < 0)
  ) {
    return {
      Options: null,
      RunId: runId,
      Error: "expectedSubjects must be null or a non-negative integer"
    }
  }
  if (typeof value.root !== "string" || value.root.length === 0) {
    return { Options: null, RunId: runId, Error: "root must be a non-empty string" }
  }
  if (
    !Array.isArray(value.inputPaths) ||
    !value.inputPaths.every((path) => typeof path === "string")
  ) {
    return { Options: null, RunId: runId, Error: "inputPaths must be an array of strings" }
  }
  if (!IsStringRecord(value.toolchain)) {
    return { Options: null, RunId: runId, Error: "toolchain must be a string map" }
  }
  if (value.readinessPolicy === "package-admission" && value.mode !== "repository") {
    return { Options: null, RunId: runId, Error: "package-admission requires repository mode" }
  }
  if (value.mode === "fixture" && !value.gate.endsWith("-fixtures")) {
    return { Options: null, RunId: runId, Error: "fixture gate ids must end in -fixtures" }
  }

  return {
    Options: {
      root: value.root,
      gate: value.gate,
      mode: value.mode,
      readinessPolicy: value.readinessPolicy,
      expectedSubjects: value.expectedSubjects as number | null,
      inputPaths: [...value.inputPaths] as string[],
      toolchain: { ...value.toolchain },
      ...(requestedRunId === undefined ? {} : { runId })
    },
    RunId: runId,
    Error: null
  }
}

function SafelyAdmitRunGateOptions(value: unknown): RunGateAdmission {
  try {
    return AdmitRunGateOptions(structuredClone(value))
  } catch {
    return {
      Options: null,
      RunId: randomUUID(),
      Error: "gate options could not be safely inspected"
    }
  }
}

function ReleaseReadinessFor(policy: ReadinessPolicy, status: GateStatus): ReleaseReadiness {
  if (policy === "evaluation-only") {
    return "not-evaluated"
  }
  return status === "pass" ? "ready" : "not-ready"
}

function BuildResult(
  options: RunGateOptions,
  runId: string,
  startedAt: string,
  inputsSha256: string | null,
  checked: number,
  checks: readonly GateCheck[],
  artifacts: readonly ArtifactResult[]
): GateResult {
  const status: GateStatus = checks.some((check) => check.status === "fail") ? "fail" : "pass"
  const observedCompletedAt = new Date().toISOString()
  return {
    schemaVersion: 1,
    runId,
    gate: options.gate,
    mode: options.mode,
    status,
    releaseReadiness: ReleaseReadinessFor(options.readinessPolicy, status),
    startedAt,
    completedAt: observedCompletedAt < startedAt ? startedAt : observedCompletedAt,
    toolchain: { ...options.toolchain },
    inputsSha256,
    subjects: { expected: options.expectedSubjects, checked },
    checks,
    artifacts
  }
}

async function HashArtifacts(
  rootRealPath: string,
  artifactPaths: readonly { readonly kind: string; readonly path: string }[]
): Promise<readonly ArtifactResult[]> {
  if (artifactPaths.length === 0) {
    return []
  }
  const snapshotResult = await SnapshotInputsWithRoot(
    rootRealPath,
    artifactPaths.map((artifact) => artifact.path),
    rootRealPath
  )
  if (snapshotResult.Snapshot === null) {
    throw new Error(snapshotResult.Checks.map((check) => check.detail ?? check.id).join("; "))
  }
  const kinds = new Map<string, string>()
  for (const artifact of artifactPaths) {
    const canonical = CanonicalLexicalPath(rootRealPath, artifact.path)
    kinds.set(canonical.Path, artifact.kind)
  }
  return snapshotResult.Snapshot.Files.map((file) => ({
    kind: kinds.get(file.Path) ?? "",
    path: file.Path,
    sha256: file.Sha256
  }))
}

export async function runGate(
  options: unknown,
  evaluate: (snapshot: InputSnapshot) => Promise<GateEvaluation>
): Promise<GateResult> {
  const startedAt = new Date().toISOString()
  const admission = SafelyAdmitRunGateOptions(options)
  if (admission.Error !== null || admission.Options === null) {
    return BuildResult(
      ProtocolFailureOptions,
      admission.RunId,
      startedAt,
      null,
      0,
      [FailedCheck("GATE_PROTOCOL_ERROR", admission.Error ?? "invalid gate options")],
      []
    )
  }

  const gateOptions = admission.Options
  const runId = admission.RunId
  const snapshotResult = await SnapshotInputsWithRoot(gateOptions.root, gateOptions.inputPaths)
  if (snapshotResult.Snapshot === null) {
    return BuildResult(gateOptions, runId, startedAt, null, 0, snapshotResult.Checks, [])
  }

  let evaluation: GateEvaluation
  try {
    evaluation = NormalizeEvaluation(structuredClone(await evaluate(snapshotResult.Snapshot)))
  } catch (error) {
    return BuildResult(
      gateOptions,
      runId,
      startedAt,
      snapshotResult.Snapshot.Sha256,
      0,
      [FailedCheck("GATE_INTERNAL_ERROR", ErrorMessage(error))],
      []
    )
  }

  const checks: GateCheck[] = [...evaluation.Checks]
  if (evaluation.SubjectsChecked === 0) {
    checks.push(FailedCheck("GATE_SUBJECTS_ZERO", "gate must check at least one subject"))
  }
  if (!checks.some((check) => check.status === "pass")) {
    checks.push(FailedCheck("GATE_NO_PASS_CHECK", "gate must produce at least one passing check"))
  }
  if (
    gateOptions.expectedSubjects !== null &&
    gateOptions.expectedSubjects !== evaluation.SubjectsChecked
  ) {
    checks.push({
      id: "GATE_SUBJECT_COUNT_MISMATCH",
      status: "fail",
      expected: gateOptions.expectedSubjects,
      actual: evaluation.SubjectsChecked
    })
  }

  let artifacts: readonly ArtifactResult[] = []
  try {
    artifacts = await HashArtifacts(
      snapshotResult.RootRealPath as string,
      evaluation.ArtifactPaths ?? []
    )
  } catch (error) {
    checks.push(FailedCheck("GATE_ARTIFACT_ERROR", ErrorMessage(error)))
  }

  return BuildResult(
    gateOptions,
    runId,
    startedAt,
    snapshotResult.Snapshot.Sha256,
    evaluation.SubjectsChecked,
    checks,
    artifacts
  )
}

function SemanticResultError(result: GateResult): string | null {
  const started = new Date(result.startedAt)
  const completed = new Date(result.completedAt)
  if (
    Number.isNaN(started.valueOf()) ||
    started.toISOString() !== result.startedAt ||
    Number.isNaN(completed.valueOf()) ||
    completed.toISOString() !== result.completedAt
  ) {
    return "timestamps must be real canonical UTC millisecond instants"
  }
  if (result.completedAt < result.startedAt) {
    return "completedAt must not precede startedAt"
  }

  const nonFailureReservedCheck = result.checks.find(
    (check) => ReservedGateCheckIds.has(check.id) && check.status !== "fail"
  )
  if (nonFailureReservedCheck !== undefined) {
    return `reserved check ${nonFailureReservedCheck.id} must fail`
  }
  const nullInputStageChecks = result.checks.filter((check) => NullInputStageCheckIds.has(check.id))
  if (result.inputsSha256 === null) {
    if (
      result.status !== "fail" ||
      result.subjects.checked !== 0 ||
      result.artifacts.length !== 0 ||
      result.checks.length !== 1 ||
      nullInputStageChecks.length !== 1 ||
      nullInputStageChecks[0]?.status !== "fail"
    ) {
      return "null inputsSha256 requires one protocol/input failure with zero checked subjects and no artifacts"
    }
  } else if (nullInputStageChecks.length > 0) {
    return "protocol/input failure checks require null inputsSha256"
  }

  const derivedPass =
    result.subjects.checked > 0 &&
    result.checks.some((check) => check.status === "pass") &&
    !result.checks.some((check) => check.status === "fail") &&
    (result.subjects.expected === null || result.subjects.expected === result.subjects.checked)
  const derivedStatus: GateStatus = derivedPass ? "pass" : "fail"
  if (result.status !== derivedStatus) {
    return `status must be ${derivedStatus} for the recorded subjects and checks`
  }

  if (result.mode === "fixture" && !result.gate.endsWith("-fixtures")) {
    return "fixture gate ids must end in -fixtures"
  }
  if (result.mode !== "repository" && result.releaseReadiness !== "not-evaluated") {
    return `${result.mode} results must be not-evaluated`
  }
  if (result.mode === "repository") {
    const admissionReadiness = result.status === "pass" ? "ready" : "not-ready"
    if (
      result.releaseReadiness !== "not-evaluated" &&
      result.releaseReadiness !== admissionReadiness
    ) {
      return `repository ${result.status} result has contradictory readiness`
    }
  }
  return null
}

function IsFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code
}

async function EnsureResultDirectory(path: string): Promise<void> {
  let information
  try {
    information = await lstat(path)
  } catch (error) {
    if (!IsFileSystemError(error, "ENOENT")) {
      throw error
    }
    try {
      await mkdir(path, { mode: 0o700 })
    } catch (mkdirError) {
      if (!IsFileSystemError(mkdirError, "EEXIST")) {
        throw mkdirError
      }
    }
    information = await lstat(path)
  }
  if (information.isSymbolicLink() || !information.isDirectory()) {
    throw new Error(`${path} must be a real directory`)
  }
}

async function PrepareCanonicalResultPath(
  root: string,
  gate: string
): Promise<PreparedCanonicalResult> {
  try {
    const rootRealPath = await realpath(root)
    const rootInformation = await stat(rootRealPath)
    if (!rootInformation.isDirectory()) {
      throw new Error("result root must be a directory")
    }
    const artifactsDirectory = join(rootRealPath, ".artifacts")
    const gatesDirectory = join(artifactsDirectory, "gates")
    await EnsureResultDirectory(artifactsDirectory)
    await EnsureResultDirectory(gatesDirectory)
    const gatesRealPath = await realpath(gatesDirectory)
    const gatesInformation = await stat(gatesDirectory)
    const canonicalPath = join(gatesDirectory, `${gate}.json`)
    try {
      const targetInformation = await lstat(canonicalPath)
      if (targetInformation.isSymbolicLink() || !targetInformation.isFile()) {
        throw new Error("existing canonical result target must be a real regular file")
      }
    } catch (error) {
      if (!IsFileSystemError(error, "ENOENT")) {
        throw error
      }
    }
    return {
      CanonicalPath: canonicalPath,
      Directory: {
        Path: gatesDirectory,
        RealPath: gatesRealPath,
        Device: gatesInformation.dev,
        Inode: gatesInformation.ino
      }
    }
  } catch (error) {
    throw new Error(`GATE_RESULT_PATH_ERROR ${ErrorMessage(error)}`)
  }
}

export async function emitGateResultWithDependencies(
  root: string,
  result: GateResult,
  dependencies: GateEmissionDependencies
): Promise<string> {
  if (!ValidateGateResultSchema(result)) {
    throw new Error(
      `GATE_RESULT_SCHEMA_ERROR ${GateResultAjv.errorsText(ValidateGateResultSchema.errors)}`
    )
  }
  const semanticError = SemanticResultError(result)
  if (semanticError !== null) {
    throw new Error(`GATE_RESULT_SEMANTIC_ERROR ${semanticError}`)
  }
  const prepared = await PrepareCanonicalResultPath(root, result.gate)
  const compact = JSON.stringify(result)
  const receipt = await writeCanonicalFile(
    prepared.CanonicalPath,
    `${compact}\n`,
    { Gate: result.gate, RunId: result.runId, Directory: prepared.Directory },
    dependencies.AtomicWriterOperations
  )
  try {
    await dependencies.WriteStdout(`LIKEGO_GATE_RESULT=${compact}\n`)
  } catch (error) {
    try {
      await receipt.Rollback()
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "gate result output confirmation and rollback failed"
      )
    }
    throw error
  }
  await receipt.Commit()
  return prepared.CanonicalPath
}

async function WriteProcessStream(stream: ProcessWritable, value: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const Finish = (errorThrown: boolean, error?: unknown) => {
      if (settled) return
      settled = true
      stream.removeListener("error", OnError)
      if (errorThrown) reject(error)
      else resolve()
    }
    const OnError = (error: unknown) => {
      Finish(true, error)
    }
    stream.once("error", OnError)
    try {
      stream.write(value, (error) => {
        if (error === undefined || error === null) Finish(false)
        else Finish(true, error)
      })
    } catch (error) {
      Finish(true, error)
    }
  })
}

export async function writeProcessStdout(value: string): Promise<void> {
  await WriteProcessStream(process.stdout as unknown as ProcessWritable, value)
}

export async function writeProcessStderr(value: string): Promise<void> {
  await WriteProcessStream(process.stderr as unknown as ProcessWritable, value)
}

export async function emitGateResult(root: string, result: GateResult): Promise<string> {
  return emitGateResultWithDependencies(root, result, {
    AtomicWriterOperations: nodeAtomicWriterOperations(),
    WriteStdout: writeProcessStdout
  })
}
