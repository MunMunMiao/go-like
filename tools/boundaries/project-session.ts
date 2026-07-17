import { randomUUID } from "node:crypto"
import { lstatSync, realpathSync, type BigIntStats, type Stats } from "node:fs"
import { lstat, mkdir, readFile, realpath, rm, rmdir, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path"
import { API, type Diagnostic, type Project, type Snapshot } from "typescript/unstable/async"
import type { SourceFile } from "typescript/unstable/ast"
import type { InputSnapshot, SnapshotFile } from "../gates/result.ts"

export interface ProjectSession {
  readonly Project: Project
  readonly SourceFiles: readonly SourceFile[]
  readonly StagedRoot: string
}

export interface SessionIssue {
  readonly Code: string
  readonly Path: string
  readonly Message: string
}

export interface ProjectSessionOperations {
  readonly RepositoryRoot: string
  readonly UpdateSnapshot: (api: API, canonicalTsconfig: string) => Promise<Snapshot>
  readonly DisposeSnapshot: (snapshot: Snapshot) => Promise<void>
  readonly CloseAPI: (api: API) => Promise<void>
  readonly RemoveStaging: (path: string) => Promise<void>
}

export interface WorkspaceProjectAuthority {
  readonly ProjectPrefix: string
  readonly DependencyPrefixes: readonly string[]
}

interface SelectedProjectInput {
  readonly ProjectPrefix: string
  readonly DependencyPrefixes: readonly string[]
  readonly SelectedPrefixes: readonly string[]
  readonly ConfigPath: string
  readonly Files: readonly SnapshotFile[]
  readonly SourceFilesByPath: ReadonlyMap<string, SnapshotFile> | null
}

interface IndexedProjectInput {
  readonly FilesByPath: ReadonlyMap<string, SnapshotFile>
  readonly Paths: readonly string[]
}

interface DirectoryIdentity {
  readonly Path: string
  readonly Dev: number
  readonly Ino: number
}

interface OwnedStaging {
  readonly Work: DirectoryIdentity
  readonly Nonce: DirectoryIdentity
  readonly Boundary: DirectoryIdentity
}

interface StagingAcquisition {
  OwnedNonce: DirectoryIdentity | null
  OwnedStaging: OwnedStaging | null
}

interface StagedProject {
  readonly StagedRoot: string
  readonly CanonicalConfig: string
  readonly SelectedFileSeals: readonly SelectedFileSeal[] | null
}

interface SelectedFileSeal {
  readonly Path: string
  readonly Target: string
  readonly Source: boolean
  readonly Dev: bigint
  readonly Ino: bigint
  readonly Size: bigint
  readonly CtimeNs: bigint
  readonly MtimeNs: bigint
  readonly Bytes: Uint8Array
}

interface SelectedFileEvidence {
  readonly Status: BigIntStats
  readonly Bytes: Uint8Array
}

interface AdmittedProject {
  readonly Project: Project
  readonly SourceFiles: readonly SourceFile[]
}

class ProjectSessionAdmissionError extends Error {
  readonly Issue: SessionIssue

  constructor(issue: SessionIssue) {
    super(issue.Message)
    this.name = "ProjectSessionAdmissionError"
    this.Issue = issue
  }
}

class ProjectSessionCleanupIdentityError extends Error {
  constructor() {
    super("project session cleanup directory identity differs")
    this.name = "ProjectSessionCleanupIdentityError"
  }
}

const WorkPath = ".artifacts/gates/work"
const StageDirectoryName = "boundary-project"
const OwnedStagingByPath = new Map<string, OwnedStaging>()
const SnapshotTextDecoder = new TextDecoder("utf-8", { fatal: true })

function CompareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function BytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function IsRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function ErrorCode(error: unknown): string | null {
  return IsRecord(error) && typeof error.code === "string" ? error.code : null
}

function Admission(Code: string, Path: string, Message: string): ProjectSessionAdmissionError {
  return new ProjectSessionAdmissionError({ Code, Path, Message })
}

function InputInvalid(path: string, message: string): ProjectSessionAdmissionError {
  return Admission("PROJECT_SESSION_INPUT_INVALID", path, message)
}

function StageInvalid(path: string, message: string): ProjectSessionAdmissionError {
  return Admission("PROJECT_SESSION_STAGE_INVALID", path, message)
}

function ScopeInvalid(path: string, message: string): ProjectSessionAdmissionError {
  return Admission("PROJECT_SESSION_SCOPE_INVALID", path, message)
}

function WorkspaceInputMissing(path: string, message: string): ProjectSessionAdmissionError {
  return Admission("PROJECT_SESSION_INPUT_MISSING", path, message)
}

function IsSafeRelativePath(value: string): boolean {
  if (
    value.length === 0
    || value.startsWith("/")
    || /^[A-Za-z]:\//.test(value)
    || value.includes("\\")
    || value.includes("\0")
  ) return false
  return value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
}

function IndexProjectInput(snapshot: InputSnapshot): IndexedProjectInput {
  const filesByPath = new Map<string, SnapshotFile>()
  for (const file of snapshot.Files) {
    const path: unknown = file.Path
    if (typeof path !== "string" || !IsSafeRelativePath(path)) {
      throw InputInvalid(typeof path === "string" ? path : "", "snapshot path must be canonical")
    }
    if (!(file.Bytes instanceof Uint8Array)) {
      throw InputInvalid(path, "snapshot bytes must be a Uint8Array")
    }
    if (filesByPath.has(path)) {
      throw InputInvalid(path, "snapshot paths must be lexically unique")
    }
    filesByPath.set(path, file)
  }

  const paths = [...filesByPath.keys()].sort(CompareCodeUnits)
  for (const path of paths) {
    const parts = path.split("/")
    for (let index = 1; index < parts.length; index += 1) {
      const ancestor = parts.slice(0, index).join("/")
      if (filesByPath.has(ancestor)) {
        throw InputInvalid(ancestor, "snapshot file conflicts with a directory prefix")
      }
    }
  }

  return { FilesByPath: filesByPath, Paths: paths }
}

function SelectProjectInput(snapshot: InputSnapshot, projectPrefix: string): SelectedProjectInput {
  if (!IsSafeRelativePath(projectPrefix)) {
    throw InputInvalid(projectPrefix, "project prefix must be a canonical POSIX relative path")
  }

  const indexed = IndexProjectInput(snapshot)

  const configPath = `${projectPrefix}/tsconfig.json`
  if (!indexed.FilesByPath.has(configPath)) {
    throw Admission(
      "PROJECT_SESSION_CONFIG_MISSING",
      configPath,
      "the exact project tsconfig.json snapshot byte is required"
    )
  }
  const projectPathPrefix = `${projectPrefix}/`
  const selected = indexed.Paths
    .filter((path) => path.startsWith(projectPathPrefix))
    .map((path) => indexed.FilesByPath.get(path) as SnapshotFile)
  return {
    ProjectPrefix: projectPrefix,
    DependencyPrefixes: [],
    SelectedPrefixes: [projectPrefix],
    ConfigPath: configPath,
    Files: selected,
    SourceFilesByPath: null
  }
}

function PrefixesOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

function AdmitWorkspaceAuthority(value: unknown): WorkspaceProjectAuthority {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw ScopeInvalid("", "workspace project authority must be a plain object")
  }
  const keys = Reflect.ownKeys(value)
  if (
    keys.length !== 2
    || !keys.includes("ProjectPrefix")
    || !keys.includes("DependencyPrefixes")
  ) {
    throw ScopeInvalid(
      "",
      "workspace project authority must contain exactly ProjectPrefix and DependencyPrefixes"
    )
  }
  const projectDescriptor = Object.getOwnPropertyDescriptor(value, "ProjectPrefix")
  const dependenciesDescriptor = Object.getOwnPropertyDescriptor(value, "DependencyPrefixes")
  if (
    projectDescriptor === undefined
    || dependenciesDescriptor === undefined
    || !("value" in projectDescriptor)
    || !("value" in dependenciesDescriptor)
  ) {
    throw ScopeInvalid("", "workspace project authority properties must be own data properties")
  }
  const projectPrefix = typeof projectDescriptor.value === "string" ? projectDescriptor.value : ""
  if (!IsSafeRelativePath(projectPrefix)) {
    throw ScopeInvalid(projectPrefix, "target project prefix must be a canonical POSIX relative path")
  }
  const dependenciesValue: unknown = dependenciesDescriptor.value
  if (
    !Array.isArray(dependenciesValue)
    || Object.getPrototypeOf(dependenciesValue) !== Array.prototype
  ) {
    throw ScopeInvalid("", "dependency prefixes must be a plain array")
  }
  const dependencyKeys = Reflect.ownKeys(dependenciesValue)
  const lengthDescriptor = Object.getOwnPropertyDescriptor(dependenciesValue, "length")
  if (
    lengthDescriptor === undefined
    || !("value" in lengthDescriptor)
    || typeof lengthDescriptor.value !== "number"
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
    || dependencyKeys.length !== lengthDescriptor.value + 1
  ) {
    throw ScopeInvalid("", "dependency prefixes must be a dense data-property array")
  }

  const dependencyPrefixes: string[] = []
  let prior: string | null = null
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(dependenciesValue, `${index}`)
    if (descriptor === undefined || !("value" in descriptor)) {
      throw ScopeInvalid("", "dependency prefixes must contain only own data properties")
    }
    const prefix = typeof descriptor.value === "string" ? descriptor.value : ""
    if (!IsSafeRelativePath(prefix)) {
      throw ScopeInvalid(prefix, "dependency prefix must be a canonical POSIX relative path")
    }
    if (prefix === projectPrefix) {
      throw ScopeInvalid(prefix, "dependency prefix must not select the target project")
    }
    if (prior !== null && CompareCodeUnits(prior, prefix) >= 0) {
      throw ScopeInvalid(prefix, "dependency prefixes must be unique and sorted by code unit")
    }
    dependencyPrefixes.push(prefix)
    prior = prefix
  }

  const selectedPrefixes = [projectPrefix, ...dependencyPrefixes]
  for (let left = 0; left < selectedPrefixes.length; left += 1) {
    for (let right = left + 1; right < selectedPrefixes.length; right += 1) {
      if (PrefixesOverlap(selectedPrefixes[left] as string, selectedPrefixes[right] as string)) {
        throw ScopeInvalid(
          selectedPrefixes[right] as string,
          "selected package prefixes must not overlap"
        )
      }
    }
  }
  return { ProjectPrefix: projectPrefix, DependencyPrefixes: dependencyPrefixes }
}

function IsPackageSourcePath(path: string, prefix: string): boolean {
  return path.startsWith(`${prefix}/src/`) && path.endsWith(".ts")
}

function CanonicalWorkspaceSourceText(file: SnapshotFile): string {
  if (
    file.Bytes.length >= 3
    && file.Bytes[0] === 0xef
    && file.Bytes[1] === 0xbb
    && file.Bytes[2] === 0xbf
  ) {
    throw Admission(
      "PROJECT_SESSION_SOURCE_NOT_SNAPSHOT",
      file.Path,
      "selected source snapshot must not contain a UTF-8 BOM"
    )
  }
  try {
    return SnapshotTextDecoder.decode(file.Bytes)
  } catch {
    throw Admission(
      "PROJECT_SESSION_SOURCE_NOT_SNAPSHOT",
      file.Path,
      "selected source snapshot is not fatal UTF-8 text"
    )
  }
}

function SelectWorkspaceProjectInput(
  snapshot: InputSnapshot,
  authorityValue: unknown
): SelectedProjectInput {
  const authority = AdmitWorkspaceAuthority(authorityValue)
  const indexed = IndexProjectInput(snapshot)
  const selectedPrefixes = [authority.ProjectPrefix, ...authority.DependencyPrefixes]
  const sourceFilesByPath = new Map<string, SnapshotFile>()

  for (const prefix of selectedPrefixes) {
    for (const required of ["package.json", "tsconfig.json"] as const) {
      const path = `${prefix}/${required}`
      if (!indexed.FilesByPath.has(path)) {
        throw WorkspaceInputMissing(path, `selected package ${required} snapshot byte is required`)
      }
    }
    const sourcePaths = indexed.Paths.filter((path) => IsPackageSourcePath(path, prefix))
    if (sourcePaths.length === 0) {
      throw WorkspaceInputMissing(`${prefix}/src`, "selected package requires at least one src/**/*.ts snapshot byte")
    }
    for (const path of sourcePaths) {
      const source = indexed.FilesByPath.get(path) as SnapshotFile
      CanonicalWorkspaceSourceText(source)
      sourceFilesByPath.set(path, source)
    }
  }

  const files = indexed.Paths
    .filter((path) => selectedPrefixes.some((prefix) => path.startsWith(`${prefix}/`)))
    .map((path) => indexed.FilesByPath.get(path) as SnapshotFile)
  return {
    ProjectPrefix: authority.ProjectPrefix,
    DependencyPrefixes: authority.DependencyPrefixes,
    SelectedPrefixes: selectedPrefixes,
    ConfigPath: `${authority.ProjectPrefix}/tsconfig.json`,
    Files: files,
    SourceFilesByPath: sourceFilesByPath
  }
}

function IsInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate)
  return fromRoot === ""
    || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot))
}

async function RequireDirectoryIdentity(
  path: string,
  issuePath: string
): Promise<DirectoryIdentity> {
  let status
  try {
    status = await lstat(path)
  } catch (error) {
    if (ErrorCode(error) === "ENOENT") {
      throw StageInvalid(issuePath, "required staging directory is missing")
    }
    throw error
  }
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw StageInvalid(issuePath, "staging component must be a non-symlink directory")
  }
  const real = await realpath(path)
  if (real !== path) {
    throw StageInvalid(issuePath, "staging component realpath identity differs")
  }
  return { Path: real, Dev: status.dev, Ino: status.ino }
}

async function EnsureWorkComponent(path: string, issuePath: string): Promise<void> {
  try {
    const status = await lstat(path)
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw StageInvalid(issuePath, "staging component must be a non-symlink directory")
    }
  } catch (error) {
    if (error instanceof ProjectSessionAdmissionError) throw error
    if (ErrorCode(error) !== "ENOENT") throw error
    try {
      await mkdir(path, { mode: 0o700 })
    } catch (mkdirError) {
      if (ErrorCode(mkdirError) !== "EEXIST") throw mkdirError
    }
  }
  await RequireDirectoryIdentity(path, issuePath)
}

async function EnsureMaterializationDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 })
  } catch (error) {
    if (ErrorCode(error) !== "EEXIST") throw error
  }
  await RequireDirectoryIdentity(path, WorkPath)
}

async function MaterializeFile(stagedRoot: string, file: SnapshotFile): Promise<void> {
  const target = join(stagedRoot, ...file.Path.split("/"))
  const pathFromRoot = relative(stagedRoot, target)
  if (!IsInside(stagedRoot, target) || pathFromRoot.length === 0) {
    throw InputInvalid(file.Path, "materialization target escapes staging")
  }
  const parentParts = dirname(pathFromRoot).split(sep).filter((part) => part.length > 0 && part !== ".")
  let directory = stagedRoot
  for (const part of parentParts) {
    directory = join(directory, part)
    await EnsureMaterializationDirectory(directory)
  }
  try {
    await writeFile(target, file.Bytes, { flag: "wx", mode: 0o600 })
  } catch (error) {
    if (ErrorCode(error) === "EEXIST") {
      throw StageInvalid(WorkPath, "exclusive materialization target already exists")
    }
    throw error
  }
}

function SelectedFileInvalid(
  path: string,
  source: boolean,
  message: string
): ProjectSessionAdmissionError {
  return source
    ? Admission("PROJECT_SESSION_SOURCE_NOT_SNAPSHOT", path, message)
    : StageInvalid(path, message)
}

function SameFileStatus(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.ctimeNs === right.ctimeNs
    && left.mtimeNs === right.mtimeNs
}

async function ReadSelectedFileEvidence(
  target: string,
  path: string,
  source: boolean
): Promise<SelectedFileEvidence> {
  try {
    const before = await lstat(target, { bigint: true })
    if (before.isSymbolicLink() || !before.isFile() || await realpath(target) !== target) {
      throw SelectedFileInvalid(path, source, "selected staged file identity is invalid")
    }
    const bytes = new Uint8Array(await readFile(target))
    const after = await lstat(target, { bigint: true })
    if (!SameFileStatus(before, after)) {
      throw SelectedFileInvalid(path, source, "selected staged file changed while observed")
    }
    return { Status: after, Bytes: bytes }
  } catch (error) {
    if (error instanceof ProjectSessionAdmissionError) throw error
    throw SelectedFileInvalid(path, source, "selected staged file evidence is unavailable")
  }
}

async function CaptureSelectedFileSeals(
  stagedRoot: string,
  selected: SelectedProjectInput
): Promise<readonly SelectedFileSeal[] | null> {
  if (selected.SourceFilesByPath === null) return null
  const seals: SelectedFileSeal[] = []
  for (const file of selected.Files) {
    const target = join(stagedRoot, ...file.Path.split("/"))
    const source = selected.SourceFilesByPath.has(file.Path)
    const evidence = await ReadSelectedFileEvidence(target, file.Path, source)
    if (!BytesEqual(evidence.Bytes, file.Bytes)) {
      throw SelectedFileInvalid(file.Path, source, "selected staged bytes differ after materialization")
    }
    seals.push({
      Path: file.Path,
      Target: target,
      Source: source,
      Dev: evidence.Status.dev,
      Ino: evidence.Status.ino,
      Size: evidence.Status.size,
      CtimeNs: evidence.Status.ctimeNs,
      MtimeNs: evidence.Status.mtimeNs,
      Bytes: evidence.Bytes
    })
  }
  return seals
}

async function RequireSelectedFileSeals(
  seals: readonly SelectedFileSeal[] | null
): Promise<void> {
  if (seals === null) return
  for (const seal of seals) {
    const evidence = await ReadSelectedFileEvidence(seal.Target, seal.Path, seal.Source)
    if (
      evidence.Status.dev !== seal.Dev
      || evidence.Status.ino !== seal.Ino
      || evidence.Status.size !== seal.Size
      || evidence.Status.ctimeNs !== seal.CtimeNs
      || evidence.Status.mtimeNs !== seal.MtimeNs
      || !BytesEqual(evidence.Bytes, seal.Bytes)
    ) {
      throw SelectedFileInvalid(
        seal.Path,
        seal.Source,
        "selected staged file changed across the worker update"
      )
    }
  }
}

async function AcquireStagedProject(
  selected: SelectedProjectInput,
  operations: ProjectSessionOperations,
  acquisition: StagingAcquisition
): Promise<StagedProject> {
  const repositoryRoot = resolve(operations.RepositoryRoot)
  if (!isAbsolute(operations.RepositoryRoot) || repositoryRoot !== operations.RepositoryRoot) {
    throw StageInvalid(".", "repository root must be bound to an absolute canonical path")
  }
  const repositoryReal = (await RequireDirectoryIdentity(repositoryRoot, ".")).Path
  const componentPaths = [".artifacts", ".artifacts/gates", WorkPath] as const
  for (const component of componentPaths) {
    await EnsureWorkComponent(join(repositoryReal, ...component.split("/")), component)
  }

  const work = join(repositoryReal, ...WorkPath.split("/"))
  const workIdentity = await RequireDirectoryIdentity(work, WorkPath)
  const nonce = join(work, randomUUID())
  try {
    await mkdir(nonce, { mode: 0o700 })
  } catch (error) {
    if (ErrorCode(error) === "EEXIST") {
      throw StageInvalid(WorkPath, "unique staging nonce already exists")
    }
    throw error
  }
  const nonceIdentity = await RequireDirectoryIdentity(nonce, WorkPath)
  acquisition.OwnedNonce = nonceIdentity
  const boundary = join(nonce, StageDirectoryName)
  try {
    await mkdir(boundary, { mode: 0o700 })
  } catch (error) {
    if (ErrorCode(error) === "EEXIST") {
      throw StageInvalid(WorkPath, "boundary project stage already exists")
    }
    throw error
  }
  const boundaryIdentity = await RequireDirectoryIdentity(boundary, WorkPath)
  const ownedStaging = {
    Work: workIdentity,
    Nonce: nonceIdentity,
    Boundary: boundaryIdentity
  }
  if (OwnedStagingByPath.has(boundaryIdentity.Path)) {
    throw new Error("project session staging identity is already registered")
  }
  OwnedStagingByPath.set(boundaryIdentity.Path, ownedStaging)
  acquisition.OwnedStaging = ownedStaging
  const stagedRoot = boundaryIdentity.Path
  for (const file of selected.Files) await MaterializeFile(stagedRoot, file)
  const selectedFileSeals = await CaptureSelectedFileSeals(stagedRoot, selected)
  return {
    StagedRoot: stagedRoot,
    CanonicalConfig: join(stagedRoot, ...selected.ConfigPath.split("/")),
    SelectedFileSeals: selectedFileSeals
  }
}

async function RequireMissing(path: string): Promise<void> {
  try {
    await lstat(path)
  } catch (error) {
    if (ErrorCode(error) === "ENOENT") return
    throw error
  }
  throw new Error("project session cleanup path still exists")
}

async function RequireCleanupDirectoryIdentity(identity: DirectoryIdentity): Promise<void> {
  let status
  try {
    status = await lstat(identity.Path)
  } catch (error) {
    if (ErrorCode(error) === "ENOENT") throw new ProjectSessionCleanupIdentityError()
    throw error
  }
  if (
    status.isSymbolicLink()
    || !status.isDirectory()
    || status.dev !== identity.Dev
    || status.ino !== identity.Ino
  ) throw new ProjectSessionCleanupIdentityError()
  try {
    if (await realpath(identity.Path) !== identity.Path) {
      throw new ProjectSessionCleanupIdentityError()
    }
  } catch (error) {
    if (error instanceof ProjectSessionCleanupIdentityError) throw error
    if (ErrorCode(error) === "ENOENT") throw new ProjectSessionCleanupIdentityError()
    throw error
  }
}

async function RequireOwnedStagingIdentity(owned: OwnedStaging): Promise<void> {
  await RequireCleanupDirectoryIdentity(owned.Work)
  await RequireCleanupDirectoryIdentity(owned.Nonce)
  await RequireCleanupDirectoryIdentity(owned.Boundary)
}

async function RequireRegisteredOwnedStagingIdentity(owned: OwnedStaging): Promise<void> {
  if (OwnedStagingByPath.get(owned.Boundary.Path) !== owned) {
    throw new ProjectSessionCleanupIdentityError()
  }
  try {
    await RequireOwnedStagingIdentity(owned)
  } catch (error) {
    if (error instanceof ProjectSessionCleanupIdentityError) {
      OwnedStagingByPath.delete(owned.Boundary.Path)
    }
    throw error
  }
}

async function RemoveOwnedNonce(identity: DirectoryIdentity): Promise<void> {
  await RequireCleanupDirectoryIdentity(identity)
  await rmdir(identity.Path)
  await RequireMissing(identity.Path)
}

async function RemoveOwnedStaging(repositoryRoot: string, path: string): Promise<void> {
  const root = resolve(repositoryRoot)
  const work = join(root, ...WorkPath.split("/"))
  const nonce = dirname(path)
  const owned = OwnedStagingByPath.get(path)
  if (
    basename(path) !== StageDirectoryName
    || dirname(nonce) !== work
    || basename(nonce).length === 0
    || owned === undefined
    || owned.Work.Path !== work
    || owned.Nonce.Path !== nonce
    || owned.Boundary.Path !== path
  ) throw new Error("refusing to remove a non-owned project session path")
  await RequireRegisteredOwnedStagingIdentity(owned)
  await rm(path, { recursive: true, force: true })
  await RemoveOwnedNonce(owned.Nonce)
  await RequireMissing(path)
  OwnedStagingByPath.delete(path)
}

export function NodeProjectSessionOperations(
  repositoryRoot: string = process.cwd()
): ProjectSessionOperations {
  const absoluteRoot = resolve(repositoryRoot)
  let boundRoot = absoluteRoot
  try {
    const status = lstatSync(absoluteRoot)
    if (status.isDirectory() && !status.isSymbolicLink()) {
      boundRoot = realpathSync(absoluteRoot)
    }
  } catch {
    // Admission reports invalid or missing roots through the stable session issue contract.
  }
  return {
    RepositoryRoot: boundRoot,
    UpdateSnapshot: (api, canonicalTsconfig) => api.updateSnapshot({
      openProjects: [canonicalTsconfig]
    }),
    DisposeSnapshot: (snapshot) => snapshot.dispose(),
    CloseAPI: (api) => api.close(),
    RemoveStaging: (path) => RemoveOwnedStaging(boundRoot, path)
  }
}

function StableStagePath(stagedRoot: string, path: string, fallback: string): string {
  if (!IsInside(stagedRoot, path)) return fallback
  const mapped = relative(stagedRoot, path).split(sep).join("/")
  return mapped.length === 0 ? fallback : mapped
}

async function IsLowercaseConfigIdentity(
  canonicalConfig: string,
  canonicalStatus: Stats
): Promise<boolean> {
  const lowercaseConfig = canonicalConfig.toLowerCase()
  const [lowercaseStatus, lowercaseRealPath] = await Promise.allSettled([
    lstat(lowercaseConfig),
    realpath(lowercaseConfig)
  ])
  for (const result of [lowercaseStatus, lowercaseRealPath]) {
    if (result.status === "rejected" && ErrorCode(result.reason) !== "ENOENT") throw result.reason
  }
  return (
    lowercaseConfig !== canonicalConfig
    && lowercaseStatus.status === "fulfilled"
    && !lowercaseStatus.value.isSymbolicLink()
    && lowercaseStatus.value.isFile()
    && lowercaseStatus.value.dev === canonicalStatus.dev
    && lowercaseStatus.value.ino === canonicalStatus.ino
    && lowercaseRealPath.status === "fulfilled"
    && lowercaseRealPath.value === canonicalConfig
  )
}

async function RequireConfigIdentity(
  project: Project,
  canonicalConfig: string,
  projectPrefix: string
): Promise<void> {
  const issuePath = `${projectPrefix}/tsconfig.json`
  const projectId = String(project.id)
  if (
    project.configFileName !== canonicalConfig
    || !isAbsolute(canonicalConfig)
    || normalize(canonicalConfig) !== canonicalConfig
  ) {
    throw Admission(
      "PROJECT_SESSION_PROJECT_IDENTITY",
      issuePath,
      "TypeScript project identity differs from the exact canonical config"
    )
  }
  let canonicalStatus: Stats
  try {
    canonicalStatus = await lstat(canonicalConfig)
    if (
      canonicalStatus.isSymbolicLink()
      || !canonicalStatus.isFile()
      || await realpath(canonicalConfig) !== canonicalConfig
    ) {
      throw Admission(
        "PROJECT_SESSION_PROJECT_IDENTITY",
        issuePath,
        "canonical config file identity is invalid"
      )
    }
  } catch (error) {
    if (error instanceof ProjectSessionAdmissionError) throw error
    if (ErrorCode(error) === "ENOENT") {
      throw Admission(
        "PROJECT_SESSION_PROJECT_IDENTITY",
        issuePath,
        "canonical config file is no longer present"
      )
    }
    throw error
  }
  if (
    projectId !== canonicalConfig
    && (
      projectId !== canonicalConfig.toLowerCase()
      || !await IsLowercaseConfigIdentity(canonicalConfig, canonicalStatus)
    )
  ) {
    throw Admission(
      "PROJECT_SESSION_PROJECT_IDENTITY",
      issuePath,
      "TypeScript project identity differs from the exact canonical config"
    )
  }
}

async function AdmitSourceFiles(
  project: Project,
  stagedRoot: string,
  selected: SelectedProjectInput
): Promise<readonly SourceFile[]> {
  const sourceRoots = selected.SelectedPrefixes.map((Prefix) => ({
    Prefix,
    Root: join(stagedRoot, ...Prefix.split("/"), "src")
  }))
  const sourceNames = await project.program.getSourceFileNames()
  const sources: SourceFile[] = []
  const realPaths = new Set<string>()
  const realSourceRoots = new Map<string, string>()

  function ExactSnapshotSource(path: string): SnapshotFile | null {
    if (selected.SourceFilesByPath === null) return null
    const file = selected.SourceFilesByPath.get(path)
    if (file === undefined) {
      throw Admission(
        "PROJECT_SESSION_SOURCE_NOT_SNAPSHOT",
        path,
        "program source does not correspond to a selected snapshot byte"
      )
    }
    return file
  }

  for (const sourceName of sourceNames) {
    const stablePath = StableStagePath(stagedRoot, sourceName, selected.ProjectPrefix)
    if (!isAbsolute(sourceName) || normalize(sourceName) !== sourceName || resolve(sourceName) !== sourceName) {
      throw Admission(
        "PROJECT_SESSION_SOURCE_IDENTITY",
        stablePath,
        "TypeScript source name is not absolute canonical"
      )
    }
    const sourceFile = await project.program.getSourceFile(sourceName)
    if (sourceFile === undefined) {
      throw Admission(
        "PROJECT_SESSION_SOURCE_MISSING",
        stablePath,
        "TypeScript reported source cannot be resolved"
      )
    }
    if (sourceFile.fileName !== sourceName) {
      throw Admission(
        "PROJECT_SESSION_SOURCE_IDENTITY",
        stablePath,
        "TypeScript source identity differs from its reported name"
      )
    }
    if (await project.program.isSourceFileDefaultLibrary(sourceFile)) continue
    if (await project.program.isSourceFileFromExternalLibrary(sourceFile)) {
      throw Admission(
        "PROJECT_SESSION_EXTERNAL_SOURCE",
        stablePath,
        "non-default external library source is not snapshotted authority"
      )
    }
    if (
      selected.SourceFilesByPath !== null
      && stablePath.split("/").includes("node_modules")
    ) {
      throw Admission(
        "PROJECT_SESSION_EXTERNAL_SOURCE",
        stablePath,
        "node_modules source is not snapshotted workspace authority"
      )
    }
    const matchingRoots = sourceRoots.filter((sourceRoot) => (
      IsInside(sourceRoot.Root, sourceName) && sourceName !== sourceRoot.Root
    ))
    if (matchingRoots.length !== 1) {
      throw Admission(
        selected.SourceFilesByPath === null
          ? "PROJECT_SESSION_SOURCE_ESCAPE"
          : "PROJECT_SESSION_SOURCE_UNAUTHORIZED",
        stablePath,
        "local project source is outside exactly one selected src directory"
      )
    }
    const matchingRoot = matchingRoots[0] as { readonly Prefix: string; readonly Root: string }
    const snapshottedSource = ExactSnapshotSource(stablePath)

    try {
      let sourceRootReal = realSourceRoots.get(matchingRoot.Prefix)
      if (sourceRootReal === undefined) {
        const rootStatus = await lstat(matchingRoot.Root)
        if (rootStatus.isSymbolicLink() || !rootStatus.isDirectory()) {
          throw Admission(
            "PROJECT_SESSION_SOURCE_ESCAPE",
            stablePath,
            "staged src root identity is invalid"
          )
        }
        sourceRootReal = await realpath(matchingRoot.Root)
        if (sourceRootReal !== matchingRoot.Root) {
          throw Admission(
            "PROJECT_SESSION_SOURCE_ESCAPE",
            stablePath,
            "staged src root realpath differs"
          )
        }
        realSourceRoots.set(matchingRoot.Prefix, sourceRootReal)
      }
      const status = await lstat(sourceName)
      if (status.isSymbolicLink() || !status.isFile()) {
        throw Admission(
          "PROJECT_SESSION_SOURCE_ESCAPE",
          stablePath,
          "local project source must be a non-symlink regular file"
        )
      }
      const sourceReal = await realpath(sourceName)
      if (
        sourceReal !== sourceName
        || !IsInside(sourceRootReal, sourceReal)
        || realPaths.has(sourceReal)
      ) {
        throw Admission(
          "PROJECT_SESSION_SOURCE_ESCAPE",
          stablePath,
          "local project source realpath escapes or is duplicated"
        )
      }
      realPaths.add(sourceReal)
      if (snapshottedSource !== null) {
        const snapshotText = CanonicalWorkspaceSourceText(snapshottedSource)
        if (sourceFile.text !== snapshotText) {
          throw Admission(
            "PROJECT_SESSION_SOURCE_NOT_SNAPSHOT",
            stablePath,
            "program AST text differs from the selected snapshot text"
          )
        }
        const stagedBytes = new Uint8Array(await readFile(sourceName))
        if (!BytesEqual(stagedBytes, snapshottedSource.Bytes)) {
          throw Admission(
            "PROJECT_SESSION_SOURCE_NOT_SNAPSHOT",
            stablePath,
            "program source bytes differ from the selected snapshot byte"
          )
        }
      }
    } catch (error) {
      if (error instanceof ProjectSessionAdmissionError) throw error
      if (ErrorCode(error) === "ENOENT") {
        throw Admission(
          "PROJECT_SESSION_SOURCE_ESCAPE",
          stablePath,
          "local project source identity is missing"
        )
      }
      throw error
    }
    if (matchingRoot.Prefix === selected.ProjectPrefix) sources.push(sourceFile)
  }

  if (sources.length === 0) {
    throw Admission(
      "PROJECT_SESSION_SOURCE_ZERO",
      `${selected.ProjectPrefix}/src`,
      "project contains no admitted local package source"
    )
  }
  return sources.sort((left, right) => CompareCodeUnits(left.fileName, right.fileName))
}

async function AdmitProject(
  snapshot: Snapshot,
  staged: StagedProject,
  selected: SelectedProjectInput
): Promise<AdmittedProject> {
  const projects = snapshot.getProjects()
  if (projects.length !== 1) {
    throw Admission(
      "PROJECT_SESSION_PROJECT_COUNT",
      `${selected.ProjectPrefix}/tsconfig.json`,
      "TypeScript worker must return exactly one project"
    )
  }
  const project = projects[0] as Project
  await RequireConfigIdentity(project, staged.CanonicalConfig, selected.ProjectPrefix)
  const sourceFiles = await AdmitSourceFiles(project, staged.StagedRoot, selected)
  return { Project: project, SourceFiles: sourceFiles }
}

async function RunProjectSession<T>(
  snapshot: InputSnapshot,
  select: (snapshot: InputSnapshot) => SelectedProjectInput,
  use: (session: ProjectSession) => Promise<T>,
  operations: ProjectSessionOperations
): Promise<T> {
  const acquisition: StagingAcquisition = { OwnedNonce: null, OwnedStaging: null }
  let api: API | null = null
  let workerSnapshot: Snapshot | null = null
  let hasValue = false
  let value: T | undefined
  let hasPrimary = false
  let primary: unknown

  try {
    const selected = select(snapshot)
    const staged = await AcquireStagedProject(selected, operations, acquisition)
    api = new API({ cwd: staged.StagedRoot })
    workerSnapshot = await operations.UpdateSnapshot(api, staged.CanonicalConfig)
    await RequireSelectedFileSeals(staged.SelectedFileSeals)
    const admitted = await AdmitProject(workerSnapshot, staged, selected)
    value = await use({
      Project: admitted.Project,
      SourceFiles: admitted.SourceFiles,
      StagedRoot: staged.StagedRoot
    })
    hasValue = true
  } catch (error) {
    hasPrimary = true
    primary = error
  }

  const cleanupErrors: unknown[] = []
  if (workerSnapshot !== null) {
    try {
      await operations.DisposeSnapshot(workerSnapshot)
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  if (api !== null) {
    try {
      await operations.CloseAPI(api)
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  if (acquisition.OwnedStaging !== null) {
    const owned = acquisition.OwnedStaging
    try {
      await RequireRegisteredOwnedStagingIdentity(owned)
      await operations.RemoveStaging(owned.Boundary.Path)
      OwnedStagingByPath.delete(owned.Boundary.Path)
    } catch (error) {
      cleanupErrors.push(error)
    }
  } else if (acquisition.OwnedNonce !== null) {
    try {
      await RemoveOwnedNonce(acquisition.OwnedNonce)
    } catch (error) {
      cleanupErrors.push(error)
    }
  }

  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      hasPrimary ? [primary, ...cleanupErrors] : cleanupErrors,
      "project session cleanup failed"
    )
  }
  if (hasPrimary) throw primary
  if (hasValue) return value as T
  throw new Error("project session completed without a callback value")
}

export async function WithProjectSession<T>(
  snapshot: InputSnapshot,
  projectPrefix: string,
  use: (session: ProjectSession) => Promise<T>
): Promise<T> {
  return WithProjectSessionWithOperations(
    snapshot,
    projectPrefix,
    use,
    NodeProjectSessionOperations(process.cwd())
  )
}

export async function WithProjectSessionWithOperations<T>(
  snapshot: InputSnapshot,
  projectPrefix: string,
  use: (session: ProjectSession) => Promise<T>,
  operations: ProjectSessionOperations
): Promise<T> {
  return RunProjectSession(
    snapshot,
    (input) => SelectProjectInput(input, projectPrefix),
    use,
    operations
  )
}

export async function WithWorkspaceProjectSessionWithOperations<T>(
  snapshot: InputSnapshot,
  authority: WorkspaceProjectAuthority,
  use: (session: ProjectSession) => Promise<T>,
  operations: ProjectSessionOperations
): Promise<T> {
  return RunProjectSession(
    snapshot,
    (input) => SelectWorkspaceProjectInput(input, authority),
    use,
    operations
  )
}

export async function AnalyzeProjectSession(
  snapshot: InputSnapshot,
  projectPrefix: string
): Promise<{ readonly SourceFilesChecked: number; readonly Issues: readonly SessionIssue[] }> {
  return AnalyzeProjectSessionWithOperations(
    snapshot,
    projectPrefix,
    NodeProjectSessionOperations(process.cwd())
  )
}

interface DiagnosticFamily {
  readonly Name: string
  readonly Diagnostics: readonly Diagnostic[]
}

interface MappedDiagnosticPath {
  readonly Path: string
  readonly Escaped: boolean
}

interface DiagnosticReplacement {
  readonly From: string
  readonly To: string
  readonly Escaped: boolean
}

interface DiagnosticContext {
  readonly StagedRoot: string
  readonly SelectedRoots: readonly DiagnosticSelectedRoot[]
  readonly ProjectPrefix: string
  readonly Replacements: readonly DiagnosticReplacement[]
}

interface NormalizedDiagnosticText {
  readonly Text: string
  readonly Escaped: boolean
}

interface DiagnosticSelectedRoot {
  readonly Prefix: string
  readonly Root: string
}

function NormalizeDiagnosticSeparators(value: string): string {
  return value.replaceAll("\\", "/")
}

function MapDiagnosticFileName(
  fileName: string | undefined,
  stagedRoot: string,
  selectedRoots: readonly DiagnosticSelectedRoot[],
  projectPrefix: string
): MappedDiagnosticPath {
  if (fileName === undefined) return { Path: projectPrefix, Escaped: false }
  const matchingRoots = selectedRoots.filter((selected) => IsInside(selected.Root, fileName))
  if (
    !isAbsolute(fileName)
    || (sep === "/" && fileName.includes("\\"))
    || NormalizeDiagnosticSeparators(normalize(fileName)) !== NormalizeDiagnosticSeparators(fileName)
    || matchingRoots.length !== 1
  ) return { Path: projectPrefix, Escaped: true }
  const mapped = relative(stagedRoot, fileName).split(sep).join("/")
  return { Path: mapped.length === 0 ? projectPrefix : mapped, Escaped: false }
}

function VisitDiagnosticGraph(
  diagnostic: Diagnostic,
  visit: (diagnostic: Diagnostic) => void
): void {
  visit(diagnostic)
  for (const child of diagnostic.messageChain ?? []) VisitDiagnosticGraph(child, visit)
  for (const related of diagnostic.relatedInformation ?? []) VisitDiagnosticGraph(related, visit)
}

async function CreateDiagnosticContext(
  stagedRoot: string,
  projectPrefix: string,
  selectedPrefixes: readonly string[],
  families: readonly DiagnosticFamily[]
): Promise<DiagnosticContext> {
  const stagedRealRoot = await realpath(stagedRoot)
  const selectedRoots = selectedPrefixes.map((Prefix) => ({
    Prefix,
    Root: join(stagedRoot, ...Prefix.split("/"))
  }))
  const replacementsBySource = new Map<string, DiagnosticReplacement>()
  function AddReplacement(source: string, target: string, escaped: boolean): void {
    const normalizedSource = NormalizeDiagnosticSeparators(source)
    const existing = replacementsBySource.get(normalizedSource)
    if (
      existing !== undefined
      && (existing.To !== target || existing.Escaped !== escaped)
    ) {
      throw new Error("diagnostic path has conflicting stable replacements")
    }
    replacementsBySource.set(normalizedSource, {
      From: normalizedSource,
      To: target,
      Escaped: escaped
    })
  }
  AddReplacement(stagedRoot, projectPrefix, true)
  AddReplacement(stagedRealRoot, projectPrefix, true)
  for (const selected of selectedRoots) {
    AddReplacement(selected.Root, selected.Prefix, false)
    AddReplacement(await realpath(selected.Root), selected.Prefix, false)
  }
  for (const family of families) {
    for (const diagnostic of family.Diagnostics) {
      VisitDiagnosticGraph(diagnostic, (node) => {
        if (node.fileName === undefined) return
        const mapped = MapDiagnosticFileName(
          node.fileName,
          stagedRoot,
          selectedRoots,
          projectPrefix
        )
        AddReplacement(node.fileName, mapped.Path, mapped.Escaped)
      })
    }
  }
  const replacements = [...replacementsBySource.values()]
    .sort((left, right) => (
      right.From.length - left.From.length || CompareCodeUnits(left.From, right.From)
    ))
  return { StagedRoot: stagedRoot, SelectedRoots: selectedRoots, ProjectPrefix: projectPrefix, Replacements: replacements }
}

function NormalizeDiagnosticText(
  value: string,
  context: DiagnosticContext
): NormalizedDiagnosticText {
  let stable = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n")
  let escaped = false
  function RedactAbsolutePath(value: string): string {
    let candidate = value
    let suffix = ""
    while (candidate.endsWith(".")) {
      candidate = candidate.slice(0, -1)
      suffix += "."
    }
    const normalizedCandidate = NormalizeDiagnosticSeparators(candidate)
    const mapped = MapDiagnosticFileName(
      normalizedCandidate,
      context.StagedRoot,
      context.SelectedRoots,
      context.ProjectPrefix
    )
    for (const replacement of context.Replacements) {
      if (
        normalizedCandidate !== replacement.From
        && !normalizedCandidate.startsWith(`${replacement.From}/`)
      ) continue
      if (replacement.Escaped || mapped.Escaped) {
        escaped = true
        return `${context.ProjectPrefix}${suffix}`
      }
      return `${mapped.Path}${suffix}`
    }
    if (mapped.Escaped) escaped = true
    return `${mapped.Path}${suffix}`
  }
  function RedactPathText(value: string): string {
    let redacted = value
    const fileUrls = [...redacted.matchAll(
      /(^|[^A-Za-z0-9_\/])(file:\/\/[^\s"'`<>()\[\]{},;!?]+)/gim
    )]
    for (const match of fileUrls) {
      const prefix = match[1] as string
      escaped = true
      redacted = redacted.replaceAll(match[0], `${prefix}file:///${context.ProjectPrefix}`)
    }
    const quotedWindowsPaths = [...redacted.matchAll(
      /(["'`])((?:\\\\[?.]\\|\\\\(?![?.]\\)|[A-Za-z]:\\)[^"'`\r\n]+)\1/g
    )]
    for (const match of quotedWindowsPaths) {
      const quote = match[1] as string
      const path = match[2] as string
      redacted = redacted.replaceAll(match[0], `${quote}${RedactAbsolutePath(path)}${quote}`)
    }
    const unquotedWindowsPaths = [...redacted.matchAll(
      /(^|[^A-Za-z0-9_\/\\])((?:\\\\[?.]\\|\\\\(?![?.]\\)|[A-Za-z]:\\)[^\s"'`<>()\[\]{},;!?]+)/gm
    )]
    for (const match of unquotedWindowsPaths) {
      const prefix = match[1] as string
      const path = match[2] as string
      redacted = redacted.replaceAll(match[0], `${prefix}${RedactAbsolutePath(path)}`)
    }
    redacted = NormalizeDiagnosticSeparators(redacted)
    const quotedPaths = [...redacted.matchAll(
      /(["'`])((?:[A-Za-z]:\/|\/(?!\/))[^"'`\r\n]+)\1/g
    )]
    for (const match of quotedPaths) {
      const quote = match[1] as string
      const path = match[2] as string
      redacted = redacted.replaceAll(match[0], `${quote}${RedactAbsolutePath(path)}${quote}`)
    }
    const unquotedPaths = [...redacted.matchAll(
      /(^|[^A-Za-z0-9_.\/\\])((?:[A-Za-z]:\/|\/(?!\/))[^\s"'`<>()\[\]{},;!?]+)/gm
    )]
    for (const match of unquotedPaths) {
      const prefix = match[1] as string
      const path = match[2] as string
      redacted = redacted.replaceAll(match[0], `${prefix}${RedactAbsolutePath(path)}`)
    }
    return redacted
  }

  const preservedUrls = [...stable.matchAll(
    /(^|[^A-Za-z0-9_\/])(https?:\/\/[^\s"'`<>]+)|(^|[^A-Za-z0-9_:/])(\/\/[^\s"'`<>]+)/gim
  )]
  let text = ""
  let cursor = 0
  for (const match of preservedUrls) {
    const prefix = (match[1] ?? match[3]) as string
    const url = (match[2] ?? match[4]) as string
    const start = (match.index as number) + prefix.length
    text += RedactPathText(stable.slice(cursor, start))
    text += url
    cursor = start + url.length
  }
  text += RedactPathText(stable.slice(cursor))
  return { Text: text, Escaped: escaped }
}

function DiagnosticEscapeIssue(projectPrefix: string): SessionIssue {
  return {
    Code: "PROJECT_SESSION_DIAGNOSTIC_PATH_ESCAPE",
    Path: projectPrefix,
    Message: "TypeScript diagnostic file path is outside the staged project"
  }
}

function CollectDiagnosticMessage(
  diagnostic: Diagnostic,
  related: boolean,
  context: DiagnosticContext,
  segments: string[],
  escapeIssues: SessionIssue[]
): void {
  const mapped = MapDiagnosticFileName(
    diagnostic.fileName,
    context.StagedRoot,
    context.SelectedRoots,
    context.ProjectPrefix
  )
  const text = NormalizeDiagnosticText(diagnostic.text, context)
  segments.push(
    related && diagnostic.fileName !== undefined
      ? `${mapped.Path}: ${text.Text}`
      : text.Text
  )
  if (mapped.Escaped) escapeIssues.push(DiagnosticEscapeIssue(context.ProjectPrefix))
  if (text.Escaped) escapeIssues.push(DiagnosticEscapeIssue(context.ProjectPrefix))
  for (const child of diagnostic.messageChain ?? []) {
    CollectDiagnosticMessage(child, false, context, segments, escapeIssues)
  }
  for (const information of diagnostic.relatedInformation ?? []) {
    CollectDiagnosticMessage(information, true, context, segments, escapeIssues)
  }
}

function DiagnosticIssues(
  family: DiagnosticFamily,
  context: DiagnosticContext
): SessionIssue[] {
  const issues: SessionIssue[] = []
  for (const diagnostic of family.Diagnostics) {
    const segments: string[] = []
    const escapeIssues: SessionIssue[] = []
    CollectDiagnosticMessage(diagnostic, false, context, segments, escapeIssues)
    issues.push({
      Code: `TYPESCRIPT_${family.Name}_${diagnostic.code}`,
      Path: MapDiagnosticFileName(
        diagnostic.fileName,
        context.StagedRoot,
        context.SelectedRoots,
        context.ProjectPrefix
      ).Path,
      Message: segments.join("\n")
    })
    issues.push(...escapeIssues)
  }
  return issues
}

function CompareSessionIssues(left: SessionIssue, right: SessionIssue): number {
  return CompareCodeUnits(left.Code, right.Code)
    || CompareCodeUnits(left.Path, right.Path)
    || CompareCodeUnits(left.Message, right.Message)
}

async function AnalyzeAdmittedProject(
  session: ProjectSession,
  projectPrefix: string,
  selectedPrefixes: readonly string[]
): Promise<{ readonly SourceFilesChecked: number; readonly Issues: readonly SessionIssue[] }> {
  const program = session.Project.program
  const configFileParsing = await program.getConfigFileParsingDiagnostics()
  const programDiagnostics = await program.getProgramDiagnostics()
  const globalDiagnostics = await program.getGlobalDiagnostics()
  const syntacticDiagnostics = await program.getSyntacticDiagnostics()
  const bindDiagnostics = await program.getBindDiagnostics()
  const semanticDiagnostics = await program.getSemanticDiagnostics()
  const families = [
    { Name: "CONFIG_FILE_PARSING", Diagnostics: configFileParsing },
    { Name: "PROGRAM", Diagnostics: programDiagnostics },
    { Name: "GLOBAL", Diagnostics: globalDiagnostics },
    { Name: "SYNTACTIC", Diagnostics: syntacticDiagnostics },
    { Name: "BIND", Diagnostics: bindDiagnostics },
    { Name: "SEMANTIC", Diagnostics: semanticDiagnostics }
  ]
  const context = await CreateDiagnosticContext(
    session.StagedRoot,
    projectPrefix,
    selectedPrefixes,
    families
  )
  const issues = families.flatMap((family) => DiagnosticIssues(family, context))
    .sort(CompareSessionIssues)
  return { SourceFilesChecked: session.SourceFiles.length, Issues: issues }
}

export async function AnalyzeProjectSessionWithOperations(
  snapshot: InputSnapshot,
  projectPrefix: string,
  operations: ProjectSessionOperations
): Promise<{ readonly SourceFilesChecked: number; readonly Issues: readonly SessionIssue[] }> {
  try {
    return await WithProjectSessionWithOperations(
      snapshot,
      projectPrefix,
      (session) => AnalyzeAdmittedProject(session, projectPrefix, [projectPrefix]),
      operations
    )
  } catch (error) {
    if (error instanceof ProjectSessionAdmissionError) {
      return { SourceFilesChecked: 0, Issues: [error.Issue] }
    }
    throw error
  }
}

export async function AnalyzeWorkspaceProjectSessionWithOperations(
  snapshot: InputSnapshot,
  authority: WorkspaceProjectAuthority,
  operations: ProjectSessionOperations
): Promise<{ readonly SourceFilesChecked: number; readonly Issues: readonly SessionIssue[] }> {
  try {
    const admittedAuthority = AdmitWorkspaceAuthority(authority)
    const selectedPrefixes = [
      admittedAuthority.ProjectPrefix,
      ...admittedAuthority.DependencyPrefixes
    ]
    return await WithWorkspaceProjectSessionWithOperations(
      snapshot,
      admittedAuthority,
      (session) => AnalyzeAdmittedProject(
        session,
        admittedAuthority.ProjectPrefix,
        selectedPrefixes
      ),
      operations
    )
  } catch (error) {
    if (error instanceof ProjectSessionAdmissionError) {
      return { SourceFilesChecked: 0, Issues: [error.Issue] }
    }
    throw error
  }
}
