import { randomUUID } from "node:crypto"
import { lstatSync, realpathSync, type Stats } from "node:fs"
import { lstat, mkdir, realpath, rm, rmdir, writeFile } from "node:fs/promises"
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

interface SelectedProjectInput {
  readonly ProjectPrefix: string
  readonly ConfigPath: string
  readonly Files: readonly SnapshotFile[]
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

function CompareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
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

function SelectProjectInput(snapshot: InputSnapshot, projectPrefix: string): SelectedProjectInput {
  if (!IsSafeRelativePath(projectPrefix)) {
    throw InputInvalid(projectPrefix, "project prefix must be a canonical POSIX relative path")
  }

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

  const configPath = `${projectPrefix}/tsconfig.json`
  if (!filesByPath.has(configPath)) {
    throw Admission(
      "PROJECT_SESSION_CONFIG_MISSING",
      configPath,
      "the exact project tsconfig.json snapshot byte is required"
    )
  }
  const projectPathPrefix = `${projectPrefix}/`
  const selected = paths
    .filter((path) => path.startsWith(projectPathPrefix))
    .map((path) => filesByPath.get(path) as SnapshotFile)
  return { ProjectPrefix: projectPrefix, ConfigPath: configPath, Files: selected }
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
  return {
    StagedRoot: stagedRoot,
    CanonicalConfig: join(stagedRoot, ...selected.ConfigPath.split("/"))
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
  projectPrefix: string
): Promise<readonly SourceFile[]> {
  const sourceRoot = join(stagedRoot, ...projectPrefix.split("/"), "src")
  const sourceNames = await project.program.getSourceFileNames()
  const sources: SourceFile[] = []
  const realPaths = new Set<string>()
  let sourceRootReal: string | null = null

  for (const sourceName of sourceNames) {
    const stablePath = StableStagePath(stagedRoot, sourceName, projectPrefix)
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
    if (!IsInside(sourceRoot, sourceName) || sourceName === sourceRoot) {
      throw Admission(
        "PROJECT_SESSION_SOURCE_ESCAPE",
        stablePath,
        "local project source is outside the staged src directory"
      )
    }

    try {
      if (sourceRootReal === null) {
        const rootStatus = await lstat(sourceRoot)
        if (rootStatus.isSymbolicLink() || !rootStatus.isDirectory()) {
          throw Admission(
            "PROJECT_SESSION_SOURCE_ESCAPE",
            stablePath,
            "staged src root identity is invalid"
          )
        }
        sourceRootReal = await realpath(sourceRoot)
        if (sourceRootReal !== sourceRoot) {
          throw Admission(
            "PROJECT_SESSION_SOURCE_ESCAPE",
            stablePath,
            "staged src root realpath differs"
          )
        }
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
    sources.push(sourceFile)
  }

  if (sources.length === 0) {
    throw Admission(
      "PROJECT_SESSION_SOURCE_ZERO",
      `${projectPrefix}/src`,
      "project contains no admitted local package source"
    )
  }
  return sources.sort((left, right) => CompareCodeUnits(left.fileName, right.fileName))
}

async function AdmitProject(
  snapshot: Snapshot,
  staged: StagedProject,
  projectPrefix: string
): Promise<AdmittedProject> {
  const projects = snapshot.getProjects()
  if (projects.length !== 1) {
    throw Admission(
      "PROJECT_SESSION_PROJECT_COUNT",
      `${projectPrefix}/tsconfig.json`,
      "TypeScript worker must return exactly one project"
    )
  }
  const project = projects[0] as Project
  await RequireConfigIdentity(project, staged.CanonicalConfig, projectPrefix)
  const sourceFiles = await AdmitSourceFiles(project, staged.StagedRoot, projectPrefix)
  return { Project: project, SourceFiles: sourceFiles }
}

async function RunProjectSession<T>(
  snapshot: InputSnapshot,
  projectPrefix: string,
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
    const selected = SelectProjectInput(snapshot, projectPrefix)
    const staged = await AcquireStagedProject(selected, operations, acquisition)
    api = new API({ cwd: staged.StagedRoot })
    workerSnapshot = await operations.UpdateSnapshot(api, staged.CanonicalConfig)
    const admitted = await AdmitProject(workerSnapshot, staged, selected.ProjectPrefix)
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
  return RunProjectSession(snapshot, projectPrefix, use, operations)
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
}

interface DiagnosticContext {
  readonly StagedRoot: string
  readonly ProjectRoot: string
  readonly ProjectPrefix: string
  readonly Replacements: readonly DiagnosticReplacement[]
}

function NormalizeDiagnosticSeparators(value: string): string {
  return value.replaceAll("\\", "/")
}

function MapDiagnosticFileName(
  fileName: string | undefined,
  stagedRoot: string,
  projectRoot: string,
  projectPrefix: string
): MappedDiagnosticPath {
  if (fileName === undefined) return { Path: projectPrefix, Escaped: false }
  if (
    !isAbsolute(fileName)
    || (sep === "/" && fileName.includes("\\"))
    || NormalizeDiagnosticSeparators(normalize(fileName)) !== NormalizeDiagnosticSeparators(fileName)
    || !IsInside(projectRoot, fileName)
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
  families: readonly DiagnosticFamily[]
): Promise<DiagnosticContext> {
  const stagedRealRoot = await realpath(stagedRoot)
  const projectRoot = join(stagedRoot, ...projectPrefix.split("/"))
  const replacementsBySource = new Map<string, string>()
  function AddReplacement(source: string, target: string): void {
    const normalizedSource = NormalizeDiagnosticSeparators(source)
    const existing = replacementsBySource.get(normalizedSource)
    if (existing !== undefined && existing !== target) {
      throw new Error("diagnostic path has conflicting stable replacements")
    }
    replacementsBySource.set(normalizedSource, target)
  }
  AddReplacement(stagedRoot, projectPrefix)
  AddReplacement(stagedRealRoot, projectPrefix)
  for (const family of families) {
    for (const diagnostic of family.Diagnostics) {
      VisitDiagnosticGraph(diagnostic, (node) => {
        if (node.fileName === undefined) return
        const mapped = MapDiagnosticFileName(
          node.fileName,
          stagedRoot,
          projectRoot,
          projectPrefix
        )
        AddReplacement(node.fileName, mapped.Path)
      })
    }
  }
  const replacements = [...replacementsBySource].map(([From, To]) => ({ From, To }))
    .sort((left, right) => (
      right.From.length - left.From.length || CompareCodeUnits(left.From, right.From)
    ))
  return { StagedRoot: stagedRoot, ProjectRoot: projectRoot, ProjectPrefix: projectPrefix, Replacements: replacements }
}

function NormalizeDiagnosticText(value: string, context: DiagnosticContext): string {
  let stable = NormalizeDiagnosticSeparators(value).replaceAll("\r\n", "\n").replaceAll("\r", "\n")
  for (const replacement of context.Replacements) {
    stable = stable.replaceAll(replacement.From, replacement.To)
  }
  return stable
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
    context.ProjectRoot,
    context.ProjectPrefix
  )
  const text = NormalizeDiagnosticText(diagnostic.text, context)
  segments.push(related && diagnostic.fileName !== undefined ? `${mapped.Path}: ${text}` : text)
  if (mapped.Escaped) escapeIssues.push(DiagnosticEscapeIssue(context.ProjectPrefix))
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
        context.ProjectRoot,
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
  projectPrefix: string
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
  const context = await CreateDiagnosticContext(session.StagedRoot, projectPrefix, families)
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
      (session) => AnalyzeAdmittedProject(session, projectPrefix),
      operations
    )
  } catch (error) {
    if (error instanceof ProjectSessionAdmissionError) {
      return { SourceFilesChecked: 0, Issues: [error.Issue] }
    }
    throw error
  }
}
