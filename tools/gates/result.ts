import { Ajv2020, type AnySchema } from "ajv/dist/2020.js"
import { randomUUID, createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { lstat, mkdir, readFile, realpath, stat } from "node:fs/promises"
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path"
import {
  NodeAtomicWriterOperations,
  WriteCanonicalFile,
  type AtomicWriterOperations
} from "./atomic-writer.ts"

export {
  NodeAtomicWriterOperations,
  WriteCanonicalFile,
  type AtomicFileHandle,
  type AtomicWriterOperations
} from "./atomic-writer.ts"

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
  readonly artifacts: readonly { readonly kind: string; readonly path: string; readonly sha256: string }[]
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
  readonly WriteStdout: (value: string) => void
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

const GatePattern = /^[a-z][a-z0-9-]{0,63}$/
const RunIdPattern = /^[a-z0-9][a-z0-9_-]{0,95}$/
const GateModes = new Set<string>(["fixture", "repository", "runtime-probe"])
const ReadinessPolicies = new Set<string>(["evaluation-only", "package-admission"])
const GateResultSchemaUrl = new URL("../../schemas/gate-result.schema.json", import.meta.url)
const GateResultSchema = JSON.parse(readFileSync(GateResultSchemaUrl, "utf8")) as AnySchema
const GateResultAjv = new Ajv2020({ strict: true })
const ValidateGateResultSchema = GateResultAjv.compile(GateResultSchema)

function Sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

function ErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function FailedCheck(id: string, detail: string): GateCheck {
  return { id, status: "fail", detail }
}

function IsInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate)
  return pathFromRoot === ""
    || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot))
}

function CompareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function CanonicalLexicalPath(root: string, inputPath: string): { readonly Absolute: string; readonly Path: string } {
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
    const rootRealPath = knownRootRealPath ?? await realpath(root)
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

export async function SnapshotInputs(
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
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.values(value).every((item) => typeof item === "string")
}

function IsObjectRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function HasOnlyKeys(value: Readonly<Record<string, unknown>>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key))
}

function IsCheckValue(value: unknown): value is string | number | boolean | null {
  return value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
}

function NormalizeCheck(value: unknown): GateCheck {
  const allowed = new Set(["id", "status", "path", "expected", "actual", "detail"])
  if (!IsObjectRecord(value) || !HasOnlyKeys(value, allowed)) {
    throw new Error("evaluator checks must be fixed-shape objects")
  }
  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new Error("evaluator check id must be a non-empty string")
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

function ProtocolError(options: RunGateOptions, runId: string): string | null {
  if (typeof options.gate !== "string" || !GatePattern.test(options.gate)) {
    return `invalid gate id: ${String(options.gate)}`
  }
  if (typeof runId !== "string" || !RunIdPattern.test(runId)) {
    return `invalid run id: ${String(runId)}`
  }
  if (!IsGateMode(options.mode)) {
    return `invalid gate mode: ${String(options.mode)}`
  }
  if (!IsReadinessPolicy(options.readinessPolicy)) {
    return `invalid readiness policy: ${String(options.readinessPolicy)}`
  }
  if (
    options.expectedSubjects !== null
    && (!Number.isInteger(options.expectedSubjects) || options.expectedSubjects < 0)
  ) {
    return "expectedSubjects must be null or a non-negative integer"
  }
  if (typeof options.root !== "string" || options.root.length === 0) {
    return "root must be a non-empty string"
  }
  if (!Array.isArray(options.inputPaths) || !options.inputPaths.every((path) => typeof path === "string")) {
    return "inputPaths must be an array of strings"
  }
  if (!IsStringRecord(options.toolchain)) {
    return "toolchain must be a string map"
  }
  if (options.readinessPolicy === "package-admission" && options.mode !== "repository") {
    return "package-admission requires repository mode"
  }
  if (options.mode === "fixture" && !options.gate.endsWith("-fixtures")) {
    return "fixture gate ids must end in -fixtures"
  }
  return null
}

function SafeProtocolResultOptions(options: RunGateOptions): RunGateOptions {
  const expectedSubjects = options.expectedSubjects === null
    || (Number.isInteger(options.expectedSubjects) && options.expectedSubjects >= 0)
    ? options.expectedSubjects
    : null
  const mode: GateMode = IsGateMode(options.mode) ? options.mode : "repository"
  const gate = typeof options.gate === "string" && GatePattern.test(options.gate)
    ? options.gate
    : mode === "fixture" ? "gate-protocol-error-fixtures" : "gate-protocol-error"
  return {
    ...options,
    root: typeof options.root === "string" && options.root.length > 0 ? options.root : ".",
    gate,
    mode,
    readinessPolicy: IsReadinessPolicy(options.readinessPolicy)
      ? options.readinessPolicy
      : "evaluation-only",
    expectedSubjects,
    inputPaths: Array.isArray(options.inputPaths)
      ? options.inputPaths.filter((path): path is string => typeof path === "string")
      : [],
    toolchain: IsStringRecord(options.toolchain) ? { ...options.toolchain } : {}
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
    toolchain: options.toolchain,
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

export async function RunGate(
  options: RunGateOptions,
  evaluate: (snapshot: InputSnapshot) => Promise<GateEvaluation>
): Promise<GateResult> {
  const startedAt = new Date().toISOString()
  const runId = options.runId ?? randomUUID()
  const protocolError = ProtocolError(options, runId)
  if (protocolError !== null) {
    const safeOptions = SafeProtocolResultOptions(options)
    const safeRunId = typeof runId === "string" && RunIdPattern.test(runId) ? runId : randomUUID()
    return BuildResult(
      safeOptions,
      safeRunId,
      startedAt,
      null,
      0,
      [FailedCheck("GATE_PROTOCOL_ERROR", protocolError)],
      []
    )
  }

  const gateOptions = SafeProtocolResultOptions(options)
  const snapshotResult = await SnapshotInputsWithRoot(gateOptions.root, gateOptions.inputPaths)
  if (snapshotResult.Snapshot === null) {
    return BuildResult(gateOptions, runId, startedAt, null, 0, snapshotResult.Checks, [])
  }

  let evaluation: GateEvaluation
  try {
    evaluation = NormalizeEvaluation(await evaluate(snapshotResult.Snapshot))
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
    gateOptions.expectedSubjects !== null
    && gateOptions.expectedSubjects !== evaluation.SubjectsChecked
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
    artifacts = await HashArtifacts(snapshotResult.RootRealPath as string, evaluation.ArtifactPaths ?? [])
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
    Number.isNaN(started.valueOf())
    || started.toISOString() !== result.startedAt
    || Number.isNaN(completed.valueOf())
    || completed.toISOString() !== result.completedAt
  ) {
    return "timestamps must be real canonical UTC millisecond instants"
  }
  if (result.completedAt < result.startedAt) {
    return "completedAt must not precede startedAt"
  }

  const derivedPass = result.subjects.checked > 0
    && result.checks.some((check) => check.status === "pass")
    && !result.checks.some((check) => check.status === "fail")
    && (result.subjects.expected === null || result.subjects.expected === result.subjects.checked)
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
      result.releaseReadiness !== "not-evaluated"
      && result.releaseReadiness !== admissionReadiness
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

async function PrepareCanonicalResultPath(root: string, gate: string): Promise<string> {
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
    return canonicalPath
  } catch (error) {
    throw new Error(`GATE_RESULT_PATH_ERROR ${ErrorMessage(error)}`)
  }
}

export async function EmitGateResultWithDependencies(
  root: string,
  result: GateResult,
  dependencies: GateEmissionDependencies
): Promise<string> {
  if (!ValidateGateResultSchema(result)) {
    throw new Error(`GATE_RESULT_SCHEMA_ERROR ${GateResultAjv.errorsText(ValidateGateResultSchema.errors)}`)
  }
  const semanticError = SemanticResultError(result)
  if (semanticError !== null) {
    throw new Error(`GATE_RESULT_SEMANTIC_ERROR ${semanticError}`)
  }
  const canonicalPath = await PrepareCanonicalResultPath(root, result.gate)
  const compact = JSON.stringify(result)
  await WriteCanonicalFile(
    canonicalPath,
    `${compact}\n`,
    { Gate: result.gate, RunId: result.runId },
    dependencies.AtomicWriterOperations
  )
  dependencies.WriteStdout(`LIKEGO_GATE_RESULT=${compact}\n`)
  return canonicalPath
}

export async function EmitGateResult(root: string, result: GateResult): Promise<string> {
  return EmitGateResultWithDependencies(root, result, {
    AtomicWriterOperations: NodeAtomicWriterOperations(),
    WriteStdout: (value) => { process.stdout.write(value) }
  })
}
