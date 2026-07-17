import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, relative, resolve, win32 } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { Program, type API, type Diagnostic, type Project, type Snapshot as TypeScriptSnapshot } from "typescript/unstable/async"
import type { SourceFile } from "typescript/unstable/ast"
import type { AtomicWriterOperations } from "../gates/atomic-writer.ts"
import { SnapshotInputs, type InputSnapshot, type SnapshotFile } from "../gates/result.ts"

interface ProbeCase {
  readonly scenario: string
  readonly path: string
}

interface ProbeDescriptor {
  readonly scenario: string
  readonly projectPrefix: string
  readonly virtualFiles: readonly { readonly path: string; readonly utf8: string }[]
  readonly actions: {
    readonly stage: { readonly kind: string; readonly path: string; readonly targetPath: string }
    readonly update: { readonly kind: string; readonly path: string }
    readonly callback: { readonly kind: string }
    readonly cleanup: { readonly snapshot: string; readonly api: string; readonly remove: string }
  }
  readonly expected: {
    readonly lifecycle: {
      readonly exitCode: number
      readonly outcome: string
      readonly cleanupOrder: readonly string[]
      readonly errorOrder: readonly string[]
      readonly stageReadback: string
    }
    readonly gate: {
      readonly exitCode: number
      readonly status: string
      readonly checkIds: readonly string[]
    }
  }
}

interface TestProjectSession {
  readonly Project: Project
  readonly SourceFiles: readonly SourceFile[]
  readonly StagedRoot: string
}

interface TestSessionIssue {
  readonly Code: string
  readonly Path: string
  readonly Message: string
}

interface TestProjectSessionOperations {
  readonly RepositoryRoot: string
  readonly UpdateSnapshot: (api: API, canonicalTsconfig: string) => Promise<TypeScriptSnapshot>
  readonly DisposeSnapshot: (snapshot: TypeScriptSnapshot) => Promise<void>
  readonly CloseAPI: (api: API) => Promise<void>
  readonly RemoveStaging: (path: string) => Promise<void>
}

interface TestWorkspaceProjectAuthority {
  readonly ProjectPrefix: string
  readonly DependencyPrefixes: readonly string[]
}

interface ProjectSessionModule extends Readonly<Record<string, unknown>> {
  readonly NodeProjectSessionOperations: (repositoryRoot?: string) => TestProjectSessionOperations
  readonly WithProjectSession: <T>(
    snapshot: InputSnapshot,
    projectPrefix: string,
    use: (session: TestProjectSession) => Promise<T>
  ) => Promise<T>
  readonly WithProjectSessionWithOperations: <T>(
    snapshot: InputSnapshot,
    projectPrefix: string,
    use: (session: TestProjectSession) => Promise<T>,
    operations: TestProjectSessionOperations
  ) => Promise<T>
  readonly AnalyzeProjectSessionWithOperations: (
    snapshot: InputSnapshot,
    projectPrefix: string,
    operations: TestProjectSessionOperations
  ) => Promise<{ readonly SourceFilesChecked: number; readonly Issues: readonly TestSessionIssue[] }>
  readonly AnalyzeProjectSession: (
    snapshot: InputSnapshot,
    projectPrefix: string
  ) => Promise<{ readonly SourceFilesChecked: number; readonly Issues: readonly TestSessionIssue[] }>
  readonly WithWorkspaceProjectSessionWithOperations: <T>(
    snapshot: InputSnapshot,
    authority: TestWorkspaceProjectAuthority,
    use: (session: TestProjectSession) => Promise<T>,
    operations: TestProjectSessionOperations
  ) => Promise<T>
  readonly AnalyzeWorkspaceProjectSessionWithOperations: (
    snapshot: InputSnapshot,
    authority: TestWorkspaceProjectAuthority,
    operations: TestProjectSessionOperations
  ) => Promise<{ readonly SourceFilesChecked: number; readonly Issues: readonly TestSessionIssue[] }>
}

interface ProjectSessionProbeResult {
  readonly schemaVersion: 1
  readonly scenario: string
  readonly outcome: "success" | "primary-error" | "aggregate-error"
  readonly cleanupOrder: readonly string[]
  readonly errorOrder: readonly string[]
  readonly stageReadback: "absent" | "retained-then-harness-removed" | "not-acquired"
}

interface ProjectSessionProbeExecution {
  readonly ExitCode: 0 | 7
  readonly Result: ProjectSessionProbeResult
  readonly Failure: { readonly Thrown: false } | { readonly Thrown: true; readonly Value: unknown }
}

interface ProjectSessionProbeModule extends Readonly<Record<string, unknown>> {
  readonly EvaluateProjectSessionProbe: (
    snapshot: InputSnapshot,
    scenario: string,
    repositoryRoot: string
  ) => Promise<ProjectSessionProbeExecution>
  readonly EvaluateProjectSessionProbeWithReadbackOperations: (
    snapshot: InputSnapshot,
    scenario: string,
    repositoryRoot: string,
    readback: { readonly Lstat: (path: string) => Promise<unknown> }
  ) => Promise<ProjectSessionProbeExecution>
  readonly Main: (
    args: readonly string[],
    io?: { readonly WriteStdout: (value: string) => void; readonly WriteStderr: (value: string) => void }
  ) => Promise<number>
}

interface TestCorpusEvaluation {
  readonly SubjectsExpected: number
  readonly SubjectsChecked: number
  readonly Checks: readonly {
    readonly id: string
    readonly status: string
    readonly path?: string
  }[]
}

interface ProjectSessionFixtureModule extends Readonly<Record<string, unknown>> {
  readonly DiscoverProjectSessionFixtureInputs: (root: string) => Promise<readonly string[]>
  readonly EvaluateProjectSessionFixtureCorpus: (
    snapshot: InputSnapshot,
    repositoryRoot: string
  ) => Promise<TestCorpusEvaluation>
  readonly EvaluateProjectSessionFixtureCorpusWithAnalyzer: (
    snapshot: InputSnapshot,
    repositoryRoot: string,
    analyze: (
      snapshot: InputSnapshot,
      projectPrefix: string,
      operations: TestProjectSessionOperations
    ) => Promise<{ readonly SourceFilesChecked: number; readonly Issues: readonly TestSessionIssue[] }>
  ) => Promise<TestCorpusEvaluation>
  readonly Main: (
    args: readonly string[],
    io?: { readonly WriteStdout: (value: string) => void; readonly WriteStderr: (value: string) => void }
  ) => Promise<number>
  readonly MainWithDependencies: (
    args: readonly string[],
    io: { readonly WriteStdout: (value: string) => void; readonly WriteStderr: (value: string) => void },
    dependencies: {
      readonly DiscoverInputPaths: (root: string) => Promise<readonly string[]>
      readonly Evaluate: (snapshot: InputSnapshot, root: string) => Promise<TestCorpusEvaluation>
      readonly AtomicWriterOperations: AtomicWriterOperations
    }
  ) => Promise<number>
}

const RepositoryRoot = join(import.meta.dir, "../..")
const FixtureRoot = "tools/boundaries/fixtures/project-session"
const FixtureCasesPath = `${FixtureRoot}/cases.json`
const ProbeRoot = "tools/boundaries/probes/project-session"
const ProbeCasesPath = `${ProbeRoot}/cases.json`
const TemporaryRoots: string[] = []
const Decoder = new TextDecoder("utf-8", { fatal: true })
const Encoder = new TextEncoder()

const ExpectedFixtureCases = [
  { id: "valid-project", path: "valid/project", expectedCodes: [] },
  {
    id: "missing-exact-config",
    path: "invalid/missing-exact-config",
    expectedCodes: ["PROJECT_SESSION_CONFIG_MISSING"]
  },
  {
    id: "zero-package-source",
    path: "invalid/zero-package-source",
    expectedCodes: ["PROJECT_SESSION_SOURCE_ZERO"]
  },
  {
    id: "diagnostic-config-file-parsing",
    path: "diagnostic/config-file-parsing",
    expectedCodes: ["TYPESCRIPT_CONFIG_FILE_PARSING_5023"]
  },
  {
    id: "diagnostic-program",
    path: "diagnostic/program",
    expectedCodes: ["TYPESCRIPT_PROGRAM_5069"]
  },
  {
    id: "diagnostic-global",
    path: "diagnostic/global",
    expectedCodes: Array.from({ length: 10 }, () => "TYPESCRIPT_GLOBAL_2318")
  },
  {
    id: "diagnostic-syntactic",
    path: "diagnostic/syntactic",
    expectedCodes: ["TYPESCRIPT_SYNTACTIC_1134", "TYPESCRIPT_SYNTACTIC_1134"]
  },
  {
    id: "diagnostic-bind-and-semantic",
    path: "diagnostic/bind-and-semantic",
    expectedCodes: [
      "TYPESCRIPT_BIND_2528",
      "TYPESCRIPT_BIND_2528",
      "TYPESCRIPT_SEMANTIC_2528",
      "TYPESCRIPT_SEMANTIC_2528"
    ]
  },
  {
    id: "diagnostic-semantic",
    path: "diagnostic/semantic",
    expectedCodes: ["TYPESCRIPT_SEMANTIC_2322"]
  }
] as const

const ExpectedProbeScenarios = [
  "success",
  "primary-error",
  "primary-undefined",
  "materialization-failure",
  "update-before-snapshot",
  "update-after-snapshot",
  "admission-failure",
  "snapshot-cleanup",
  "api-cleanup",
  "remove-before",
  "remove-after",
  "primary-plus-all-cleanups",
  "value-plus-all-cleanups",
  "project-count-zero",
  "project-count-multiple",
  "project-identity",
  "input-invalid-prefix",
  "input-invalid-path",
  "source-realpath-escape",
  "external-source"
] as const

type ProbeScenario = (typeof ExpectedProbeScenarios)[number]
type ProbeActions = ProbeDescriptor["actions"]
type ProbeLifecycle = ProbeDescriptor["expected"]["lifecycle"]
type ProbeGate = ProbeDescriptor["expected"]["gate"]
interface ProbeContract extends Pick<ProbeDescriptor, "actions" | "expected"> {
  readonly projectPrefix: string
  readonly virtualInputsSha256: string
}

const NormalStage = { kind: "normal", path: "", targetPath: "" } as const
const NormalUpdate = { kind: "normal", path: "" } as const
const DelegateCleanup = { snapshot: "delegate", api: "delegate", remove: "delegate" } as const
const FailGate = { exitCode: 1, status: "fail", checkIds: ["GATE_INTERNAL_ERROR"] } as const
const AllCleanupOrder = ["snapshot.dispose", "api.close", "remove-staging"] as const
const PrimaryErrorOrder = ["primary"] as const
const OverlongMaterializationPath = "project/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/value.ts"
const ExpectedProbeInputIdentities: Readonly<Record<ProbeScenario, {
  readonly projectPrefix: string
  readonly virtualInputsSha256: string
}>> = {
  success: { projectPrefix: "project", virtualInputsSha256: "3f36de135d47804c908599299de232eabf5a0aeaa1ce15019e61f9438b3c5349" },
  "primary-error": { projectPrefix: "project", virtualInputsSha256: "277a42f43e5555617e14c2669365c33c115600f07c79401a2ae54ce3b8b289e0" },
  "primary-undefined": { projectPrefix: "project", virtualInputsSha256: "3f36de135d47804c908599299de232eabf5a0aeaa1ce15019e61f9438b3c5349" },
  "materialization-failure": { projectPrefix: "project", virtualInputsSha256: "a56a0154e9671a168c5aeb8b2200cab6ec4f230682fc3b3d008e8579b8d2d6f3" },
  "update-before-snapshot": { projectPrefix: "project", virtualInputsSha256: "277a42f43e5555617e14c2669365c33c115600f07c79401a2ae54ce3b8b289e0" },
  "update-after-snapshot": { projectPrefix: "project", virtualInputsSha256: "277a42f43e5555617e14c2669365c33c115600f07c79401a2ae54ce3b8b289e0" },
  "admission-failure": { projectPrefix: "project", virtualInputsSha256: "311470c0dc3a97655cc28591e9d707abfd7704d6372ea5bac64b7ffc52726ba9" },
  "snapshot-cleanup": { projectPrefix: "project", virtualInputsSha256: "277a42f43e5555617e14c2669365c33c115600f07c79401a2ae54ce3b8b289e0" },
  "api-cleanup": { projectPrefix: "project", virtualInputsSha256: "277a42f43e5555617e14c2669365c33c115600f07c79401a2ae54ce3b8b289e0" },
  "remove-before": { projectPrefix: "project", virtualInputsSha256: "277a42f43e5555617e14c2669365c33c115600f07c79401a2ae54ce3b8b289e0" },
  "remove-after": { projectPrefix: "project", virtualInputsSha256: "277a42f43e5555617e14c2669365c33c115600f07c79401a2ae54ce3b8b289e0" },
  "primary-plus-all-cleanups": { projectPrefix: "project", virtualInputsSha256: "277a42f43e5555617e14c2669365c33c115600f07c79401a2ae54ce3b8b289e0" },
  "value-plus-all-cleanups": { projectPrefix: "project", virtualInputsSha256: "277a42f43e5555617e14c2669365c33c115600f07c79401a2ae54ce3b8b289e0" },
  "project-count-zero": { projectPrefix: "project", virtualInputsSha256: "ac1e9df2bd6a00647403d0bd0b54abaf451fee81ec065427035a4137a9cf031d" },
  "project-count-multiple": { projectPrefix: "project", virtualInputsSha256: "0a6e8ce3a4c751add16781a3141b8576ce0d634845aa81f2648e92f9d6f28c63" },
  "project-identity": { projectPrefix: "project", virtualInputsSha256: "0a6e8ce3a4c751add16781a3141b8576ce0d634845aa81f2648e92f9d6f28c63" },
  "input-invalid-prefix": { projectPrefix: "../project", virtualInputsSha256: "598b9c64d03cb71761e64be7fe938f71728e1b37f9a19d6ada348ee39a032190" },
  "input-invalid-path": { projectPrefix: "project", virtualInputsSha256: "602a1927a1f6b47d59ea08eddfb2bc12aef558e03ef05331c08f801cab7f0527" },
  "source-realpath-escape": { projectPrefix: "project", virtualInputsSha256: "190928c40fbc78865ff06e069ce5f5e1a8ceaafef5a588d65068a8c798a44f02" },
  "external-source": { projectPrefix: "project", virtualInputsSha256: "cc8c501837c6ece9d62e9a555a88eabbf32a3816181e4ee110879f2b90b043d1" }
}

function Actions(
  callback: string = "return-value",
  stage: ProbeActions["stage"] = NormalStage,
  update: ProbeActions["update"] = NormalUpdate,
  cleanup: ProbeActions["cleanup"] = DelegateCleanup
): ProbeActions {
  return { stage, update, callback: { kind: callback }, cleanup }
}

function Lifecycle(
  exitCode: number,
  outcome: string,
  cleanupOrder: readonly string[],
  errorOrder: readonly string[],
  stageReadback: string
): ProbeLifecycle {
  return { exitCode, outcome, cleanupOrder, errorOrder, stageReadback }
}

function Contract(
  scenario: ProbeScenario,
  actions: ProbeActions,
  lifecycle: ProbeLifecycle,
  gate: ProbeGate = FailGate
): ProbeContract {
  return { ...ExpectedProbeInputIdentities[scenario], actions, expected: { lifecycle, gate } }
}

const ExpectedProbeContracts: Readonly<Record<ProbeScenario, ProbeContract>> = {
  success: Contract(
    "success",
    Actions(),
    Lifecycle(0, "success", AllCleanupOrder, [], "absent"),
    { exitCode: 0, status: "pass", checkIds: ["PROJECT_SESSION_PROBE_PASS"] }
  ),
  "primary-error": Contract(
    "primary-error",
    Actions("throw-error"),
    Lifecycle(7, "primary-error", AllCleanupOrder, PrimaryErrorOrder, "absent")
  ),
  "primary-undefined": Contract(
    "primary-undefined",
    Actions("throw-undefined"),
    Lifecycle(7, "primary-error", AllCleanupOrder, PrimaryErrorOrder, "absent")
  ),
  "materialization-failure": Contract(
    "materialization-failure",
    Actions("return-value", {
      kind: "materialization-failure",
      path: OverlongMaterializationPath,
      targetPath: ""
    }),
    Lifecycle(7, "primary-error", ["remove-staging"], PrimaryErrorOrder, "absent")
  ),
  "update-before-snapshot": Contract(
    "update-before-snapshot",
    Actions("return-value", NormalStage, { kind: "throw-before-snapshot", path: "" }),
    Lifecycle(7, "primary-error", ["api.close", "remove-staging"], PrimaryErrorOrder, "absent")
  ),
  "update-after-snapshot": Contract(
    "update-after-snapshot",
    Actions("return-value", NormalStage, { kind: "throw-after-snapshot", path: "" }),
    Lifecycle(7, "primary-error", ["api.close", "remove-staging"], PrimaryErrorOrder, "absent")
  ),
  "admission-failure": Contract(
    "admission-failure",
    Actions(),
    Lifecycle(7, "primary-error", AllCleanupOrder, PrimaryErrorOrder, "absent")
  ),
  "snapshot-cleanup": Contract(
    "snapshot-cleanup",
    Actions("return-value", NormalStage, NormalUpdate, {
      snapshot: "delegate-then-throw",
      api: "delegate",
      remove: "delegate"
    }),
    Lifecycle(7, "aggregate-error", AllCleanupOrder, ["snapshot.dispose"], "absent")
  ),
  "api-cleanup": Contract(
    "api-cleanup",
    Actions("return-value", NormalStage, NormalUpdate, {
      snapshot: "delegate",
      api: "delegate-then-throw",
      remove: "delegate"
    }),
    Lifecycle(7, "aggregate-error", AllCleanupOrder, ["api.close"], "absent")
  ),
  "remove-before": Contract(
    "remove-before",
    Actions("return-value", NormalStage, NormalUpdate, {
      snapshot: "delegate",
      api: "delegate",
      remove: "throw-before-delegate"
    }),
    Lifecycle(7, "aggregate-error", AllCleanupOrder, ["remove-staging"], "retained-then-harness-removed")
  ),
  "remove-after": Contract(
    "remove-after",
    Actions("return-value", NormalStage, NormalUpdate, {
      snapshot: "delegate",
      api: "delegate",
      remove: "delegate-then-throw"
    }),
    Lifecycle(7, "aggregate-error", AllCleanupOrder, ["remove-staging"], "absent")
  ),
  "primary-plus-all-cleanups": Contract(
    "primary-plus-all-cleanups",
    Actions("throw-error", NormalStage, NormalUpdate, {
      snapshot: "delegate-then-throw",
      api: "delegate-then-throw",
      remove: "delegate-then-throw"
    }),
    Lifecycle(7, "aggregate-error", AllCleanupOrder, [
      "primary",
      "snapshot.dispose",
      "api.close",
      "remove-staging"
    ], "absent")
  ),
  "value-plus-all-cleanups": Contract(
    "value-plus-all-cleanups",
    Actions("return-value", NormalStage, NormalUpdate, {
      snapshot: "delegate-then-throw",
      api: "delegate-then-throw",
      remove: "delegate-then-throw"
    }),
    Lifecycle(7, "aggregate-error", AllCleanupOrder, [
      "snapshot.dispose",
      "api.close",
      "remove-staging"
    ], "absent")
  ),
  "project-count-zero": Contract(
    "project-count-zero",
    Actions("return-value", NormalStage, {
      kind: "project-count-zero",
      path: "project/missing/tsconfig.json"
    }),
    Lifecycle(7, "primary-error", AllCleanupOrder, PrimaryErrorOrder, "absent")
  ),
  "project-count-multiple": Contract(
    "project-count-multiple",
    Actions("return-value", NormalStage, {
      kind: "project-count-multiple",
      path: "project/alternate/tsconfig.json"
    }),
    Lifecycle(7, "primary-error", AllCleanupOrder, PrimaryErrorOrder, "absent")
  ),
  "project-identity": Contract(
    "project-identity",
    Actions("return-value", NormalStage, {
      kind: "project-identity",
      path: "project/alternate/tsconfig.json"
    }),
    Lifecycle(7, "primary-error", AllCleanupOrder, PrimaryErrorOrder, "absent")
  ),
  "input-invalid-prefix": Contract(
    "input-invalid-prefix",
    Actions(),
    Lifecycle(7, "primary-error", [], PrimaryErrorOrder, "not-acquired")
  ),
  "input-invalid-path": Contract(
    "input-invalid-path",
    Actions(),
    Lifecycle(7, "primary-error", [], PrimaryErrorOrder, "not-acquired")
  ),
  "source-realpath-escape": Contract(
    "source-realpath-escape",
    Actions("return-value", {
      kind: "source-realpath-escape",
      path: "project/src/index.ts",
      targetPath: "project/escape-target.ts"
    }),
    Lifecycle(7, "primary-error", AllCleanupOrder, PrimaryErrorOrder, "absent")
  ),
  "external-source": Contract(
    "external-source",
    Actions(),
    Lifecycle(7, "primary-error", AllCleanupOrder, PrimaryErrorOrder, "absent")
  )
}

afterEach(async () => {
  await Promise.all(TemporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function Sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

function VirtualInputsSha256(files: ProbeDescriptor["virtualFiles"]): string {
  const inventory = [...files]
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    .map((file) => `${file.path}\0${Sha256(Encoder.encode(file.utf8))}\n`)
    .join("")
  return Sha256(inventory)
}

function File(Path: string, utf8: string): SnapshotFile {
  const Bytes = Encoder.encode(utf8)
  return { Path, RealPath: `/snapshotted/${Path}`, Sha256: Sha256(Bytes), Bytes }
}

function BytesFile(Path: string, Bytes: Uint8Array): SnapshotFile {
  return { Path, RealPath: `/snapshotted/${Path}`, Sha256: Sha256(Bytes), Bytes }
}

function ConcatenateBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

function Snapshot(entries: readonly (readonly [string, string])[]): InputSnapshot {
  const Files = entries.map(([path, utf8]) => File(path, utf8))
  return {
    Sha256: Sha256(Files.map((file) => `${file.Path}\0${file.Sha256}\n`).join("")),
    Files
  }
}

function IsRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function HasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
}

function IsStringArray(value: unknown, allowed?: ReadonlySet<string>): value is readonly string[] {
  return Array.isArray(value)
    && value.every((item) => typeof item === "string" && (allowed === undefined || allowed.has(item)))
}

function ParseJson(file: SnapshotFile): unknown {
  return JSON.parse(Decoder.decode(file.Bytes)) as unknown
}

function ParseProbeCases(file: SnapshotFile): readonly ProbeCase[] {
  const value = ParseJson(file)
  if (
    !IsRecord(value)
    || !HasExactKeys(value, ["schemaVersion", "cases"])
    || value.schemaVersion !== 1
    || !Array.isArray(value.cases)
    || value.cases.length === 0
  ) throw new Error("probe inventory must use the fixed non-empty shape")
  const cases: ProbeCase[] = []
  const scenarios = new Set<string>()
  const paths = new Set<string>()
  for (const item of value.cases) {
    if (
      !IsRecord(item)
      || !HasExactKeys(item, ["scenario", "path"])
      || typeof item.scenario !== "string"
      || !/^[a-z][a-z0-9-]*$/.test(item.scenario)
      || typeof item.path !== "string"
      || item.path !== `${item.scenario}.json`
      || scenarios.has(item.scenario)
      || paths.has(item.path)
    ) throw new Error("probe inventory entry is invalid or duplicated")
    scenarios.add(item.scenario)
    paths.add(item.path)
    cases.push({ scenario: item.scenario, path: item.path })
  }
  const canonicalScenarios = new Set<string>(ExpectedProbeScenarios)
  if (
    scenarios.size !== canonicalScenarios.size
    || [...canonicalScenarios].some((scenario) => !scenarios.has(scenario))
  ) throw new Error("probe inventory must contain the canonical scenario set")
  return cases
}

function ParseProbeDescriptor(file: SnapshotFile): ProbeDescriptor {
  const value = ParseJson(file)
  if (
    !IsRecord(value)
    || !HasExactKeys(value, ["schemaVersion", "scenario", "projectPrefix", "virtualFiles", "actions", "expected"])
    || value.schemaVersion !== 1
    || typeof value.scenario !== "string"
    || !/^[a-z][a-z0-9-]*$/.test(value.scenario)
    || typeof value.projectPrefix !== "string"
    || value.projectPrefix.length === 0
    || !Array.isArray(value.virtualFiles)
    || value.virtualFiles.length === 0
    || !IsRecord(value.actions)
    || !HasExactKeys(value.actions, ["stage", "update", "callback", "cleanup"])
    || !IsRecord(value.expected)
    || !HasExactKeys(value.expected, ["lifecycle", "gate"])
  ) throw new Error("probe descriptor must use the fixed root shape")

  const virtualPaths = new Set<string>()
  for (const virtualFile of value.virtualFiles) {
    if (
      !IsRecord(virtualFile)
      || !HasExactKeys(virtualFile, ["path", "utf8"])
      || typeof virtualFile.path !== "string"
      || virtualFile.path.length === 0
      || typeof virtualFile.utf8 !== "string"
      || Decoder.decode(Encoder.encode(virtualFile.utf8)) !== virtualFile.utf8
      || virtualPaths.has(virtualFile.path)
    ) throw new Error("probe virtual file must use canonical UTF-8 fields")
    virtualPaths.add(virtualFile.path)
  }

  const stage = value.actions.stage
  const update = value.actions.update
  const callback = value.actions.callback
  const cleanup = value.actions.cleanup
  const lifecycle = value.expected.lifecycle
  const gate = value.expected.gate
  if (
    !IsRecord(stage)
    || !HasExactKeys(stage, ["kind", "path", "targetPath"])
    || typeof stage.kind !== "string"
    || !new Set(["normal", "materialization-failure", "source-realpath-escape"]).has(stage.kind)
    || typeof stage.path !== "string"
    || typeof stage.targetPath !== "string"
    || !IsRecord(update)
    || !HasExactKeys(update, ["kind", "path"])
    || typeof update.kind !== "string"
    || !new Set([
      "normal",
      "throw-before-snapshot",
      "throw-after-snapshot",
      "project-count-zero",
      "project-count-multiple",
      "project-identity"
    ]).has(update.kind)
    || typeof update.path !== "string"
    || !IsRecord(callback)
    || !HasExactKeys(callback, ["kind"])
    || typeof callback.kind !== "string"
    || !new Set(["return-value", "throw-error", "throw-undefined"]).has(callback.kind)
    || !IsRecord(cleanup)
    || !HasExactKeys(cleanup, ["snapshot", "api", "remove"])
    || typeof cleanup.snapshot !== "string"
    || !new Set(["delegate", "delegate-then-throw"]).has(cleanup.snapshot)
    || typeof cleanup.api !== "string"
    || !new Set(["delegate", "delegate-then-throw"]).has(cleanup.api)
    || typeof cleanup.remove !== "string"
    || !new Set(["delegate", "delegate-then-throw", "throw-before-delegate"]).has(cleanup.remove)
    || !IsRecord(lifecycle)
    || !HasExactKeys(lifecycle, ["exitCode", "outcome", "cleanupOrder", "errorOrder", "stageReadback"])
    || !Number.isInteger(lifecycle.exitCode)
    || typeof lifecycle.outcome !== "string"
    || !new Set(["success", "primary-error", "aggregate-error"]).has(lifecycle.outcome)
    || !IsStringArray(lifecycle.cleanupOrder, new Set(["snapshot.dispose", "api.close", "remove-staging"]))
    || !IsStringArray(lifecycle.errorOrder, new Set(["primary", "snapshot.dispose", "api.close", "remove-staging"]))
    || typeof lifecycle.stageReadback !== "string"
    || !new Set(["absent", "retained-then-harness-removed", "not-acquired"]).has(lifecycle.stageReadback)
    || !IsRecord(gate)
    || !HasExactKeys(gate, ["exitCode", "status", "checkIds"])
    || !Number.isInteger(gate.exitCode)
    || (gate.status !== "pass" && gate.status !== "fail")
    || !IsStringArray(gate.checkIds)
    || gate.checkIds.length === 0
  ) throw new Error("probe descriptor actions or expectations are invalid")
  return value as unknown as ProbeDescriptor
}

function IsProbeScenario(value: string): value is ProbeScenario {
  return (ExpectedProbeScenarios as readonly string[]).includes(value)
}

function AdmitProbeDescriptor(descriptor: ProbeDescriptor): void {
  if (!IsProbeScenario(descriptor.scenario)) {
    throw new Error("probe descriptor scenario is not canonical")
  }
  const canonical = ExpectedProbeContracts[descriptor.scenario]
  const contract = {
    projectPrefix: descriptor.projectPrefix,
    virtualInputsSha256: VirtualInputsSha256(descriptor.virtualFiles),
    actions: descriptor.actions,
    expected: descriptor.expected
  }
  if (!isDeepStrictEqual(contract, canonical)) {
    throw new Error("probe descriptor input, actions and expected outcome do not match its scenario")
  }

  const virtualPaths = new Set(descriptor.virtualFiles.map((file) => file.path))
  const stage = descriptor.actions.stage
  if (stage.kind === "materialization-failure" && !virtualPaths.has(stage.path)) {
    throw new Error("probe stage path must name a virtual file")
  }
  if (stage.kind === "source-realpath-escape") {
    const sourcePrefix = `${descriptor.projectPrefix}/src/`
    if (
      !virtualPaths.has(stage.path)
      || !virtualPaths.has(stage.targetPath)
      || !stage.path.startsWith(sourcePrefix)
      || !stage.targetPath.startsWith(`${descriptor.projectPrefix}/`)
      || stage.targetPath.startsWith(sourcePrefix)
      || stage.path === stage.targetPath
    ) throw new Error("probe source escape action must be self-contained and leave src")
  }

  const update = descriptor.actions.update
  if (
    (update.kind === "project-count-multiple" || update.kind === "project-identity")
    && !virtualPaths.has(update.path)
  ) throw new Error("probe alternate config must be a virtual file")
}

function SelectProbe(
  snapshot: InputSnapshot,
  scenario: string,
  afterAdmission: () => void
): ProbeDescriptor {
  const files = new Map<string, SnapshotFile>()
  for (const file of snapshot.Files) {
    if (files.has(file.Path)) throw new Error("duplicate probe snapshot path")
    files.set(file.Path, file)
  }
  const casesFile = files.get(ProbeCasesPath)
  if (casesFile === undefined) throw new Error("missing probe cases index")
  const cases = ParseProbeCases(casesFile)
  const selected = cases.filter((item) => item.scenario === scenario)
  if (selected.length !== 1) throw new Error("unknown or duplicated probe scenario")
  const descriptorPath = `${ProbeRoot}/${selected[0]!.path}`
  const descriptorFile = files.get(descriptorPath)
  if (descriptorFile === undefined) throw new Error("missing selected probe descriptor")
  if (snapshot.Files.length !== 2) throw new Error("probe snapshot contains an extra input")
  const descriptor = ParseProbeDescriptor(descriptorFile)
  if (descriptor.scenario !== scenario) throw new Error("probe parameter and descriptor mismatch")
  AdmitProbeDescriptor(descriptor)
  afterAdmission()
  return descriptor
}

async function FilesBelow(root: string): Promise<readonly string[]> {
  const paths: string[] = []
  async function Visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) await Visit(absolute)
      else if (entry.isFile()) paths.push(relative(root, absolute).split("\\").join("/"))
      else throw new Error("inventory entry must be a regular file or directory")
    }
  }
  await Visit(root)
  return paths.sort()
}

async function ReadSnapshotText(path: string): Promise<string> {
  return readFile(join(RepositoryRoot, path), "utf8")
}

async function OrdinaryFixtureSnapshot(casePath: string): Promise<InputSnapshot> {
  const caseRoot = join(RepositoryRoot, FixtureRoot, casePath)
  const files = await Promise.all((await FilesBelow(caseRoot)).map(async (path) => (
    File(path, await readFile(join(caseRoot, path), "utf8"))
  )))
  return SnapshotFiles(files)
}

async function LoadProjectSession(): Promise<ProjectSessionModule> {
  const value: unknown = await import(`./project-${"session"}.ts`)
  if (!IsRecord(value)) throw new Error("project-session module must be an object")
  return value as ProjectSessionModule
}

async function WithInjectedProgramDiagnostics<T>(
  create: () => readonly Diagnostic[],
  use: () => Promise<T>
): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(Program.prototype, "getProgramDiagnostics")
  if (descriptor === undefined || typeof descriptor.value !== "function") {
    throw new Error("missing real TypeScript Program.getProgramDiagnostics")
  }
  const original = descriptor.value as (
    this: Program,
    ...args: readonly unknown[]
  ) => Promise<readonly Diagnostic[]>
  Object.defineProperty(Program.prototype, "getProgramDiagnostics", {
    ...descriptor,
    value: async function(this: Program, ...args: readonly unknown[]): Promise<readonly Diagnostic[]> {
      const actual = await Reflect.apply(original, this, args)
      return [...actual, ...create()]
    }
  })
  try {
    return await use()
  } finally {
    Object.defineProperty(Program.prototype, "getProgramDiagnostics", descriptor)
  }
}

async function LoadProjectSessionProbe(): Promise<ProjectSessionProbeModule> {
  const value: unknown = await import(`./project-session.${"probe"}.cli.ts`)
  if (!IsRecord(value)) throw new Error("project-session probe module must be an object")
  return value as ProjectSessionProbeModule
}

async function LoadProjectSessionFixture(): Promise<ProjectSessionFixtureModule> {
  const value: unknown = await import(`./project-session.${"fixture"}.cli.ts`)
  if (!IsRecord(value)) throw new Error("project-session fixture module must be an object")
  return value as ProjectSessionFixtureModule
}

async function ProbeInputSnapshot(scenario: string): Promise<InputSnapshot> {
  const snapshot = await SnapshotInputs(RepositoryRoot, [
    ProbeCasesPath,
    `${ProbeRoot}/${scenario}.json`
  ])
  if (snapshot.Snapshot === null) throw new Error("committed probe inputs must snapshot")
  expect(snapshot.Checks).toEqual([])
  return snapshot.Snapshot
}

async function CopyProbeInputs(root: string, scenario: string): Promise<void> {
  await Bun.write(join(root, ProbeCasesPath), await ReadSnapshotText(ProbeCasesPath))
  await Bun.write(
    join(root, ProbeRoot, `${scenario}.json`),
    await ReadSnapshotText(`${ProbeRoot}/${scenario}.json`)
  )
}

async function CopyProjectSessionFixtureCorpus(root: string): Promise<void> {
  for (const path of await FilesBelow(join(RepositoryRoot, FixtureRoot))) {
    await Bun.write(
      join(root, FixtureRoot, path),
      new Uint8Array(await readFile(join(RepositoryRoot, FixtureRoot, path)))
    )
  }
}

async function SpawnLifecycleProbe(
  scenario: string,
  root: string
): Promise<{ readonly exitCode: number; readonly signalCode: unknown; readonly stdout: string; readonly stderr: string }> {
  const child = Bun.spawn([
    process.execPath,
    join(RepositoryRoot, "tools/boundaries/project-session.probe.cli.ts"),
    "--mode",
    "lifecycle",
    "--scenario",
    scenario,
    "--root",
    root
  ], {
    cwd: RepositoryRoot,
    stdout: "pipe",
    stderr: "pipe"
  })
  const stdoutPromise = new Response(child.stdout).text()
  const stderrPromise = new Response(child.stderr).text()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<"timeout">((resolveTimeout) => {
    timer = setTimeout(() => { resolveTimeout("timeout") }, 5000)
  })
  const completed = await Promise.race([
    child.exited.then((exitCode) => ({ exitCode })),
    timeout
  ])
  if (completed === "timeout") {
    child.kill("SIGKILL")
    const exitCode = await child.exited
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])
    throw new Error(`probe ${scenario} timed out with ${exitCode}: ${stdout}${stderr}`)
  }
  if (timer !== undefined) clearTimeout(timer)
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])
  return { exitCode: completed.exitCode, signalCode: child.signalCode, stdout, stderr }
}

async function SpawnGateProbe(
  scenario: string,
  root: string,
  runId: string
): Promise<{ readonly exitCode: number; readonly signalCode: unknown; readonly stdout: string; readonly stderr: string }> {
  const child = Bun.spawn([
    process.execPath,
    join(RepositoryRoot, "tools/boundaries/project-session.probe.cli.ts"),
    "--mode",
    "gate",
    "--scenario",
    scenario,
    "--root",
    root,
    "--run-id",
    runId
  ], {
    cwd: RepositoryRoot,
    stdout: "pipe",
    stderr: "pipe"
  })
  const stdoutPromise = new Response(child.stdout).text()
  const stderrPromise = new Response(child.stderr).text()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<"timeout">((resolveTimeout) => {
    timer = setTimeout(() => { resolveTimeout("timeout") }, 5000)
  })
  const completed = await Promise.race([
    child.exited.then((exitCode) => ({ exitCode })),
    timeout
  ])
  if (completed === "timeout") {
    child.kill("SIGKILL")
    const exitCode = await child.exited
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])
    throw new Error(`gate probe ${scenario} timed out with ${exitCode}: ${stdout}${stderr}`)
  }
  if (timer !== undefined) clearTimeout(timer)
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])
  return { exitCode: completed.exitCode, signalCode: child.signalCode, stdout, stderr }
}

async function SpawnWithClosedStdout(
  args: readonly string[]
): Promise<{ readonly exitCode: number; readonly signalCode: unknown; readonly stdout: string; readonly stderr: string }> {
  const child = Bun.spawn([
    "bash",
    "-c",
    "set -o pipefail; \"$@\" | true",
    "likego-closed-stdout",
    process.execPath,
    ...args
  ], {
    cwd: RepositoryRoot,
    stdout: "pipe",
    stderr: "pipe"
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ])
  return { exitCode, signalCode: child.signalCode, stdout, stderr }
}

function SnapshotFiles(Files: readonly SnapshotFile[]): InputSnapshot {
  return {
    Sha256: Sha256(Files.map((file) => `${file.Path}\0${file.Sha256}\n`).join("")),
    Files
  }
}

function ValidProjectSnapshot(extra: readonly SnapshotFile[] = []): InputSnapshot {
  return SnapshotFiles([
    File("project/tsconfig.json", "{\n  \"compilerOptions\": { \"strict\": true, \"noEmit\": true, \"target\": \"ES2022\" },\n  \"include\": [\"src/**/*.ts\"]\n}\n"),
    File("project/src/index.ts", "export const value = 1\n"),
    ...extra
  ])
}

function WorkspaceConfig(
  paths: Readonly<Record<string, readonly string[]>> = {},
  rootShape: Readonly<Record<string, unknown>> = { include: ["src/**/*.ts"] }
): string {
  return `${JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      paths,
      types: []
    },
    ...rootShape
  }, null, 2)}\n`
}

function WorkspacePackage(
  prefix: string,
  name: string,
  source: string,
  config: string = WorkspaceConfig(),
  extra: readonly SnapshotFile[] = []
): readonly SnapshotFile[] {
  return [
    File(`${prefix}/package.json`, `${JSON.stringify({ name })}\n`),
    File(`${prefix}/tsconfig.json`, config),
    File(`${prefix}/src/index.ts`, source),
    ...extra
  ]
}

function ValidWorkspaceSnapshot(
  overrides: {
    readonly ASource?: string
    readonly BSource?: string
    readonly CSource?: string
    readonly AConfig?: string
    readonly Extra?: readonly SnapshotFile[]
  } = {}
): InputSnapshot {
  return SnapshotFiles([
    ...WorkspacePackage(
      "packages/a",
      "@workspace/a",
      overrides.ASource ?? 'import { b } from "@workspace/b"\nexport const a = b\n',
      overrides.AConfig ?? WorkspaceConfig({
        "@workspace/b": ["../b/src/index.ts"],
        "@workspace/c": ["../c/src/index.ts"]
      })
    ),
    ...WorkspacePackage(
      "packages/b",
      "@workspace/b",
      overrides.BSource ?? 'import { c } from "@workspace/c"\nexport const b = c\n'
    ),
    ...WorkspacePackage(
      "packages/c",
      "@workspace/c",
      overrides.CSource ?? "export const c = 1\n"
    ),
    ...WorkspacePackage(
      "packages/d",
      "@workspace/d",
      "export const unrelated = true\n"
    ),
    ...(overrides.Extra ?? [])
  ])
}

const ValidWorkspaceAuthority: TestWorkspaceProjectAuthority = {
  ProjectPrefix: "packages/a",
  DependencyPrefixes: ["packages/b", "packages/c"]
}

async function RepositoryFixture(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  TemporaryRoots.push(root)
  return root
}

function ForbiddenOperations(root: string, calls: string[]): TestProjectSessionOperations {
  return {
    RepositoryRoot: root,
    UpdateSnapshot: async () => {
      calls.push("update")
      throw new Error("UpdateSnapshot must not run")
    },
    DisposeSnapshot: async () => { calls.push("snapshot.dispose") },
    CloseAPI: async () => { calls.push("api.close") },
    RemoveStaging: async () => { calls.push("remove-staging") }
  }
}

function ObservedOperations(
  base: TestProjectSessionOperations,
  calls: string[],
  removedPaths: string[] = []
): TestProjectSessionOperations {
  return {
    RepositoryRoot: base.RepositoryRoot,
    UpdateSnapshot: async (api, config) => {
      calls.push("update")
      return base.UpdateSnapshot(api, config)
    },
    DisposeSnapshot: async (snapshot) => {
      calls.push("snapshot.dispose")
      await base.DisposeSnapshot(snapshot)
    },
    CloseAPI: async (api) => {
      calls.push("api.close")
      await base.CloseAPI(api)
    },
    RemoveStaging: async (path) => {
      calls.push("remove-staging")
      removedPaths.push(path)
      await base.RemoveStaging(path)
    }
  }
}

async function ExpectAdmissionIssue(
  module: ProjectSessionModule,
  snapshot: InputSnapshot,
  projectPrefix: string,
  operations: TestProjectSessionOperations,
  Code: string,
  Path: string
): Promise<void> {
  const result = await module.AnalyzeProjectSessionWithOperations(snapshot, projectPrefix, operations)
  expect(result.SourceFilesChecked).toBe(0)
  expect(result.Issues).toHaveLength(1)
  expect(result.Issues[0]).toEqual({ Code, Path, Message: expect.any(String) })
  expect(result.Issues[0]!.Message.length).toBeGreaterThan(0)
}

async function ExpectEnoent(path: string): Promise<void> {
  await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" })
}

async function ReadProbeDescriptor(scenario: string): Promise<ProbeDescriptor> {
  return JSON.parse(await ReadSnapshotText(`${ProbeRoot}/${scenario}.json`)) as ProbeDescriptor
}

function DescriptorSnapshot(descriptor: ProbeDescriptor): InputSnapshot {
  const files = descriptor.virtualFiles
    .map((file) => File(file.path, file.utf8))
    .sort((left, right) => left.Path < right.Path ? -1 : left.Path > right.Path ? 1 : 0)
  return SnapshotFiles(files)
}

function CleanObservedOperations(
  base: TestProjectSessionOperations,
  cleanupOrder: string[],
  removedPaths: string[] = []
): TestProjectSessionOperations {
  return {
    RepositoryRoot: base.RepositoryRoot,
    UpdateSnapshot: base.UpdateSnapshot,
    DisposeSnapshot: async (snapshot) => {
      cleanupOrder.push("snapshot.dispose")
      await base.DisposeSnapshot(snapshot)
    },
    CloseAPI: async (api) => {
      cleanupOrder.push("api.close")
      await base.CloseAPI(api)
    },
    RemoveStaging: async (path) => {
      cleanupOrder.push("remove-staging")
      removedPaths.push(path)
      await base.RemoveStaging(path)
    }
  }
}

function RealScenarioOperations(
  base: TestProjectSessionOperations,
  descriptor: ProbeDescriptor,
  cleanupOrder: string[],
  removedPaths: string[]
): TestProjectSessionOperations {
  return {
    ...CleanObservedOperations(base, cleanupOrder, removedPaths),
    UpdateSnapshot: async (api, canonicalTsconfig) => {
      const stagedRoot = dirname(dirname(canonicalTsconfig))
      const stageAction = descriptor.actions.stage
      if (stageAction.kind === "source-realpath-escape") {
        const source = join(stagedRoot, stageAction.path)
        const target = join(stagedRoot, stageAction.targetPath)
        await rm(source)
        await symlink(relative(dirname(source), target), source)
      }
      const updateAction = descriptor.actions.update
      if (updateAction.kind === "project-count-zero") {
        return api.updateSnapshot({ openProjects: [join(stagedRoot, updateAction.path)] })
      }
      if (updateAction.kind === "project-count-multiple") {
        return api.updateSnapshot({
          openProjects: [canonicalTsconfig, join(stagedRoot, updateAction.path)]
        })
      }
      if (updateAction.kind === "project-identity") {
        return api.updateSnapshot({ openProjects: [join(stagedRoot, updateAction.path)] })
      }
      return base.UpdateSnapshot(api, canonicalTsconfig)
    }
  }
}

describe("project-session committed ordinary fixture corpus", () => {
  test("locks the nine cases and every exact diagnostic multiset", async () => {
    const document: unknown = JSON.parse(await ReadSnapshotText(FixtureCasesPath))
    expect(document).toEqual({ schemaVersion: 1, cases: ExpectedFixtureCases })

    const payloads = (await FilesBelow(join(RepositoryRoot, FixtureRoot)))
      .filter((path) => path !== "cases.json")
    for (const payload of payloads) {
      expect(ExpectedFixtureCases.filter((item) => (
        payload.startsWith(`${item.path}/`)
      ))).toHaveLength(1)
    }
    for (const fixtureCase of ExpectedFixtureCases) {
      expect(payloads.some((payload) => payload.startsWith(`${fixtureCase.path}/`))).toBe(true)
    }
    expect(payloads).not.toContain("invalid/missing-exact-config/project/tsconfig.json")
    expect(payloads).toContain("invalid/missing-exact-config/project/src/index.ts")
    expect(payloads).toContain("invalid/zero-package-source/project/tsconfig.json")
    expect(payloads).not.toContain("invalid/zero-package-source/project/src/index.ts")
  })

  test("keeps every committed fixture and descriptor path outside Bun discovery", async () => {
    const { FindBunDiscoveredFixturePaths } = await import("../gates/fixture-corpus.ts")
    expect(await FindBunDiscoveredFixturePaths(RepositoryRoot)).toEqual([])
  })

  test("rejects symlinks and other non-regular inventory entries instead of silently skipping them", async () => {
    const root = await mkdtemp(join(tmpdir(), "likego-project-session-nonregular-"))
    TemporaryRoots.push(root)
    await Bun.write(join(root, "regular.json"), "{}\n")
    await symlink("regular.json", join(root, "alias.json"))

    await expect(FilesBelow(root)).rejects.toThrow("inventory entry must be a regular file or directory")
  })
})

describe("Task4 Step3 Phase A diagnostics RED", () => {
  test("analyzes every committed ordinary fixture with its exact diagnostic multiset", async () => {
    const module = await LoadProjectSession()

    for (const fixtureCase of ExpectedFixtureCases) {
      const root = await RepositoryFixture(`likego-project-session-diagnostic-${fixtureCase.id}-`)
      const snapshot = await OrdinaryFixtureSnapshot(fixtureCase.path)
      const result = await module.AnalyzeProjectSessionWithOperations(
        snapshot,
        "project",
        module.NodeProjectSessionOperations(root)
      )

      const expectedSourceCount = fixtureCase.id === "missing-exact-config"
        || fixtureCase.id === "zero-package-source"
        ? 0
        : 1
      expect(result.SourceFilesChecked).toBe(expectedSourceCount)
      expect(result.Issues.map((issue) => issue.Code)).toEqual(
        [...fixtureCase.expectedCodes].sort()
      )

      if (fixtureCase.id === "missing-exact-config") {
        await ExpectEnoent(join(root, ".artifacts"))
      } else {
        expect(await readdir(join(root, ".artifacts/gates/work"))).toEqual([])
      }
    }
  })

  test("awaits all six real TypeScript diagnostic families in exact serial order", async () => {
    const module = await LoadProjectSession()
    const root = await RepositoryFixture("likego-project-session-diagnostic-order-")
    const snapshot = await OrdinaryFixtureSnapshot("diagnostic/config-file-parsing")
    const methodNames = [
      "getConfigFileParsingDiagnostics",
      "getProgramDiagnostics",
      "getGlobalDiagnostics",
      "getSyntacticDiagnostics",
      "getBindDiagnostics",
      "getSemanticDiagnostics"
    ] as const
    const order: string[] = []
    const originals = new Map<string, PropertyDescriptor>()

    try {
      for (const name of methodNames) {
        const descriptor = Object.getOwnPropertyDescriptor(Program.prototype, name)
        if (descriptor === undefined || typeof descriptor.value !== "function") {
          throw new Error(`missing real TypeScript Program.${name}`)
        }
        originals.set(name, descriptor)
        const original = descriptor.value as (...args: unknown[]) => Promise<readonly unknown[]>
        Object.defineProperty(Program.prototype, name, {
          ...descriptor,
          value: async function(this: Program, ...args: unknown[]): Promise<readonly unknown[]> {
            order.push(`${name}:start`)
            const diagnostics = await Reflect.apply(original, this, args)
            order.push(`${name}:end`)
            return diagnostics
          }
        })
      }

      await module.AnalyzeProjectSessionWithOperations(
        snapshot,
        "project",
        module.NodeProjectSessionOperations(root)
      )
    } finally {
      for (const name of methodNames) {
        const descriptor = originals.get(name)
        if (descriptor !== undefined) Object.defineProperty(Program.prototype, name, descriptor)
      }
    }

    expect(order).toEqual(methodNames.flatMap((name) => [`${name}:start`, `${name}:end`]))
    expect(await readdir(join(root, ".artifacts/gates/work"))).toEqual([])
  })
})

describe("Task4 Step3 Phase B diagnostic graph and redaction RED", () => {
  test("flattens real nested message chains and related information in depth-first API order", async () => {
    const module = await LoadProjectSession()
    const root = await RepositoryFixture("likego-project-session-diagnostic-graph-")
    const snapshot = SnapshotFiles([
      File("project/tsconfig.json", "{\n  \"compilerOptions\": { \"strict\": true, \"noEmit\": true, \"lib\": [\"es5\"] },\n  \"files\": [\"src/index.ts\"]\n}\n"),
      File("project/src/index.ts", [
        "export interface Source { nested: { value: number } }",
        "export interface Target { nested: { value: string } }",
        "declare const source: Source",
        "export const target: Target = source",
        "interface Merge { prop: string }",
        "interface Merge { prop: number }"
      ].join("\n"))
    ])

    const result = await module.AnalyzeProjectSessionWithOperations(
      snapshot,
      "project",
      module.NodeProjectSessionOperations(root)
    )

    expect(result).toEqual({
      SourceFilesChecked: 1,
      Issues: [
        {
          Code: "TYPESCRIPT_SEMANTIC_2322",
          Path: "project/src/index.ts",
          Message: [
            "Type 'Source' is not assignable to type 'Target'.",
            "The types of 'nested.value' are incompatible between these types.",
            "Type 'number' is not assignable to type 'string'."
          ].join("\n")
        },
        {
          Code: "TYPESCRIPT_SEMANTIC_2717",
          Path: "project/src/index.ts",
          Message: [
            "Subsequent property declarations must have the same type.  Property 'prop' must be of type 'string', but here has type 'number'.",
            "project/src/index.ts: 'prop' was also declared here."
          ].join("\n")
        }
      ]
    })
    expect(await readdir(join(root, ".artifacts/gates/work"))).toEqual([])
  })

  test("redacts every real default-library root and related path and preserves duplicate escapes", async () => {
    const module = await LoadProjectSession()
    const root = await RepositoryFixture("likego-project-session-diagnostic-escape-")
    const snapshot = SnapshotFiles([
      File("project/tsconfig.json", "{\n  \"compilerOptions\": { \"strict\": true, \"noEmit\": true, \"lib\": [\"es5\"] },\n  \"files\": [\"src/index.ts\"]\n}\n"),
      File("project/src/index.ts", "export {}\ndeclare global { type Array<T> = T }\n")
    ])

    const result = await module.AnalyzeProjectSessionWithOperations(
      snapshot,
      "project",
      module.NodeProjectSessionOperations(root)
    )
    const escapeIssue = {
      Code: "PROJECT_SESSION_DIAGNOSTIC_PATH_ESCAPE",
      Path: "project",
      Message: "TypeScript diagnostic file path is outside the staged project"
    }

    expect(result).toEqual({
      SourceFilesChecked: 1,
      Issues: [
        escapeIssue,
        escapeIssue,
        escapeIssue,
        escapeIssue,
        {
          Code: "TYPESCRIPT_SEMANTIC_2300",
          Path: "project",
          Message: "Duplicate identifier 'Array'.\nproject/src/index.ts: 'Array' was also declared here."
        },
        {
          Code: "TYPESCRIPT_SEMANTIC_2300",
          Path: "project",
          Message: "Duplicate identifier 'Array'.\nproject/src/index.ts: 'Array' was also declared here."
        },
        {
          Code: "TYPESCRIPT_SEMANTIC_2300",
          Path: "project/src/index.ts",
          Message: "Duplicate identifier 'Array'.\nproject: 'Array' was also declared here.\nproject: and here."
        }
      ]
    })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(root)
    expect(serialized).not.toContain(RepositoryRoot)
    expect(serialized).not.toContain("node_modules")
    expect(serialized).not.toMatch(/lib\.es5\.d\.ts/)
    expect(await readdir(join(root, ".artifacts/gates/work"))).toEqual([])
  })

  test("normalizes a real diagnostic message containing the random staged root", async () => {
    const module = await LoadProjectSession()
    const root = await RepositoryFixture("likego-project-session-diagnostic-root-text-")
    const base = module.NodeProjectSessionOperations(root)
    let stagedRoot = ""
    const operations: TestProjectSessionOperations = {
      ...base,
      UpdateSnapshot: async (api, canonicalTsconfig) => {
        stagedRoot = dirname(dirname(canonicalTsconfig))
        await Bun.write(
          join(stagedRoot, "project/src/index.ts"),
          `export const value: ${JSON.stringify(stagedRoot)} = "different"\n`
        )
        return base.UpdateSnapshot(api, canonicalTsconfig)
      }
    }

    const result = await module.AnalyzeProjectSessionWithOperations(
      ValidProjectSnapshot(),
      "project",
      operations
    )

    expect(result).toEqual({
      SourceFilesChecked: 1,
      Issues: [{
        Code: "PROJECT_SESSION_DIAGNOSTIC_PATH_ESCAPE",
        Path: "project",
        Message: "TypeScript diagnostic file path is outside the staged project"
      }, {
        Code: "TYPESCRIPT_SEMANTIC_2322",
        Path: "project/src/index.ts",
        Message: "Type '\"different\"' is not assignable to type '\"project\"'."
      }]
    })
    expect(JSON.stringify(result)).not.toContain(stagedRoot)
    expect(await readdir(join(root, ".artifacts/gates/work"))).toEqual([])
  })

  test("delegates the default analyzer to the current working directory operations", async () => {
    const module = await LoadProjectSession()
    const root = await RepositoryFixture("likego-project-session-default-analyze-")
    const previousCwd = process.cwd()
    try {
      process.chdir(root)
      expect(await module.AnalyzeProjectSession(ValidProjectSnapshot(), "project")).toEqual({
        SourceFilesChecked: 1,
        Issues: []
      })
    } finally {
      process.chdir(previousCwd)
    }
    expect(await readdir(join(root, ".artifacts/gates/work"))).toEqual([])
  })
})

describe("Task4 Step3 Phase C diagnostic path portability RED", () => {
  test("accepts TS7 slash-normalized Windows paths without weakening POSIX backslash rejection", async () => {
    const typescriptPathSource = await readFile(
      join(RepositoryRoot, "node_modules/typescript/dist/api/path.js"),
      "utf8"
    )
    expect(typescriptPathSource).toContain("path.replace(backslashRegExp, directorySeparator)")

    const typescriptWindowsPath = "C:/stage/project/src/index.ts"
    expect(win32.isAbsolute(typescriptWindowsPath)).toBe(true)
    expect(win32.normalize(typescriptWindowsPath)).not.toBe(typescriptWindowsPath)
    expect(win32.normalize(typescriptWindowsPath).replaceAll("\\", "/")).toBe(typescriptWindowsPath)

    const productionSource = await ReadSnapshotText("tools/boundaries/project-session.ts")
    expect(productionSource).not.toContain("normalize(fileName) !== fileName")
    expect(productionSource).toContain(
      "NormalizeDiagnosticSeparators(normalize(fileName)) !== NormalizeDiagnosticSeparators(fileName)"
    )
    expect(productionSource).toContain('sep === "/" && fileName.includes("\\\\")')
  })
})

describe("Task4 Step4 Phase A real lifecycle matrix", () => {
  test("preserves exact primary identity at every real TypeScript acquisition cut-point", async () => {
    const module = await LoadProjectSession()

    const callbackRoot = await RepositoryFixture("likego-project-session-primary-callback-")
    const callbackOrder: string[] = []
    const callbackPrimary = new Error("callback primary")
    const callbackBase = module.NodeProjectSessionOperations(callbackRoot)
    let callbackCaught: unknown
    try {
      await module.WithProjectSessionWithOperations(
        ValidProjectSnapshot(),
        "project",
        async () => { throw callbackPrimary },
        CleanObservedOperations(callbackBase, callbackOrder)
      )
    } catch (error) {
      callbackCaught = error
    }
    expect(callbackCaught).toBe(callbackPrimary)
    expect(callbackOrder).toEqual(["snapshot.dispose", "api.close", "remove-staging"])
    expect(await readdir(join(callbackRoot, ".artifacts/gates/work"))).toEqual([])

    const undefinedRoot = await RepositoryFixture("likego-project-session-primary-undefined-")
    const undefinedOrder: string[] = []
    const undefinedBase = module.NodeProjectSessionOperations(undefinedRoot)
    let undefinedThrown = false
    let undefinedCaught: unknown = "not thrown"
    try {
      await module.WithProjectSessionWithOperations(
        ValidProjectSnapshot(),
        "project",
        async () => { throw undefined },
        CleanObservedOperations(undefinedBase, undefinedOrder)
      )
    } catch (error) {
      undefinedThrown = true
      undefinedCaught = error
    }
    expect(undefinedThrown).toBe(true)
    expect(undefinedCaught).toBeUndefined()
    expect(undefinedOrder).toEqual(["snapshot.dispose", "api.close", "remove-staging"])
    expect(await readdir(join(undefinedRoot, ".artifacts/gates/work"))).toEqual([])

    const updateRoot = await RepositoryFixture("likego-project-session-primary-update-after-")
    const updateOrder: string[] = []
    const updatePrimary = new Error("update after real snapshot")
    const updateBase = module.NodeProjectSessionOperations(updateRoot)
    const updateOperations: TestProjectSessionOperations = {
      ...CleanObservedOperations(updateBase, updateOrder),
      UpdateSnapshot: async (api, canonicalTsconfig) => {
        await updateBase.UpdateSnapshot(api, canonicalTsconfig)
        throw updatePrimary
      }
    }
    let updateCaught: unknown
    try {
      await module.WithProjectSessionWithOperations(
        ValidProjectSnapshot(),
        "project",
        async () => "unreachable",
        updateOperations
      )
    } catch (error) {
      updateCaught = error
    }
    expect(updateCaught).toBe(updatePrimary)
    expect(updateOrder).toEqual(["api.close", "remove-staging"])
    expect(await readdir(join(updateRoot, ".artifacts/gates/work"))).toEqual([])
  })

  test("settles every real cleanup delegate independently in production order", async () => {
    const module = await LoadProjectSession()
    const cases = [
      { id: "snapshot", primary: "value", snapshot: true, api: false, remove: false },
      { id: "api", primary: "value", snapshot: false, api: true, remove: false },
      { id: "primary-all", primary: "error", snapshot: true, api: true, remove: true },
      { id: "value-all", primary: "value", snapshot: true, api: true, remove: true },
      { id: "undefined-snapshot", primary: "undefined", snapshot: true, api: false, remove: false },
      { id: "nested-primary", primary: "aggregate", snapshot: true, api: false, remove: false }
    ] as const

    for (const item of cases) {
      const root = await RepositoryFixture(`likego-project-session-cleanup-${item.id}-`)
      const base = module.NodeProjectSessionOperations(root)
      const order: string[] = []
      const callbackPrimary = new Error(`${item.id} primary`)
      const nestedPrimary = new AggregateError([callbackPrimary], `${item.id} nested primary`)
      const snapshotFault = new Error(`${item.id} snapshot cleanup`)
      const apiFault = new Error(`${item.id} api cleanup`)
      const removeFault = new Error(`${item.id} remove cleanup`)
      const operations: TestProjectSessionOperations = {
        RepositoryRoot: base.RepositoryRoot,
        UpdateSnapshot: base.UpdateSnapshot,
        DisposeSnapshot: async (snapshot) => {
          order.push("snapshot.dispose")
          await base.DisposeSnapshot(snapshot)
          if (item.snapshot) throw snapshotFault
        },
        CloseAPI: async (api) => {
          order.push("api.close")
          await base.CloseAPI(api)
          if (item.api) throw apiFault
        },
        RemoveStaging: async (path) => {
          order.push("remove-staging")
          await base.RemoveStaging(path)
          if (item.remove) throw removeFault
        }
      }
      let caught: unknown
      try {
        await module.WithProjectSessionWithOperations(
          ValidProjectSnapshot(),
          "project",
          async () => {
            if (item.primary === "error") throw callbackPrimary
            if (item.primary === "undefined") throw undefined
            if (item.primary === "aggregate") throw nestedPrimary
            return "callback value"
          },
          operations
        )
      } catch (error) {
        caught = error
      }

      expect(caught).toBeInstanceOf(AggregateError)
      const expectedErrors: unknown[] = []
      if (item.primary === "error") expectedErrors.push(callbackPrimary)
      if (item.primary === "undefined") expectedErrors.push(undefined)
      if (item.primary === "aggregate") expectedErrors.push(nestedPrimary)
      if (item.snapshot) expectedErrors.push(snapshotFault)
      if (item.api) expectedErrors.push(apiFault)
      if (item.remove) expectedErrors.push(removeFault)
      expect((caught as AggregateError).errors).toEqual(expectedErrors)
      expect((caught as AggregateError).message).toBe("project session cleanup failed")
      if (item.primary === "aggregate") {
        expect((caught as AggregateError).errors[0]).toBe(nestedPrimary)
        expect(nestedPrimary.errors).toEqual([callbackPrimary])
      }
      expect(order).toEqual(["snapshot.dispose", "api.close", "remove-staging"])
      expect(await readdir(join(root, ".artifacts/gates/work"))).toEqual([])
    }
  })

  test("preserves every setup primary ahead of all applicable real cleanup faults", async () => {
    const module = await LoadProjectSession()

    const materializationRoot = await RepositoryFixture("likego-project-session-setup-materialization-")
    const materializationDescriptor = await ReadProbeDescriptor("materialization-failure")
    const materializationBase = module.NodeProjectSessionOperations(materializationRoot)
    const materializationOrder: string[] = []
    const materializationRemoveFault = new Error("materialization remove cleanup")
    let materializationCallback = false
    let materializationCaught: unknown
    try {
      await module.WithProjectSessionWithOperations(
        DescriptorSnapshot(materializationDescriptor),
        materializationDescriptor.projectPrefix,
        async () => { materializationCallback = true },
        {
          ...materializationBase,
          RemoveStaging: async (path) => {
            materializationOrder.push("remove-staging")
            await materializationBase.RemoveStaging(path)
            throw materializationRemoveFault
          }
        }
      )
    } catch (error) {
      materializationCaught = error
    }
    expect(materializationCallback).toBe(false)
    expect(materializationCaught).toBeInstanceOf(AggregateError)
    const materializationErrors = (materializationCaught as AggregateError).errors
    expect(materializationErrors).toHaveLength(2)
    expect(IsRecord(materializationErrors[0]) && materializationErrors[0].code).toBe("ENAMETOOLONG")
    expect(materializationErrors[1]).toBe(materializationRemoveFault)
    expect(materializationOrder).toEqual(["remove-staging"])
    expect(await readdir(join(materializationRoot, ".artifacts/gates/work"))).toEqual([])

    for (const phase of ["before-snapshot", "after-snapshot"] as const) {
      const root = await RepositoryFixture(`likego-project-session-setup-update-${phase}-`)
      const base = module.NodeProjectSessionOperations(root)
      const order: string[] = []
      const primary = new Error(`${phase} primary`)
      const apiFault = new Error(`${phase} api cleanup`)
      const removeFault = new Error(`${phase} remove cleanup`)
      let callbackCalled = false
      const operations: TestProjectSessionOperations = {
        RepositoryRoot: base.RepositoryRoot,
        UpdateSnapshot: async (api, canonicalTsconfig) => {
          if (phase === "before-snapshot") await api.parseConfigFile(canonicalTsconfig)
          else await base.UpdateSnapshot(api, canonicalTsconfig)
          throw primary
        },
        DisposeSnapshot: async () => { throw new Error("unreturned snapshot must not be disposed") },
        CloseAPI: async (api) => {
          order.push("api.close")
          await base.CloseAPI(api)
          throw apiFault
        },
        RemoveStaging: async (path) => {
          order.push("remove-staging")
          await base.RemoveStaging(path)
          throw removeFault
        }
      }
      let caught: unknown
      try {
        await module.WithProjectSessionWithOperations(
          ValidProjectSnapshot(),
          "project",
          async () => { callbackCalled = true },
          operations
        )
      } catch (error) {
        caught = error
      }
      expect(callbackCalled).toBe(false)
      expect(caught).toBeInstanceOf(AggregateError)
      expect((caught as AggregateError).errors).toEqual([primary, apiFault, removeFault])
      expect(order).toEqual(["api.close", "remove-staging"])
      expect(await readdir(join(root, ".artifacts/gates/work"))).toEqual([])
    }

    const admissionRoot = await RepositoryFixture("likego-project-session-setup-admission-")
    const admissionDescriptor = await ReadProbeDescriptor("admission-failure")
    const admissionBase = module.NodeProjectSessionOperations(admissionRoot)
    const admissionOrder: string[] = []
    const snapshotFault = new Error("admission snapshot cleanup")
    const apiFault = new Error("admission api cleanup")
    const removeFault = new Error("admission remove cleanup")
    let admissionCallback = false
    let admissionCaught: unknown
    try {
      await module.WithProjectSessionWithOperations(
        DescriptorSnapshot(admissionDescriptor),
        admissionDescriptor.projectPrefix,
        async () => { admissionCallback = true },
        {
          RepositoryRoot: admissionBase.RepositoryRoot,
          UpdateSnapshot: admissionBase.UpdateSnapshot,
          DisposeSnapshot: async (snapshot) => {
            admissionOrder.push("snapshot.dispose")
            await admissionBase.DisposeSnapshot(snapshot)
            throw snapshotFault
          },
          CloseAPI: async (api) => {
            admissionOrder.push("api.close")
            await admissionBase.CloseAPI(api)
            throw apiFault
          },
          RemoveStaging: async (path) => {
            admissionOrder.push("remove-staging")
            await admissionBase.RemoveStaging(path)
            throw removeFault
          }
        }
      )
    } catch (error) {
      admissionCaught = error
    }
    expect(admissionCallback).toBe(false)
    expect(admissionCaught).toBeInstanceOf(AggregateError)
    const admissionErrors = (admissionCaught as AggregateError).errors
    expect(admissionErrors).toHaveLength(4)
    expect(IsRecord(admissionErrors[0]) && IsRecord(admissionErrors[0].Issue)
      ? admissionErrors[0].Issue.Code
      : null).toBe("PROJECT_SESSION_SOURCE_ZERO")
    expect(admissionErrors.slice(1)).toEqual([snapshotFault, apiFault, removeFault])
    expect(admissionOrder).toEqual(["snapshot.dispose", "api.close", "remove-staging"])
    expect(await readdir(join(admissionRoot, ".artifacts/gates/work"))).toEqual([])
  })
})

describe("Task4 Step4 Phase B descriptor evaluator RED", () => {
  test("derives every lifecycle outcome from admitted descriptor snapshot bytes and real delegates", async () => {
    const probe = await LoadProjectSessionProbe()

    for (const scenario of ExpectedProbeScenarios) {
      const root = await RepositoryFixture(`likego-project-session-probe-${scenario}-`)
      const descriptor = await ReadProbeDescriptor(scenario)
      const execution = await probe.EvaluateProjectSessionProbe(
        await ProbeInputSnapshot(scenario),
        scenario,
        root
      )
      const expected = descriptor.expected.lifecycle

      expect(execution.ExitCode as number).toBe(expected.exitCode)
      expect(execution.Result as unknown).toEqual({
        schemaVersion: 1,
        scenario,
        outcome: expected.outcome,
        cleanupOrder: expected.cleanupOrder,
        errorOrder: expected.errorOrder,
        stageReadback: expected.stageReadback
      })
      expect(execution.Failure.Thrown).toBe(expected.exitCode === 7)
      if (expected.outcome === "aggregate-error") {
        if (!execution.Failure.Thrown) throw new Error("aggregate probe outcome must carry a failure")
        expect(execution.Failure.Value).toBeInstanceOf(AggregateError)
        expect((execution.Failure.Value as AggregateError).errors).toHaveLength(expected.errorOrder.length)
      }
      if (scenario === "primary-undefined") {
        expect(execution.Failure).toEqual({ Thrown: true, Value: undefined })
      }
      const work = join(root, ".artifacts/gates/work")
      try {
        expect(await readdir(work)).toEqual([])
      } catch (error) {
        expect(IsRecord(error) && error.code).toBe("ENOENT")
      }
    }
  })

  test("never rereads a descriptor after snapshot and rejects canonical drift before staging", async () => {
    const probe = await LoadProjectSessionProbe()
    const root = await RepositoryFixture("likego-project-session-probe-snapshot-")
    const casesPath = join(root, ProbeCasesPath)
    const descriptorPath = join(root, ProbeRoot, "success.json")
    await Bun.write(casesPath, await ReadSnapshotText(ProbeCasesPath))
    await Bun.write(descriptorPath, await ReadSnapshotText(`${ProbeRoot}/success.json`))
    const snapshot = await SnapshotInputs(root, [ProbeCasesPath, `${ProbeRoot}/success.json`])
    if (snapshot.Snapshot === null) throw new Error("copied probe inputs must snapshot")
    await Bun.write(descriptorPath, "{\"mutatedAfterSnapshot\":true}\n")

    const execution = await probe.EvaluateProjectSessionProbe(snapshot.Snapshot, "success", root)
    expect(execution.Result).toEqual({
      schemaVersion: 1,
      scenario: "success",
      outcome: "success",
      cleanupOrder: ["snapshot.dispose", "api.close", "remove-staging"],
      errorOrder: [],
      stageReadback: "absent"
    })

    const descriptor = await ReadProbeDescriptor("success")
    const drifted = structuredClone(descriptor) as {
      actions: { callback: { kind: string } }
    } & ProbeDescriptor
    drifted.actions.callback.kind = "throw-error"
    const driftedSnapshot = SnapshotFiles([
      File(ProbeCasesPath, await ReadSnapshotText(ProbeCasesPath)),
      File(`${ProbeRoot}/success.json`, `${JSON.stringify(drifted)}\n`)
    ])
    const invalidRoot = await RepositoryFixture("likego-project-session-probe-invalid-")
    await expect(
      probe.EvaluateProjectSessionProbe(driftedSnapshot, "success", invalidRoot)
    ).rejects.toThrow("probe descriptor input, actions and expected outcome do not match its scenario")
    await ExpectEnoent(join(invalidRoot, ".artifacts"))
  })

  test("rejects corrupt snapshots and unsafe descriptor references before canonical contract comparison", async () => {
    const probe = await LoadProjectSessionProbe()
    const canonical = await ProbeInputSnapshot("success")
    const corruptFile = {
      ...canonical.Files[0]!,
      Sha256: "0".repeat(64)
    }
    const corrupt = { ...canonical, Files: [corruptFile, ...canonical.Files.slice(1)] }
    const corruptRoot = await RepositoryFixture("likego-project-session-probe-corrupt-")
    await expect(
      probe.EvaluateProjectSessionProbe(corrupt, "success", corruptRoot)
    ).rejects.toThrow("probe snapshot file integrity is invalid")
    await expect(
      probe.EvaluateProjectSessionProbe(canonical, "unknown", corruptRoot)
    ).rejects.toThrow("unknown or duplicated probe scenario")
    await ExpectEnoent(join(corruptRoot, ".artifacts"))

    const casesText = await ReadSnapshotText(ProbeCasesPath)
    const variants = [
      {
        scenario: "materialization-failure",
        mutate: (descriptor: ProbeDescriptor): ProbeDescriptor => ({
          ...descriptor,
          actions: {
            ...descriptor.actions,
            stage: { ...descriptor.actions.stage, path: "project/missing.ts" }
          }
        }),
        message: "probe stage path must name a virtual file"
      },
      {
        scenario: "project-count-multiple",
        mutate: (descriptor: ProbeDescriptor): ProbeDescriptor => ({
          ...descriptor,
          actions: {
            ...descriptor.actions,
            update: { ...descriptor.actions.update, path: "project/missing/tsconfig.json" }
          }
        }),
        message: "probe alternate config must be a virtual file"
      },
      {
        scenario: "source-realpath-escape",
        mutate: (descriptor: ProbeDescriptor): ProbeDescriptor => ({
          ...descriptor,
          actions: {
            ...descriptor.actions,
            stage: { ...descriptor.actions.stage, targetPath: "project/missing-target.ts" }
          }
        }),
        message: "probe source escape action must be self-contained and leave src"
      }
    ] as const

    for (const variant of variants) {
      const descriptor = variant.mutate(await ReadProbeDescriptor(variant.scenario))
      const snapshot = SnapshotFiles([
        File(ProbeCasesPath, casesText),
        File(`${ProbeRoot}/${variant.scenario}.json`, `${JSON.stringify(descriptor)}\n`)
      ])
      const root = await RepositoryFixture(`likego-project-session-probe-reference-${variant.scenario}-`)
      await expect(
        probe.EvaluateProjectSessionProbe(snapshot, variant.scenario, root)
      ).rejects.toThrow(variant.message)
      await ExpectEnoent(join(root, ".artifacts"))
    }
  })

  test("fails closed on readback errors and impossible partial cleanup states after real workers close", async () => {
    const probe = await LoadProjectSessionProbe()
    const accessError = Object.assign(new Error("readback denied"), { code: "EACCES" })
    const accessRoot = await RepositoryFixture("likego-project-session-probe-readback-error-")
    let accessCaught: unknown
    try {
      await probe.EvaluateProjectSessionProbeWithReadbackOperations(
        await ProbeInputSnapshot("success"),
        "success",
        accessRoot,
        { Lstat: async () => { throw accessError } }
      )
    } catch (error) {
      accessCaught = error
    }
    expect(accessCaught).toBe(accessError)
    expect(await readdir(join(accessRoot, ".artifacts/gates/work"))).toEqual([])

    const missing = (): Error & { readonly code: string } => (
      Object.assign(new Error("missing"), { code: "ENOENT" })
    )
    let partialCalls = 0
    const partialRoot = await RepositoryFixture("likego-project-session-probe-readback-partial-")
    let partialCaught: unknown
    try {
      await probe.EvaluateProjectSessionProbeWithReadbackOperations(
        await ProbeInputSnapshot("success"),
        "success",
        partialRoot,
        {
          Lstat: async () => {
            partialCalls += 1
            if (partialCalls === 1) return {}
            throw missing()
          }
        }
      )
    } catch (error) {
      partialCaught = error
    }
    expect(partialCaught).toBeInstanceOf(Error)
    expect((partialCaught as Error).message).toBe("project session probe stage readback is partial or unexpected")
    expect(partialCalls).toBe(2)
    expect(await readdir(join(partialRoot, ".artifacts/gates/work"))).toEqual([])

    let retainedCalls = 0
    const retainedRoot = await RepositoryFixture("likego-project-session-probe-readback-retained-")
    let retainedCaught: unknown
    try {
      await probe.EvaluateProjectSessionProbeWithReadbackOperations(
        await ProbeInputSnapshot("remove-before"),
        "remove-before",
        retainedRoot,
        {
          Lstat: async () => {
            retainedCalls += 1
            return {}
          }
        }
      )
    } catch (error) {
      retainedCaught = error
    }
    expect(retainedCaught).toBeInstanceOf(Error)
    expect((retainedCaught as Error).message).toBe("project session probe harness cleanup readback failed")
    expect(retainedCalls).toBe(3)
    expect(await readdir(join(retainedRoot, ".artifacts/gates/work"))).toEqual([])
  }, 30_000)
})

describe("Task4 Step4 Phase C lifecycle CLI and natural-exit subprocess RED", () => {
  test("emits only the frozen lifecycle line with exact zero or seven exit semantics", async () => {
    const probe = await LoadProjectSessionProbe()
    for (const scenario of ["success", "primary-undefined", "remove-before"] as const) {
      const root = await RepositoryFixture(`likego-project-session-probe-main-${scenario}-`)
      await CopyProbeInputs(root, scenario)
      const stdout: string[] = []
      const stderr: string[] = []
      const exitCode = await probe.Main([
        "--mode",
        "lifecycle",
        "--scenario",
        scenario,
        "--root",
        root
      ], {
        WriteStdout: (value) => { stdout.push(value) },
        WriteStderr: (value) => { stderr.push(value) }
      })
      const descriptor = await ReadProbeDescriptor(scenario)
      const expected = descriptor.expected.lifecycle
      expect(exitCode).toBe(expected.exitCode)
      expect(stderr).toEqual([])
      expect(stdout).toHaveLength(1)
      expect(stdout[0]!.endsWith("\n")).toBe(true)
      expect(stdout[0]!.split("\n")).toHaveLength(2)
      const prefix = "LIKEGO_PROJECT_SESSION_PROBE="
      expect(stdout[0]!.startsWith(prefix)).toBe(true)
      expect(JSON.parse(stdout[0]!.slice(prefix.length))).toEqual({
        schemaVersion: 1,
        scenario,
        outcome: expected.outcome,
        cleanupOrder: expected.cleanupOrder,
        errorOrder: expected.errorOrder,
        stageReadback: expected.stageReadback
      })
      await ExpectEnoent(join(root, ".artifacts/gates/boundary-project-session-probe.json"))
    }
  })

  test("runs all twenty real TS7 lifecycle probes to natural exit before the hard deadline", async () => {
    for (const scenario of ExpectedProbeScenarios) {
      const root = await RepositoryFixture(`likego-project-session-probe-child-${scenario}-`)
      await CopyProbeInputs(root, scenario)
      const descriptor = await ReadProbeDescriptor(scenario)
      const expected = descriptor.expected.lifecycle
      const child = await SpawnLifecycleProbe(scenario, root)

      expect(child.signalCode).toBeNull()
      expect(child.exitCode).toBe(expected.exitCode)
      expect(child.stderr).toBe("")
      const lines = child.stdout.split("\n")
      expect(lines).toHaveLength(2)
      expect(lines[1]).toBe("")
      const prefix = "LIKEGO_PROJECT_SESSION_PROBE="
      expect(lines[0]!.startsWith(prefix)).toBe(true)
      expect(JSON.parse(lines[0]!.slice(prefix.length))).toEqual({
        schemaVersion: 1,
        scenario,
        outcome: expected.outcome,
        cleanupOrder: expected.cleanupOrder,
        errorOrder: expected.errorOrder,
        stageReadback: expected.stageReadback
      })
      const work = join(root, ".artifacts/gates/work")
      try {
        expect(await readdir(work)).toEqual([])
      } catch (error) {
        expect(IsRecord(error) && error.code).toBe("ENOENT")
      }
      await ExpectEnoent(join(root, ".artifacts/gates/boundary-project-session-probe.json"))
    }
  }, 120_000)

  test("reports usage, input, execution and non-coercible output failures without a result line", async () => {
    const probe = await LoadProjectSessionProbe()
    const invoke = async (
      args: readonly string[],
      writeStdout: (value: string) => void = (value) => { throw new Error(`unexpected stdout ${value}`) }
    ): Promise<{ readonly exitCode: number; readonly stdout: readonly string[]; readonly stderr: readonly string[] }> => {
      const stdout: string[] = []
      const stderr: string[] = []
      const exitCode = await probe.Main(args, {
        WriteStdout: (value) => {
          stdout.push(value)
          writeStdout(value)
        },
        WriteStderr: (value) => { stderr.push(value) }
      })
      return { exitCode, stdout, stderr }
    }

    const usage = await invoke([])
    expect(usage).toEqual({
      exitCode: 1,
      stdout: [],
      stderr: ["PROJECT_SESSION_PROBE_USAGE invalid arguments\n"]
    })

    const missingRoot = await RepositoryFixture("likego-project-session-probe-main-missing-")
    const input = await invoke([
      "--mode", "lifecycle", "--scenario", "success", "--root", missingRoot
    ])
    expect(input).toEqual({
      exitCode: 1,
      stdout: [],
      stderr: ["PROJECT_SESSION_PROBE_INPUT_ERROR required inputs could not be snapshotted\n"]
    })

    const driftRoot = await RepositoryFixture("likego-project-session-probe-main-drift-")
    await CopyProbeInputs(driftRoot, "success")
    const drifted = structuredClone(await ReadProbeDescriptor("success")) as {
      actions: { callback: { kind: string } }
    } & ProbeDescriptor
    drifted.actions.callback.kind = "throw-error"
    await Bun.write(join(driftRoot, ProbeRoot, "success.json"), `${JSON.stringify(drifted)}\n`)
    const execution = await invoke([
      "--mode", "lifecycle", "--scenario", "success", "--root", driftRoot
    ])
    expect(execution).toEqual({
      exitCode: 1,
      stdout: [],
      stderr: [
        "PROJECT_SESSION_PROBE_EXECUTION_ERROR probe descriptor input, actions and expected outcome do not match its scenario\n"
      ]
    })
    await ExpectEnoent(join(driftRoot, ".artifacts"))

    const outputRoot = await RepositoryFixture("likego-project-session-probe-main-output-")
    await CopyProbeInputs(outputRoot, "success")
    const numericMessage = new Error("numeric")
    Object.defineProperty(numericMessage, "message", { value: 17 })
    const nonCoercible = Object.create(null) as { [Symbol.toPrimitive]?: () => never }
    nonCoercible[Symbol.toPrimitive] = () => { throw new Error("cannot stringify") }
    const outputFailures = [
      { thrown: new Error("stdout failed"), message: "stdout failed" },
      { thrown: "literal failure", message: "literal failure" },
      { thrown: numericMessage, message: "unprintable error" },
      { thrown: nonCoercible, message: "unprintable error" }
    ] as const
    for (const failure of outputFailures) {
      const stdout: string[] = []
      const stderr: string[] = []
      const exitCode = await probe.Main([
        "--mode", "lifecycle", "--scenario", "success", "--root", outputRoot
      ], {
        WriteStdout: () => { throw failure.thrown },
        WriteStderr: (value) => { stderr.push(value) }
      })
      expect(exitCode).toBe(1)
      expect(stdout).toEqual([])
      expect(stderr).toEqual([`PROJECT_SESSION_PROBE_OUTPUT_ERROR ${failure.message}\n`])
    }
  })

  test("routes the executable default IO through process stdout and stderr", async () => {
    const probe = await LoadProjectSessionProbe()
    const stdout: string[] = []
    const stderr: string[] = []
    const originalStdoutWrite = process.stdout.write
    const originalStderrWrite = process.stderr.write
    process.stdout.write = ((value: string | Uint8Array, callback?: (error?: Error | null) => void) => {
      stdout.push(String(value))
      callback?.()
      return true
    }) as typeof process.stdout.write
    process.stderr.write = ((value: string | Uint8Array, callback?: (error?: Error | null) => void) => {
      stderr.push(String(value))
      callback?.()
      return true
    }) as typeof process.stderr.write
    try {
      expect(await probe.Main([])).toBe(1)
      const root = await RepositoryFixture("likego-project-session-probe-default-io-")
      await CopyProbeInputs(root, "success")
      expect(await probe.Main([
        "--mode", "lifecycle", "--scenario", "success", "--root", root
      ])).toBe(0)
    } finally {
      process.stdout.write = originalStdoutWrite
      process.stderr.write = originalStderrWrite
    }

    expect(stderr).toEqual(["PROJECT_SESSION_PROBE_USAGE invalid arguments\n"])
    expect(stdout).toHaveLength(1)
    expect(stdout[0]!.startsWith("LIKEGO_PROJECT_SESSION_PROBE=")).toBe(true)
  })
})

describe("Task4 Step4 Phase D runtime-probe gate RED", () => {
  test("persists only the current-run canonical gate result after real lifecycle cleanup", async () => {
    const probe = await LoadProjectSessionProbe()
    const inputsSha256 = new Set<string>()
    for (const scenario of ["success", "primary-undefined", "primary-plus-all-cleanups"] as const) {
      const root = await RepositoryFixture(`likego-project-session-probe-gate-${scenario}-`)
      await CopyProbeInputs(root, scenario)
      const stdout: string[] = []
      const stderr: string[] = []
      const runId = `task4-gate-${scenario}`
      const exitCode = await probe.Main([
        "--mode",
        "gate",
        "--scenario",
        scenario,
        "--root",
        root,
        "--run-id",
        runId
      ], {
        WriteStdout: (value) => { stdout.push(value) },
        WriteStderr: (value) => { stderr.push(value) }
      })
      const descriptor = await ReadProbeDescriptor(scenario)
      const expected = descriptor.expected.gate

      expect(exitCode).toBe(expected.exitCode)
      expect(stderr).toEqual([])
      expect(stdout).toHaveLength(1)
      expect(stdout[0]!.startsWith("LIKEGO_GATE_RESULT=")).toBe(true)
      expect(stdout[0]).not.toContain("LIKEGO_PROJECT_SESSION_PROBE=")
      const result = JSON.parse(stdout[0]!.slice("LIKEGO_GATE_RESULT=".length)) as {
        runId: string
        gate: string
        mode: string
        status: string
        releaseReadiness: string
        inputsSha256: string
        subjects: { expected: number; checked: number }
        checks: readonly { id: string; status: string }[]
      }
      expect(result.runId).toBe(runId)
      expect(result.gate).toBe("boundary-project-session-probe")
      expect(result.mode).toBe("runtime-probe")
      expect(result.status).toBe(expected.status)
      expect(result.releaseReadiness).toBe("not-evaluated")
      expect(result.subjects).toEqual({ expected: 1, checked: scenario === "success" ? 1 : 0 })
      expect(result.checks.map((check) => check.id)).toEqual([...expected.checkIds])
      inputsSha256.add(result.inputsSha256)
      const canonical = JSON.parse(await readFile(
        join(root, ".artifacts/gates/boundary-project-session-probe.json"),
        "utf8"
      ))
      expect(canonical).toEqual(result)
      expect(await readdir(join(root, ".artifacts/gates/work"))).toEqual([])
    }
    expect(inputsSha256.size).toBe(3)
  })

  test("runs all twenty real TS7 gate probes to natural exit with exact persisted evidence", async () => {
    const inputsSha256 = new Set<string>()
    for (const scenario of ExpectedProbeScenarios) {
      const root = await RepositoryFixture(`likego-project-session-probe-gate-child-${scenario}-`)
      await CopyProbeInputs(root, scenario)
      const descriptor = await ReadProbeDescriptor(scenario)
      const expected = descriptor.expected.gate
      const runId = `task4-gate-child-${scenario}`
      const child = await SpawnGateProbe(scenario, root, runId)

      expect(child.signalCode).toBeNull()
      expect(child.exitCode).toBe(expected.exitCode)
      expect(child.stderr).toBe("")
      const lines = child.stdout.split("\n")
      expect(lines).toHaveLength(2)
      expect(lines[1]).toBe("")
      expect(lines[0]!.startsWith("LIKEGO_GATE_RESULT=")).toBe(true)
      expect(lines[0]).not.toContain("LIKEGO_PROJECT_SESSION_PROBE=")
      const result = JSON.parse(lines[0]!.slice("LIKEGO_GATE_RESULT=".length)) as {
        runId: string
        gate: string
        mode: string
        status: string
        releaseReadiness: string
        inputsSha256: string
        subjects: { expected: number; checked: number }
        checks: readonly { id: string; status: string }[]
      }
      expect(result.runId).toBe(runId)
      expect(result.gate).toBe("boundary-project-session-probe")
      expect(result.mode).toBe("runtime-probe")
      expect(result.status).toBe(expected.status)
      expect(result.releaseReadiness).toBe("not-evaluated")
      expect(result.subjects).toEqual({ expected: 1, checked: scenario === "success" ? 1 : 0 })
      expect(result.checks.map((check) => check.id)).toEqual([...expected.checkIds])
      inputsSha256.add(result.inputsSha256)
      expect(JSON.parse(await readFile(
        join(root, ".artifacts/gates/boundary-project-session-probe.json"),
        "utf8"
      ))).toEqual(result)
      try {
        expect(await readdir(join(root, ".artifacts/gates/work"))).toEqual([])
      } catch (error) {
        expect(IsRecord(error) && error.code).toBe("ENOENT")
      }
    }
    expect(inputsSha256.size).toBe(ExpectedProbeScenarios.length)
  }, 120_000)

  test("reports a gate emission failure without falsely claiming a result line", async () => {
    const probe = await LoadProjectSessionProbe()
    const root = await RepositoryFixture("likego-project-session-probe-gate-output-")
    await CopyProbeInputs(root, "success")
    const canonicalPath = join(root, ".artifacts/gates/boundary-project-session-probe.json")
    await mkdir(dirname(canonicalPath), { recursive: true })
    await Bun.write(canonicalPath, "prior-result\n")
    const stderr: string[] = []
    const exitCode = await probe.Main([
      "--mode", "gate",
      "--scenario", "success",
      "--root", root,
      "--run-id", "task4-gate-output-failure"
    ], {
      WriteStdout: () => { throw new Error("gate stdout failed") },
      WriteStderr: (value) => { stderr.push(value) }
    })

    expect(exitCode).toBe(1)
    expect(stderr).toEqual(["PROJECT_SESSION_PROBE_EMIT_ERROR gate stdout failed\n"])
    expect(await readFile(canonicalPath, "utf8")).toBe("prior-result\n")
    expect((await readdir(join(root, ".artifacts/gates"))).filter((path) => path.includes(".tmp-"))).toEqual([])
  })

  test("restores the probe prior after a real closed stdout pipe", async () => {
    const root = await RepositoryFixture("likego-project-session-probe-gate-epipe-")
    await CopyProbeInputs(root, "success")
    const canonicalPath = join(root, ".artifacts/gates/boundary-project-session-probe.json")
    await mkdir(dirname(canonicalPath), { recursive: true })
    await Bun.write(canonicalPath, "prior-result\n")
    const child = await SpawnWithClosedStdout([
      join(RepositoryRoot, "tools/boundaries/project-session.probe.cli.ts"),
      "--mode", "gate",
      "--scenario", "success",
      "--root", root,
      "--run-id", "task4-probe-real-epipe"
    ])

    expect(child.signalCode).toBeNull()
    expect(child.exitCode).toBe(1)
    expect(child.stdout).toBe("")
    expect(child.stderr).toContain("PROJECT_SESSION_PROBE_EMIT_ERROR")
    expect(child.stderr).toContain("EPIPE")
    expect(await readFile(canonicalPath, "utf8")).toBe("prior-result\n")
    expect((await readdir(dirname(canonicalPath))).filter((name) => (
      name.endsWith(".tmp") || name.endsWith(".lock")
    ))).toEqual([])
  })
})

describe("Task4 Step5 async project-session fixture gate RED", () => {
  test("builds each case snapshot only from admitted bytes before real TS7 analysis", async () => {
    const fixture = await LoadProjectSessionFixture()
    const projectSession = await LoadProjectSession()
    const root = await RepositoryFixture("likego-project-session-fixture-snapshot-")
    const casePath = "valid/snapshot-only"
    const casesText = `${JSON.stringify({
      schemaVersion: 1,
      cases: [{ id: "snapshot-only", path: casePath, expectedCodes: [] }]
    })}\n`
    const configText = "{\n  \"compilerOptions\": { \"strict\": true, \"noEmit\": true, \"target\": \"ES2022\" },\n  \"include\": [\"src/**/*.ts\"]\n}\n"
    const sourceText = "export const snapshotted: number = 1\n"
    const inputPaths = [
      `${FixtureRoot}/cases.json`,
      `${FixtureRoot}/${casePath}/project/tsconfig.json`,
      `${FixtureRoot}/${casePath}/project/src/index.ts`
    ]
    await Bun.write(join(root, inputPaths[0]!), casesText)
    await Bun.write(join(root, inputPaths[1]!), configText)
    await Bun.write(join(root, inputPaths[2]!), sourceText)
    const snapshotted = await SnapshotInputs(root, inputPaths)
    if (snapshotted.Snapshot === null) throw new Error("single fixture inputs must snapshot")
    await Bun.write(join(root, inputPaths[2]!), "const changedAfterSnapshot: string = 1\n")

    let observed: InputSnapshot | null = null
    const evaluation = await fixture.EvaluateProjectSessionFixtureCorpusWithAnalyzer(
      snapshotted.Snapshot,
      root,
      async (snapshot, projectPrefix, operations) => {
        observed = snapshot
        expect(projectPrefix).toBe("project")
        expect(operations.RepositoryRoot).toBe(await realpath(root))
        return projectSession.AnalyzeProjectSessionWithOperations(snapshot, projectPrefix, operations)
      }
    )

    expect(evaluation).toEqual({
      SubjectsExpected: 1,
      SubjectsChecked: 1,
      Checks: [expect.objectContaining({
        id: "FIXTURE_CASE_MATCH",
        status: "pass",
        path: casePath
      })]
    })
    const caseSnapshot = observed as InputSnapshot | null
    if (caseSnapshot === null) throw new Error("analyzer must receive a case-local snapshot")
    expect(caseSnapshot.Files.map((file) => file.Path)).toEqual([
      "project/src/index.ts",
      "project/tsconfig.json"
    ])
    expect(new TextDecoder().decode(caseSnapshot.Files[0]!.Bytes)).toBe(sourceText)
    expect(caseSnapshot.Sha256).toBe(Sha256(
      caseSnapshot.Files.map((file) => `${file.Path}\0${file.Sha256}\n`).join("")
    ))
    expect(await readdir(join(root, ".artifacts/gates/work"))).toEqual([])
  })

  test("replaces a stale domain failure with one real nine-of-nine current-run PASS", async () => {
    const fixture = await LoadProjectSessionFixture()
    const root = await RepositoryFixture("likego-project-session-fixture-current-")
    await CopyProjectSessionFixtureCorpus(root)
    const ignoredProbe = "tools/boundaries/probes/project-session/ignored-by-fixture-gate.json"
    await Bun.write(join(root, ignoredProbe), "{\"ignored\":true}\n")
    const extra = `${FixtureRoot}/unlisted/extra.ts`
    await Bun.write(join(root, extra), "export const extra = true\n")

    const failedStdout: string[] = []
    const failedStderr: string[] = []
    expect(await fixture.Main([
      "--root", root,
      "--run-id", "task4-fixture-domain-failure"
    ], {
      WriteStdout: (value) => { failedStdout.push(value) },
      WriteStderr: (value) => { failedStderr.push(value) }
    })).toBe(1)
    expect(failedStderr).toEqual([])
    expect(failedStdout).toHaveLength(1)
    const failed = JSON.parse(failedStdout[0]!.slice("LIKEGO_GATE_RESULT=".length)) as {
      readonly runId: string
      readonly status: string
      readonly inputsSha256: string
      readonly subjects: { readonly expected: number; readonly checked: number }
      readonly checks: readonly { readonly id: string }[]
    }
    expect(failed.runId).toBe("task4-fixture-domain-failure")
    expect(failed.status).toBe("fail")
    expect(failed.subjects).toEqual({ expected: 9, checked: 0 })
    expect(failed.checks.map((check) => check.id)).toEqual([
      "FIXTURE_INVENTORY_MISMATCH",
      "GATE_SUBJECTS_ZERO",
      "GATE_NO_PASS_CHECK",
      "GATE_SUBJECT_COUNT_MISMATCH"
    ])

    await rm(join(root, extra))
    const discovered = await fixture.DiscoverProjectSessionFixtureInputs(root)
    expect(discovered).not.toContain(ignoredProbe)
    const expectedSnapshot = await SnapshotInputs(root, discovered)
    if (expectedSnapshot.Snapshot === null) throw new Error("ordinary fixture inventory must snapshot")
    const passedStdout: string[] = []
    const passedStderr: string[] = []
    expect(await fixture.Main([
      "--root", root,
      "--run-id", "task4-fixture-current-pass"
    ], {
      WriteStdout: (value) => { passedStdout.push(value) },
      WriteStderr: (value) => { passedStderr.push(value) }
    })).toBe(0)
    expect(passedStderr).toEqual([])
    expect(passedStdout).toHaveLength(1)
    const passed = JSON.parse(passedStdout[0]!.slice("LIKEGO_GATE_RESULT=".length)) as {
      readonly schemaVersion: number
      readonly runId: string
      readonly gate: string
      readonly mode: string
      readonly status: string
      readonly releaseReadiness: string
      readonly inputsSha256: string
      readonly subjects: { readonly expected: number; readonly checked: number }
      readonly checks: readonly { readonly id: string; readonly status: string; readonly path: string }[]
    }
    expect(passed.schemaVersion).toBe(1)
    expect(passed.runId).toBe("task4-fixture-current-pass")
    expect(passed.gate).toBe("boundary-project-session-fixtures")
    expect(passed.mode).toBe("fixture")
    expect(passed.status).toBe("pass")
    expect(passed.releaseReadiness).toBe("not-evaluated")
    expect(passed.inputsSha256).toBe(expectedSnapshot.Snapshot.Sha256)
    expect(passed.inputsSha256).not.toBe(failed.inputsSha256)
    expect(passed.subjects).toEqual({ expected: 9, checked: 9 })
    expect(passed.checks).toHaveLength(9)
    expect(passed.checks.map((check) => [check.id, check.status, check.path])).toEqual(
      ExpectedFixtureCases.map((item) => ["FIXTURE_CASE_MATCH", "pass", item.path])
    )
    expect(JSON.parse(await readFile(
      join(root, ".artifacts/gates/boundary-project-session-fixtures.json"),
      "utf8"
    ))).toEqual(passed)
    expect(await readdir(join(root, ".artifacts/gates/work"))).toEqual([])
  }, 30_000)

  test("persists current-run input, discovery and evaluator failures", async () => {
    const fixture = await LoadProjectSessionFixture()
    const { NodeAtomicWriterOperations } = await import("../gates/result.ts")

    const inputRoot = await RepositoryFixture("likego-project-session-fixture-input-")
    await CopyProjectSessionFixtureCorpus(inputRoot)
    await rm(join(inputRoot, FixtureCasesPath))
    const inputStdout: string[] = []
    expect(await fixture.Main([
      "--run-id", "task4-fixture-input",
      "--root", inputRoot
    ], {
      WriteStdout: (value) => { inputStdout.push(value) },
      WriteStderr: () => { throw new Error("input failure must not use stderr") }
    })).toBe(1)
    const input = JSON.parse(inputStdout[0]!.slice("LIKEGO_GATE_RESULT=".length)) as {
      readonly runId: string
      readonly inputsSha256: null
      readonly subjects: { readonly checked: number }
      readonly checks: readonly { readonly id: string }[]
    }
    expect(input.runId).toBe("task4-fixture-input")
    expect(input.inputsSha256).toBeNull()
    expect(input.subjects.checked).toBe(0)
    expect(input.checks.map((check) => check.id)).toEqual(["GATE_INPUT_ERROR"])

    const discoveryRoot = await RepositoryFixture("likego-project-session-fixture-discovery-")
    const outside = await RepositoryFixture("likego-project-session-fixture-discovery-outside-")
    await mkdir(dirname(join(discoveryRoot, FixtureRoot)), { recursive: true })
    await symlink(outside, join(discoveryRoot, FixtureRoot))
    const discoveryStdout: string[] = []
    expect(await fixture.Main([
      "--root", discoveryRoot,
      "--run-id", "task4-fixture-discovery"
    ], {
      WriteStdout: (value) => { discoveryStdout.push(value) },
      WriteStderr: () => { throw new Error("discovery failure must not use stderr") }
    })).toBe(1)
    const discovery = JSON.parse(discoveryStdout[0]!.slice("LIKEGO_GATE_RESULT=".length)) as {
      readonly runId: string
      readonly inputsSha256: null
      readonly checks: readonly { readonly id: string }[]
    }
    expect(discovery.runId).toBe("task4-fixture-discovery")
    expect(discovery.inputsSha256).toBeNull()
    expect(discovery.checks.map((check) => check.id)).toEqual(["GATE_INPUT_ERROR"])

    const nonRegularRoot = await RepositoryFixture("likego-project-session-fixture-nonregular-")
    await Bun.write(join(nonRegularRoot, FixtureCasesPath), "{\"schemaVersion\":1,\"cases\":[]}\n")
    await symlink("missing-target", join(nonRegularRoot, FixtureRoot, "linked-payload.ts"))
    await expect(fixture.DiscoverProjectSessionFixtureInputs(nonRegularRoot))
      .rejects.toThrow("project-session fixture inventory entries must be regular files or directories")

    const evaluatorRoot = await RepositoryFixture("likego-project-session-fixture-evaluator-")
    await CopyProjectSessionFixtureCorpus(evaluatorRoot)
    const evaluatorStdout: string[] = []
    expect(await fixture.MainWithDependencies([
      "--root", evaluatorRoot,
      "--run-id", "task4-fixture-evaluator"
    ], {
      WriteStdout: (value) => { evaluatorStdout.push(value) },
      WriteStderr: () => { throw new Error("evaluator failure must not use stderr") }
    }, {
      DiscoverInputPaths: fixture.DiscoverProjectSessionFixtureInputs,
      Evaluate: async () => { throw new Error("injected fixture evaluator failure") },
      AtomicWriterOperations: NodeAtomicWriterOperations()
    })).toBe(1)
    const evaluator = JSON.parse(evaluatorStdout[0]!.slice("LIKEGO_GATE_RESULT=".length)) as {
      readonly runId: string
      readonly inputsSha256: string
      readonly subjects: { readonly checked: number }
      readonly checks: readonly { readonly id: string }[]
    }
    expect(evaluator.runId).toBe("task4-fixture-evaluator")
    expect(evaluator.inputsSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(evaluator.subjects.checked).toBe(0)
    expect(evaluator.checks.map((check) => check.id)).toEqual(["GATE_INTERNAL_ERROR"])
  })

  test("rejects every malformed CLI invocation without changing prior evidence", async () => {
    const fixture = await LoadProjectSessionFixture()
    const root = await RepositoryFixture("likego-project-session-fixture-usage-")
    const canonicalPath = join(root, ".artifacts/gates/boundary-project-session-fixtures.json")
    await mkdir(dirname(canonicalPath), { recursive: true })
    await Bun.write(canonicalPath, "prior-result\n")
    const invalid = [
      [],
      ["--root"],
      ["--run-id"],
      ["--root", root],
      ["--run-id", "valid-run"],
      ["--root", "", "--run-id", "valid-run"],
      ["--root", root, "--run-id", ""],
      ["--root", root, "--root", root, "--run-id", "valid-run"],
      ["--root", root, "--run-id", "valid-run", "--run-id", "valid-run"],
      ["--unknown", "value", "--root", root, "--run-id", "valid-run"],
      ["--root", root, "--run-id", "Uppercase"],
      ["--root", root, "--run-id", "invalid.dot"],
      ["--root", root, "--run-id", `a${"b".repeat(96)}`]
    ] as const

    for (const args of invalid) {
      const stdout: string[] = []
      const stderr: string[] = []
      expect(await fixture.Main(args, {
        WriteStdout: (value) => { stdout.push(value) },
        WriteStderr: (value) => { stderr.push(value) }
      })).toBe(1)
      expect(stdout).toEqual([])
      expect(stderr).toEqual(["PROJECT_SESSION_FIXTURE_USAGE invalid arguments\n"])
      expect(await readFile(canonicalPath, "utf8")).toBe("prior-result\n")
      expect((await readdir(dirname(canonicalPath))).filter((name) => name.endsWith(".tmp"))).toEqual([])
    }
  })

  test("rolls back atomic and hostile stdout failures with safe stderr", async () => {
    const fixture = await LoadProjectSessionFixture()
    const { NodeAtomicWriterOperations } = await import("../gates/result.ts")
    const root = await RepositoryFixture("likego-project-session-fixture-output-")
    await CopyProjectSessionFixtureCorpus(root)
    await Bun.write(join(root, FixtureRoot, "unlisted/extra.ts"), "export const extra = true\n")
    const canonicalPath = join(root, ".artifacts/gates/boundary-project-session-fixtures.json")
    await mkdir(dirname(canonicalPath), { recursive: true })
    await Bun.write(canonicalPath, "prior-result\n")
    const base = NodeAtomicWriterOperations()

    const emissionStdout: string[] = []
    const emissionStderr: string[] = []
    expect(await fixture.MainWithDependencies([
      "--root", root,
      "--run-id", "task4-fixture-emission"
    ], {
      WriteStdout: (value) => { emissionStdout.push(value) },
      WriteStderr: (value) => { emissionStderr.push(value) }
    }, {
      DiscoverInputPaths: fixture.DiscoverProjectSessionFixtureInputs,
      Evaluate: fixture.EvaluateProjectSessionFixtureCorpus,
      AtomicWriterOperations: {
        ...base,
        Open: async () => { throw new Error("injected fixture emission failure") }
      }
    })).toBe(1)
    expect(emissionStdout).toEqual([])
    expect(emissionStderr).toEqual([
      "PROJECT_SESSION_FIXTURE_EMIT_ERROR injected fixture emission failure\n"
    ])
    expect(await readFile(canonicalPath, "utf8")).toBe("prior-result\n")

    const failures: Array<{ readonly thrown: unknown; readonly message: string }> = [
      { thrown: "literal output failure", message: "literal output failure" },
      {
        thrown: Object.assign(Object.create(null) as object, {
          [Symbol.toPrimitive]: () => { throw new Error("cannot stringify output") }
        }),
        message: "unprintable error"
      }
    ]
    for (const failure of failures) {
      const stderr: string[] = []
      expect(await fixture.Main([
        "--root", root,
        "--run-id", `task4-fixture-output-${failure.message === "unprintable error" ? "hostile" : "literal"}`
      ], {
        WriteStdout: () => { throw failure.thrown },
        WriteStderr: (value) => { stderr.push(value) }
      })).toBe(1)
      expect(stderr).toEqual([`PROJECT_SESSION_FIXTURE_EMIT_ERROR ${failure.message}\n`])
      expect(await readFile(canonicalPath, "utf8")).toBe("prior-result\n")
      expect((await readdir(dirname(canonicalPath))).filter((name) => name.endsWith(".tmp"))).toEqual([])
    }
  })

  test("restores the fixture prior after a real closed stdout pipe", async () => {
    const root = await RepositoryFixture("likego-project-session-fixture-epipe-")
    await CopyProjectSessionFixtureCorpus(root)
    const canonicalPath = join(root, ".artifacts/gates/boundary-project-session-fixtures.json")
    await mkdir(dirname(canonicalPath), { recursive: true })
    await Bun.write(canonicalPath, "prior-result\n")
    const child = await SpawnWithClosedStdout([
      join(RepositoryRoot, "tools/boundaries/project-session.fixture.cli.ts"),
      "--root", root,
      "--run-id", "task4-fixture-real-epipe"
    ])

    expect(child.signalCode).toBeNull()
    expect(child.exitCode).toBe(1)
    expect(child.stdout).toBe("")
    expect(child.stderr).toContain("PROJECT_SESSION_FIXTURE_EMIT_ERROR")
    expect(child.stderr).toContain("EPIPE")
    expect(await readFile(canonicalPath, "utf8")).toBe("prior-result\n")
    expect((await readdir(dirname(canonicalPath))).filter((name) => (
      name.endsWith(".tmp") || name.endsWith(".lock")
    ))).toEqual([])
  })

  test("routes executable default IO without bypassing the same gate", async () => {
    const fixture = await LoadProjectSessionFixture()
    const root = await RepositoryFixture("likego-project-session-fixture-default-io-")
    const stdout: string[] = []
    const stderr: string[] = []
    const originalStdoutWrite = process.stdout.write
    const originalStderrWrite = process.stderr.write
    process.stdout.write = ((value: string | Uint8Array, callback?: (error?: Error | null) => void) => {
      stdout.push(String(value))
      callback?.()
      return true
    }) as typeof process.stdout.write
    process.stderr.write = ((value: string | Uint8Array, callback?: (error?: Error | null) => void) => {
      stderr.push(String(value))
      callback?.()
      return true
    }) as typeof process.stderr.write
    try {
      expect(await fixture.Main([])).toBe(1)
      expect(await fixture.Main([
        "--root", root,
        "--run-id", "task4-fixture-default-io"
      ])).toBe(1)
    } finally {
      process.stdout.write = originalStdoutWrite
      process.stderr.write = originalStderrWrite
    }
    expect(stderr).toEqual(["PROJECT_SESSION_FIXTURE_USAGE invalid arguments\n"])
    expect(stdout).toHaveLength(1)
    expect(stdout[0]!.startsWith("LIKEGO_GATE_RESULT=")).toBe(true)
  })
})

describe("project-session committed safe probe descriptors", () => {
  test("locks the exact non-empty inventory and strict fixed descriptor shape", async () => {
    const indexFile = File(ProbeCasesPath, await ReadSnapshotText(ProbeCasesPath))
    const cases = ParseProbeCases(indexFile)
    expect(cases.map((item) => item.scenario)).toEqual([...ExpectedProbeScenarios])
    expect(Object.keys(ExpectedProbeContracts)).toEqual([...ExpectedProbeScenarios])
    expect(await FilesBelow(join(RepositoryRoot, ProbeRoot))).toEqual([
      "cases.json",
      ...cases.map((item) => item.path)
    ].sort())

    for (const probeCase of cases) {
      const descriptor = ParseProbeDescriptor(File(
        `${ProbeRoot}/${probeCase.path}`,
        await ReadSnapshotText(`${ProbeRoot}/${probeCase.path}`)
      ))
      expect(descriptor.scenario).toBe(probeCase.scenario)
      expect({
        projectPrefix: descriptor.projectPrefix,
        virtualInputsSha256: VirtualInputsSha256(descriptor.virtualFiles),
        actions: descriptor.actions,
        expected: descriptor.expected
      }).toEqual(
        ExpectedProbeContracts[probeCase.scenario as ProbeScenario]
      )
      expect(descriptor.actions.stage.targetPath).toBe(
        probeCase.scenario === "source-realpath-escape" ? "project/escape-target.ts" : ""
      )
    }
  })

  test("keeps real multiple-project, alternate-identity, external-source and unsafe targets self-contained", async () => {
    const descriptor = async (scenario: string): Promise<ProbeDescriptor> => ParseProbeDescriptor(File(
      `${ProbeRoot}/${scenario}.json`,
      await ReadSnapshotText(`${ProbeRoot}/${scenario}.json`)
    ))
    const multiple = await descriptor("project-count-multiple")
    const identity = await descriptor("project-identity")
    const external = await descriptor("external-source")
    const materialization = await descriptor("materialization-failure")
    const sourceEscape = await descriptor("source-realpath-escape")

    expect(multiple.actions.update).toEqual({
      kind: "project-count-multiple",
      path: "project/alternate/tsconfig.json"
    })
    expect(multiple.virtualFiles.map((file) => file.path)).toEqual([
      "project/tsconfig.json",
      "project/src/index.ts",
      "project/alternate/tsconfig.json",
      "project/alternate/src/index.ts"
    ])
    expect(identity.actions.update).toEqual({
      kind: "project-identity",
      path: "project/alternate/tsconfig.json"
    })
    expect(identity.virtualFiles.some((file) => file.path === "project/alternate/src/index.ts")).toBe(true)
    expect(external.virtualFiles.map((file) => file.path)).toContain(
      "project/node_modules/package-dependency/index.d.ts"
    )
    expect(materialization.virtualFiles.map((file) => file.path)).toContain(materialization.actions.stage.path)
    expect(materialization.actions.stage.path.split("/").some((segment) => segment.length > 255)).toBe(true)
    expect(sourceEscape.actions.stage).toEqual({
      kind: "source-realpath-escape",
      path: "project/src/index.ts",
      targetPath: "project/escape-target.ts"
    })
    expect(sourceEscape.virtualFiles.map((file) => file.path)).toContain(sourceEscape.actions.stage.path)
    expect(sourceEscape.virtualFiles.map((file) => file.path)).toContain(sourceEscape.actions.stage.targetPath)
    expect(sourceEscape.actions.stage.targetPath.startsWith("project/src/")).toBe(false)
    expect((await FilesBelow(join(RepositoryRoot, ProbeRoot))).some((path) => (
      path.split("/").some((segment) => segment.length > 255)
      || path.includes("..")
    ))).toBe(false)
  })

  test("rejects missing, extra, duplicate, mismatched and malformed descriptors before worker admission", async () => {
    const casesText = await ReadSnapshotText(ProbeCasesPath)
    const descriptorText = await ReadSnapshotText(`${ProbeRoot}/success.json`)
    const descriptorValue = JSON.parse(descriptorText) as Record<string, unknown>
    const casesValue = JSON.parse(casesText) as { schemaVersion: number; cases: ProbeCase[] }
    const malformed = { ...descriptorValue }
    delete malformed.expected
    const virtualFiles = descriptorValue.virtualFiles as readonly unknown[]
    const duplicateVirtualPath = {
      ...descriptorValue,
      virtualFiles: [virtualFiles[0], virtualFiles[0]]
    }
    const variants = [
      Snapshot([[ProbeCasesPath, casesText]]),
      Snapshot([
        [ProbeCasesPath, casesText],
        [`${ProbeRoot}/success.json`, descriptorText],
        [`${ProbeRoot}/extra.json`, descriptorText]
      ]),
      Snapshot([
        [ProbeCasesPath, casesText],
        [`${ProbeRoot}/success.json`, descriptorText],
        [`${ProbeRoot}/success.json`, descriptorText]
      ]),
      Snapshot([
        [ProbeCasesPath, casesText],
        [`${ProbeRoot}/success.json`, `${JSON.stringify({ ...descriptorValue, scenario: "primary-error" })}\n`]
      ]),
      Snapshot([
        [ProbeCasesPath, `${JSON.stringify({
          schemaVersion: 1,
          cases: [casesValue.cases[0], casesValue.cases[0]]
        })}\n`],
        [`${ProbeRoot}/success.json`, descriptorText]
      ]),
      Snapshot([
        [ProbeCasesPath, casesText],
        [`${ProbeRoot}/success.json`, `${JSON.stringify(malformed)}\n`]
      ]),
      Snapshot([
        [ProbeCasesPath, casesText],
        [`${ProbeRoot}/success.json`, `${JSON.stringify(duplicateVirtualPath)}\n`]
      ])
    ]
    let workerAdmissions = 0
    for (const variant of variants) {
      expect(() => SelectProbe(variant, "success", () => { workerAdmissions += 1 })).toThrow()
    }
    expect(workerAdmissions).toBe(0)
  })

  test("rejects non-canonical scenario contracts and non-self-contained actions before worker admission", async () => {
    const casesText = await ReadSnapshotText(ProbeCasesPath)
    const casesValue = JSON.parse(casesText) as { schemaVersion: 1; cases: ProbeCase[] }
    const readDescriptor = async (scenario: string): Promise<ProbeDescriptor> => (
      JSON.parse(await ReadSnapshotText(`${ProbeRoot}/${scenario}.json`)) as ProbeDescriptor
    )
    const success = await readDescriptor("success")
    const multiple = await readDescriptor("project-count-multiple")
    const identity = await readDescriptor("project-identity")
    const sourceEscape = await readDescriptor("source-realpath-escape")
    const withIndex = (cases: readonly ProbeCase[]): string => `${JSON.stringify({
      schemaVersion: 1,
      cases
    })}\n`
    const variants: Array<{
      readonly name: string
      readonly requestedScenario: string
      readonly descriptorPath: string
      readonly cases: readonly ProbeCase[]
      readonly descriptor: ProbeDescriptor
    }> = [
      {
        name: "unknown requested scenario",
        requestedScenario: "unknown",
        descriptorPath: "success.json",
        cases: casesValue.cases,
        descriptor: success
      },
      {
        name: "missing canonical scenario",
        requestedScenario: "success",
        descriptorPath: "success.json",
        cases: casesValue.cases.filter((item) => item.scenario !== "external-source"),
        descriptor: success
      },
      {
        name: "extra non-canonical scenario",
        requestedScenario: "success",
        descriptorPath: "success.json",
        cases: [...casesValue.cases, { scenario: "unknown", path: "unknown.json" }],
        descriptor: success
      },
      {
        name: "success action mismatch",
        requestedScenario: "success",
        descriptorPath: "success.json",
        cases: casesValue.cases,
        descriptor: {
          ...success,
          actions: { ...success.actions, callback: { kind: "throw-error" } }
        }
      },
      {
        name: "success expected mismatch",
        requestedScenario: "success",
        descriptorPath: "success.json",
        cases: casesValue.cases,
        descriptor: {
          ...success,
          expected: {
            ...success.expected,
            lifecycle: { ...success.expected.lifecycle, outcome: "primary-error" }
          }
        }
      },
      {
        name: "non-canonical exit code",
        requestedScenario: "success",
        descriptorPath: "success.json",
        cases: casesValue.cases,
        descriptor: {
          ...success,
          expected: {
            ...success.expected,
            lifecycle: { ...success.expected.lifecycle, exitCode: 99 }
          }
        }
      },
      {
        name: "arbitrary gate check id",
        requestedScenario: "success",
        descriptorPath: "success.json",
        cases: casesValue.cases,
        descriptor: {
          ...success,
          expected: {
            ...success.expected,
            gate: { ...success.expected.gate, checkIds: ["ARBITRARY_CHECK"] }
          }
        }
      },
      {
        name: "stage path absent from virtual files",
        requestedScenario: "success",
        descriptorPath: "success.json",
        cases: casesValue.cases,
        descriptor: {
          ...success,
          actions: {
            ...success.actions,
            stage: { kind: "materialization-failure", path: "project/missing.ts", targetPath: "" }
          }
        }
      },
      {
        name: "update path absent from virtual files",
        requestedScenario: "project-count-multiple",
        descriptorPath: "project-count-multiple.json",
        cases: casesValue.cases,
        descriptor: {
          ...multiple,
          actions: {
            ...multiple.actions,
            update: { kind: "project-count-multiple", path: "project/missing/tsconfig.json" }
          }
        }
      },
      {
        name: "source target absent from virtual files",
        requestedScenario: "source-realpath-escape",
        descriptorPath: "source-realpath-escape.json",
        cases: casesValue.cases,
        descriptor: {
          ...sourceEscape,
          actions: {
            ...sourceEscape.actions,
            stage: { ...sourceEscape.actions.stage, targetPath: "project/missing-target.ts" }
          }
        }
      },
      {
        name: "source target remains in src",
        requestedScenario: "source-realpath-escape",
        descriptorPath: "source-realpath-escape.json",
        cases: casesValue.cases,
        descriptor: {
          ...sourceEscape,
          actions: {
            ...sourceEscape.actions,
            stage: { ...sourceEscape.actions.stage, targetPath: "project/src/index.ts" }
          }
        }
      },
      {
        name: "multiple alternate config absent",
        requestedScenario: "project-count-multiple",
        descriptorPath: "project-count-multiple.json",
        cases: casesValue.cases,
        descriptor: {
          ...multiple,
          virtualFiles: multiple.virtualFiles.filter((file) => (
            file.path !== multiple.actions.update.path
          ))
        }
      },
      {
        name: "identity alternate config absent",
        requestedScenario: "project-identity",
        descriptorPath: "project-identity.json",
        cases: casesValue.cases,
        descriptor: {
          ...identity,
          virtualFiles: identity.virtualFiles.filter((file) => (
            file.path !== identity.actions.update.path
          ))
        }
      }
    ]

    const accepted: string[] = []
    let workerAdmissions = 0
    for (const variant of variants) {
      const snapshot = Snapshot([
        [ProbeCasesPath, withIndex(variant.cases)],
        [`${ProbeRoot}/${variant.descriptorPath}`, `${JSON.stringify(variant.descriptor)}\n`]
      ])
      try {
        SelectProbe(snapshot, variant.requestedScenario, () => { workerAdmissions += 1 })
        accepted.push(variant.name)
      } catch {}
    }

    expect(accepted).toEqual([])
    expect(workerAdmissions).toBe(0)
  })

  test("rejects canonical actions when the project prefix or virtual input bytes drift before worker admission", async () => {
    const casesText = await ReadSnapshotText(ProbeCasesPath)
    const readDescriptor = async (scenario: string): Promise<ProbeDescriptor> => (
      JSON.parse(await ReadSnapshotText(`${ProbeRoot}/${scenario}.json`)) as ProbeDescriptor
    )
    const success = await readDescriptor("success")
    const countZero = await readDescriptor("project-count-zero")
    const admission = await readDescriptor("admission-failure")
    const external = await readDescriptor("external-source")
    const variants: Array<{
      readonly name: string
      readonly scenario: string
      readonly descriptor: ProbeDescriptor
    }> = [
      {
        name: "success prefix changed",
        scenario: "success",
        descriptor: { ...success, projectPrefix: "other" }
      },
      {
        name: "success config and source replaced with unrelated bytes",
        scenario: "success",
        descriptor: {
          ...success,
          virtualFiles: [{ path: "anything.txt", utf8: "anything\n" }]
        }
      },
      {
        name: "project count zero missing config was added",
        scenario: "project-count-zero",
        descriptor: {
          ...countZero,
          virtualFiles: [
            ...countZero.virtualFiles,
            {
              path: countZero.actions.update.path,
              utf8: "{\n  \"compilerOptions\": { \"strict\": true, \"noEmit\": true }\n}\n"
            }
          ]
        }
      },
      {
        name: "admission failure gained a valid source",
        scenario: "admission-failure",
        descriptor: {
          ...admission,
          virtualFiles: [
            ...admission.virtualFiles,
            { path: "project/src/index.ts", utf8: "export const value = 1\n" }
          ]
        }
      },
      {
        name: "external source import was removed",
        scenario: "external-source",
        descriptor: {
          ...external,
          virtualFiles: external.virtualFiles.map((file) => file.path === "project/src/index.ts"
            ? { ...file, utf8: "export const value = 1\n" }
            : file)
        }
      },
      {
        name: "external source declaration was removed",
        scenario: "external-source",
        descriptor: {
          ...external,
          virtualFiles: external.virtualFiles.filter((file) => (
            file.path !== "project/node_modules/package-dependency/index.d.ts"
          ))
        }
      }
    ]

    const accepted: string[] = []
    let workerAdmissions = 0
    for (const variant of variants) {
      const snapshot = Snapshot([
        [ProbeCasesPath, casesText],
        [`${ProbeRoot}/${variant.scenario}.json`, `${JSON.stringify(variant.descriptor)}\n`]
      ])
      try {
        SelectProbe(snapshot, variant.scenario, () => { workerAdmissions += 1 })
        accepted.push(variant.name)
      } catch {}
    }

    expect(accepted).toEqual([])
    expect(workerAdmissions).toBe(0)
  })

  test("derives unique input hashes and never rereads a descriptor after snapshot", async () => {
    const { SnapshotInputs } = await import("../gates/result.ts")
    const index = ParseProbeCases(File(ProbeCasesPath, await ReadSnapshotText(ProbeCasesPath)))
    const hashes: string[] = []
    for (const probeCase of index) {
      const result = await SnapshotInputs(RepositoryRoot, [
        ProbeCasesPath,
        `${ProbeRoot}/${probeCase.path}`
      ])
      expect(result.Checks).toEqual([])
      expect(result.Snapshot).not.toBeNull()
      hashes.push(result.Snapshot!.Sha256)
    }
    expect(new Set(hashes).size).toBe(index.length)

    const root = await mkdtemp(join(tmpdir(), "likego-project-session-snapshot-"))
    TemporaryRoots.push(root)
    const descriptorPath = `${ProbeRoot}/success.json`
    for (const path of [ProbeCasesPath, descriptorPath]) {
      await mkdir(dirname(join(root, path)), { recursive: true })
      await Bun.write(join(root, path), await ReadSnapshotText(path))
    }
    const snapshotted = await SnapshotInputs(root, [ProbeCasesPath, descriptorPath])
    expect(snapshotted.Checks).toEqual([])
    expect(snapshotted.Snapshot).not.toBeNull()
    await Bun.write(join(root, descriptorPath), "{\"mutated\":true}\n")
    let workerAdmissions = 0
    const selected = SelectProbe(snapshotted.Snapshot!, "success", () => { workerAdmissions += 1 })
    expect(selected.scenario).toBe("success")
    expect(selected.virtualFiles[1]?.utf8).toBe("export const value: number = 1\n")
    expect(workerAdmissions).toBe(1)
  })
})

describe("Task4 Step2 input admission and real staging RED", () => {
  test("rejects every unsafe prefix and snapshot path plus invalid bytes and lexical collisions before staging", async () => {
    const module = await LoadProjectSession()
    const root = await RepositoryFixture("likego-project-session-input-")
    const calls: string[] = []
    const operations = ForbiddenOperations(root, calls)
    const unsafePrefixes = [
      "",
      "/project",
      "project\\nested",
      "project\0nested",
      "project/",
      "project//nested",
      "project/./nested",
      "project/../nested"
    ]
    for (const prefix of unsafePrefixes) {
      await ExpectAdmissionIssue(
        module,
        ValidProjectSnapshot(),
        prefix,
        operations,
        "PROJECT_SESSION_INPUT_INVALID",
        prefix
      )
    }

    const unsafePaths = [
      "",
      "/absolute.ts",
      "shared\\file.ts",
      "shared\0file.ts",
      "shared//file.ts",
      "shared/./file.ts",
      "shared/../file.ts"
    ]
    for (const path of unsafePaths) {
      await ExpectAdmissionIssue(
        module,
        ValidProjectSnapshot([File(path, "unsafe\n")]),
        "project",
        operations,
        "PROJECT_SESSION_INPUT_INVALID",
        path
      )
    }

    const invalidByteFile = {
      ...File("project/src/invalid.ts", "ignored\n"),
      Bytes: "not bytes" as unknown as Uint8Array
    }
    await ExpectAdmissionIssue(
      module,
      ValidProjectSnapshot([invalidByteFile]),
      "project",
      operations,
      "PROJECT_SESSION_INPUT_INVALID",
      "project/src/invalid.ts"
    )

    const duplicate = ValidProjectSnapshot([File("project/src/index.ts", "duplicate\n")])
    await ExpectAdmissionIssue(
      module,
      duplicate,
      "project",
      operations,
      "PROJECT_SESSION_INPUT_INVALID",
      "project/src/index.ts"
    )

    const collision = SnapshotFiles([
      File("project/tsconfig.json", "{}\n"),
      File("project/src", "file collides with directory\n"),
      File("project/src/index.ts", "export const value = 1\n")
    ])
    await ExpectAdmissionIssue(
      module,
      collision,
      "project",
      operations,
      "PROJECT_SESSION_INPUT_INVALID",
      "project/src"
    )

    await ExpectAdmissionIssue(
      module,
      SnapshotFiles([File("project/src/index.ts", "export const value = 1\n")]),
      "project",
      operations,
      "PROJECT_SESSION_CONFIG_MISSING",
      "project/tsconfig.json"
    )
    expect(calls).toEqual([])
    await ExpectEnoent(join(root, ".artifacts"))
  })

  test("rejects invalid repository and existing work components without acquiring cleanup resources", async () => {
    const module = await LoadProjectSession()
    const parent = await RepositoryFixture("likego-project-session-stage-invalid-")
    const rootFile = join(parent, "root-file")
    const realRoot = join(parent, "real-root")
    const rootLink = join(parent, "root-link")
    await Bun.write(rootFile, "not a directory\n")
    await mkdir(realRoot, { mode: 0o700 })
    await symlink(realRoot, rootLink)
    const invalidRoots = [join(parent, "missing-root"), rootFile, rootLink]
    for (const invalidRoot of invalidRoots) {
      const calls: string[] = []
      const operations = ObservedOperations(module.NodeProjectSessionOperations(invalidRoot), calls)
      await ExpectAdmissionIssue(
        module,
        ValidProjectSnapshot(),
        "project",
        operations,
        "PROJECT_SESSION_STAGE_INVALID",
        "."
      )
      expect(calls).toEqual([])
    }

    for (const component of [".artifacts", ".artifacts/gates", ".artifacts/gates/work"]) {
      for (const kind of ["file", "symlink"] as const) {
        const repository = await RepositoryFixture("likego-project-session-component-")
        const absolute = join(repository, component)
        await mkdir(dirname(absolute), { recursive: true, mode: 0o700 })
        if (kind === "file") {
          await Bun.write(absolute, "not a directory\n")
        } else {
          const target = join(repository, `target-${basename(component)}`)
          await mkdir(target, { mode: 0o700 })
          await symlink(target, absolute)
        }
        const calls: string[] = []
        const operations = ObservedOperations(module.NodeProjectSessionOperations(repository), calls)
        await ExpectAdmissionIssue(
          module,
          ValidProjectSnapshot(),
          "project",
          operations,
          "PROJECT_SESSION_STAGE_INVALID",
          component
        )
        expect(calls).toEqual([])
      }
    }
  })

  test("removes only the acquired stage and nonce after a real overlong materialization failure", async () => {
    const module = await LoadProjectSession()
    const root = await RepositoryFixture("likego-project-session-overlong-")
    const descriptor = JSON.parse(
      await ReadSnapshotText(`${ProbeRoot}/materialization-failure.json`)
    ) as ProbeDescriptor
    const snapshot = SnapshotFiles(descriptor.virtualFiles.map((file) => File(file.path, file.utf8)))
    const calls: string[] = []
    const removedPaths: string[] = []
    const operations = ObservedOperations(module.NodeProjectSessionOperations(root), calls, removedPaths)
    let callbackCalled = false
    let caught: unknown
    try {
      await module.WithProjectSessionWithOperations(snapshot, descriptor.projectPrefix, async () => {
        callbackCalled = true
      }, operations)
    } catch (error) {
      caught = error
    }

    expect(IsRecord(caught) && caught.code).toBe("ENAMETOOLONG")
    expect(callbackCalled).toBe(false)
    expect(calls).toEqual(["remove-staging"])
    expect(removedPaths).toHaveLength(1)
    await ExpectEnoent(removedPaths[0]!)
    await ExpectEnoent(dirname(removedPaths[0]!))
    expect((await lstat(join(root, ".artifacts/gates/work"))).isDirectory()).toBe(true)
  })

  test("refuses to remove a shape-matching staging path that was never acquired", async () => {
    const module = await LoadProjectSession()
    const root = await RepositoryFixture("likego-project-session-unowned-remove-")
    const operations = module.NodeProjectSessionOperations(root)
    const nonce = join(
      operations.RepositoryRoot,
      ".artifacts/gates/work/00000000-0000-4000-8000-000000000000"
    )
    const boundary = join(nonce, "boundary-project")
    const sentinel = join(boundary, "sentinel.txt")
    await mkdir(boundary, { recursive: true, mode: 0o700 })
    await Bun.write(sentinel, "preserve unowned bytes\n")

    await expect(operations.RemoveStaging(boundary)).rejects.toBeInstanceOf(Error)
    expect(await readFile(sentinel, "utf8")).toBe("preserve unowned bytes\n")
    expect((await lstat(boundary)).isDirectory()).toBe(true)
    expect((await lstat(nonce)).isDirectory()).toBe(true)
  })

  test("never follows a replaced owned nonce symlink during direct or session cleanup", async () => {
    const module = await LoadProjectSession()
    const root = await RepositoryFixture("likego-project-session-cleanup-identity-")
    const cleanupOrder: string[] = []
    const base = module.NodeProjectSessionOperations(root)
    const operations = CleanObservedOperations(base, cleanupOrder)
    const externalNonce = join(root, "external-nonce")
    const externalBoundary = join(externalNonce, "boundary-project")
    const sentinel = join(externalBoundary, "sentinel.txt")
    await mkdir(externalBoundary, { recursive: true, mode: 0o700 })
    await Bun.write(sentinel, "preserve external bytes\n")
    let nonce = ""
    let retainedNonce = ""
    let directCleanupError: unknown
    let caught: unknown

    try {
      await module.WithProjectSessionWithOperations(
        ValidProjectSnapshot(),
        "project",
        async (session) => {
          nonce = dirname(session.StagedRoot)
          retainedNonce = `${nonce}-retained`
          await rename(nonce, retainedNonce)
          await symlink(externalNonce, nonce)
          try {
            await base.RemoveStaging(session.StagedRoot)
          } catch (error) {
            directCleanupError = error
          }
        },
        operations
      )
    } catch (error) {
      caught = error
    }

    expect(directCleanupError).toBeInstanceOf(Error)
    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as AggregateError).errors).toHaveLength(1)
    expect(cleanupOrder).toEqual(["snapshot.dispose", "api.close"])
    expect(await readFile(sentinel, "utf8")).toBe("preserve external bytes\n")
    expect((await lstat(nonce)).isSymbolicLink()).toBe(true)
    await rm(nonce)
    await rename(retainedNonce, nonce)
    await expect(base.RemoveStaging(join(nonce, "boundary-project"))).rejects.toBeInstanceOf(Error)
    expect((await lstat(join(nonce, "boundary-project"))).isDirectory()).toBe(true)
    await rm(nonce, { recursive: true })
  })

  test("retains ownership for one safe retry after remove fails before delegating", async () => {
    const module = await LoadProjectSession()
    const root = await RepositoryFixture("likego-project-session-remove-retry-")
    const base = module.NodeProjectSessionOperations(root)
    const cleanupOrder: string[] = []
    const removeFault = new Error("remove before delegate")
    const operations: TestProjectSessionOperations = {
      ...CleanObservedOperations(base, cleanupOrder),
      RemoveStaging: async () => {
        cleanupOrder.push("remove-staging")
        throw removeFault
      }
    }
    let stagedRoot = ""
    let caught: unknown

    try {
      await module.WithProjectSessionWithOperations(
        ValidProjectSnapshot(),
        "project",
        async (session) => { stagedRoot = session.StagedRoot },
        operations
      )
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as AggregateError).errors).toEqual([removeFault])
    expect(cleanupOrder).toEqual(["snapshot.dispose", "api.close", "remove-staging"])
    expect((await lstat(stagedRoot)).isDirectory()).toBe(true)
    expect((await lstat(dirname(stagedRoot))).isDirectory()).toBe(true)

    await base.RemoveStaging(stagedRoot)
    await ExpectEnoent(stagedRoot)
    await ExpectEnoent(dirname(stagedRoot))
  })

  test("keeps ownership revoked when a remove delegate succeeds before its wrapper throws", async () => {
    const module = await LoadProjectSession()
    const root = await RepositoryFixture("likego-project-session-remove-after-")
    const base = module.NodeProjectSessionOperations(root)
    const cleanupOrder: string[] = []
    const removeFault = new Error("remove after delegate")
    const operations: TestProjectSessionOperations = {
      ...CleanObservedOperations(base, cleanupOrder),
      RemoveStaging: async (path) => {
        cleanupOrder.push("remove-staging")
        await base.RemoveStaging(path)
        throw removeFault
      }
    }
    let stagedRoot = ""
    let caught: unknown

    try {
      await module.WithProjectSessionWithOperations(
        ValidProjectSnapshot(),
        "project",
        async (session) => { stagedRoot = session.StagedRoot },
        operations
      )
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as AggregateError).errors).toEqual([removeFault])
    expect(cleanupOrder).toEqual(["snapshot.dispose", "api.close", "remove-staging"])
    await ExpectEnoent(stagedRoot)
    await ExpectEnoent(dirname(stagedRoot))

    const replacementSentinel = join(stagedRoot, "replacement.txt")
    await mkdir(stagedRoot, { recursive: true, mode: 0o700 })
    await Bun.write(replacementSentinel, "preserve replacement bytes\n")
    await expect(base.RemoveStaging(stagedRoot)).rejects.toBeInstanceOf(Error)
    expect(await readFile(replacementSentinel, "utf8")).toBe("preserve replacement bytes\n")
  })
})

describe("Task4 Step2 clean real TypeScript project lifecycle RED", () => {
  test("materializes only selected bytes with owned modes and exposes sorted transitive package sources", async () => {
    const module = await LoadProjectSession()
    const root = await RepositoryFixture("likego-project-session-clean-")
    const configText = "{\n  \"compilerOptions\": { \"strict\": true, \"noEmit\": true, \"target\": \"ES2022\" },\n  \"files\": [\"src/z.ts\"]\n}\n"
    const aText = "export const a = 1\n"
    const zText = "import { a } from \"./a.js\"\nexport const z = a\n"
    const unselected = File("shared/unselected.ts", "must never be written\n")
    Object.defineProperty(unselected, "RealPath", {
      get(): never {
        throw new Error("SnapshotFile.RealPath must never be read")
      }
    })
    const snapshot = SnapshotFiles([
      File("project/tsconfig.json", configText),
      File("project/src/z.ts", zText),
      File("project/src/a.ts", aText),
      unselected
    ])
    const cleanupOrder: string[] = []
    const removedPaths: string[] = []
    const operations = CleanObservedOperations(
      module.NodeProjectSessionOperations(root),
      cleanupOrder,
      removedPaths
    )
    const callbackValue = { exact: "callback-value" }
    let stagedRoot = ""
    const value = await module.WithProjectSessionWithOperations(snapshot, "project", async (session) => {
      stagedRoot = session.StagedRoot
      const repositoryReal = await realpath(root)
      const work = join(repositoryReal, ".artifacts/gates/work")
      expect(basename(session.StagedRoot)).toBe("boundary-project")
      expect(dirname(dirname(session.StagedRoot))).toBe(work)
      expect(await realpath(session.StagedRoot)).toBe(session.StagedRoot)
      expect(session.Project.configFileName).toBe(join(session.StagedRoot, "project/tsconfig.json"))
      expect([
        session.Project.configFileName,
        session.Project.configFileName.toLowerCase()
      ]).toContain(String(session.Project.id))
      expect(session.Project.rootFiles).toEqual([join(session.StagedRoot, "project/src/z.ts")])
      expect(session.SourceFiles.map((file) => file.fileName)).toEqual([
        join(session.StagedRoot, "project/src/a.ts"),
        join(session.StagedRoot, "project/src/z.ts")
      ])

      const ownedDirectories = [
        join(repositoryReal, ".artifacts"),
        join(repositoryReal, ".artifacts/gates"),
        work,
        dirname(session.StagedRoot),
        session.StagedRoot,
        join(session.StagedRoot, "project"),
        join(session.StagedRoot, "project/src")
      ]
      for (const directory of ownedDirectories) {
        const status = await lstat(directory)
        expect(status.isDirectory()).toBe(true)
        expect(status.isSymbolicLink()).toBe(false)
        expect(status.mode & 0o777).toBe(0o700)
        expect(await realpath(directory)).toBe(directory)
      }
      for (const path of [
        "project/tsconfig.json",
        "project/src/a.ts",
        "project/src/z.ts"
      ]) {
        const status = await lstat(join(session.StagedRoot, path))
        expect(status.isFile()).toBe(true)
        expect(status.isSymbolicLink()).toBe(false)
        expect(status.mode & 0o777).toBe(0o600)
      }
      expect(await readFile(join(session.StagedRoot, "project/tsconfig.json"), "utf8")).toBe(configText)
      expect(await readFile(join(session.StagedRoot, "project/src/a.ts"), "utf8")).toBe(aText)
      expect(await readFile(join(session.StagedRoot, "project/src/z.ts"), "utf8")).toBe(zText)
      await ExpectEnoent(join(session.StagedRoot, "shared"))
      return callbackValue
    }, operations)

    expect(value).toBe(callbackValue)
    expect(cleanupOrder).toEqual(["snapshot.dispose", "api.close", "remove-staging"])
    expect(removedPaths).toEqual([stagedRoot])
    await ExpectEnoent(stagedRoot)
    await ExpectEnoent(dirname(stagedRoot))
    for (const ancestor of [".artifacts", ".artifacts/gates", ".artifacts/gates/work"]) {
      expect((await lstat(join(root, ancestor))).isDirectory()).toBe(true)
    }
  })

  test("returns exact undefined and null callback values with independent clean cleanup", async () => {
    const module = await LoadProjectSession()
    const root = await RepositoryFixture("likego-project-session-values-")
    const cleanupOrder: string[] = []
    for (const callbackValue of [undefined, null] as const) {
      const operations = CleanObservedOperations(
        module.NodeProjectSessionOperations(root),
        cleanupOrder
      )
      const value = await module.WithProjectSessionWithOperations(
        ValidProjectSnapshot(),
        "project",
        async () => callbackValue,
        operations
      )
      expect(value).toBe(callbackValue)
    }
    expect(cleanupOrder).toEqual([
      "snapshot.dispose",
      "api.close",
      "remove-staging",
      "snapshot.dispose",
      "api.close",
      "remove-staging"
    ])
  })

  test("binds a relative explicit root at operations creation and delegates the default API to current cwd", async () => {
    const module = await LoadProjectSession()
    const container = await RepositoryFixture("likego-project-session-root-binding-")
    const boundRoot = join(container, "bound")
    const laterCwd = join(container, "later")
    await mkdir(join(boundRoot, ".artifacts/gates/work"), { recursive: true, mode: 0o700 })
    await Bun.write(join(boundRoot, ".artifacts/gates/work/unrelated.txt"), "preserve me\n")
    await mkdir(laterCwd, { mode: 0o700 })
    const previousCwd = process.cwd()
    try {
      process.chdir(container)
      const boundOperations = module.NodeProjectSessionOperations("bound")
      expect(boundOperations.RepositoryRoot).toBe(await realpath(boundRoot))
      process.chdir(laterCwd)
      let explicitStage = ""
      await module.WithProjectSessionWithOperations(
        ValidProjectSnapshot(),
        "project",
        async (session) => { explicitStage = session.StagedRoot },
        boundOperations
      )
      expect(explicitStage.startsWith(`${await realpath(boundRoot)}/`)).toBe(true)
      expect(await readFile(join(boundRoot, ".artifacts/gates/work/unrelated.txt"), "utf8")).toBe("preserve me\n")
      await ExpectEnoent(join(laterCwd, ".artifacts"))

      let defaultStage = ""
      await module.WithProjectSession(ValidProjectSnapshot(), "project", async (session) => {
        defaultStage = session.StagedRoot
      })
      expect(defaultStage.startsWith(`${await realpath(laterCwd)}/`)).toBe(true)
    } finally {
      process.chdir(previousCwd)
    }
  })
})

describe("Task4 Step2 real project and source admission RED", () => {
  test("accepts a lowercase project id only when it resolves to the canonical config identity", async () => {
    const module = await LoadProjectSession()
    const root = await RepositoryFixture("LikeGo-project-session-project-id-case-")
    const cleanupOrder: string[] = []
    const removedPaths: string[] = []
    const base = module.NodeProjectSessionOperations(root)
    let lowercaseAliasesCanonical = false
    const operations: TestProjectSessionOperations = {
      ...CleanObservedOperations(base, cleanupOrder, removedPaths),
      UpdateSnapshot: async (api, canonicalTsconfig) => {
        const snapshot = await base.UpdateSnapshot(api, canonicalTsconfig)
        const project = snapshot.getProjects()[0]
        if (project === undefined) throw new Error("real TS7 project must exist")
        const lowercaseConfig = canonicalTsconfig.toLowerCase()
        expect(lowercaseConfig).not.toBe(canonicalTsconfig)
        const canonicalStatus = await lstat(canonicalTsconfig)
        try {
          const lowercaseStatus = await lstat(lowercaseConfig)
          lowercaseAliasesCanonical = (
            !lowercaseStatus.isSymbolicLink()
            && lowercaseStatus.isFile()
            && lowercaseStatus.dev === canonicalStatus.dev
            && lowercaseStatus.ino === canonicalStatus.ino
            && await realpath(lowercaseConfig) === canonicalTsconfig
          )
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error
        }
        expect(Reflect.set(project, "id", lowercaseConfig)).toBe(true)
        expect(String(project.id)).toBe(lowercaseConfig)
        return snapshot
      }
    }

    const result = await module.AnalyzeProjectSessionWithOperations(
      ValidProjectSnapshot(),
      "project",
      operations
    )

    expect(result).toEqual(lowercaseAliasesCanonical
      ? { SourceFilesChecked: 1, Issues: [] }
      : {
          SourceFilesChecked: 0,
          Issues: [{
            Code: "PROJECT_SESSION_PROJECT_IDENTITY",
            Path: "project/tsconfig.json",
            Message: expect.any(String)
          }]
        })
    expect(cleanupOrder).toEqual(["snapshot.dispose", "api.close", "remove-staging"])
    expect(removedPaths).toHaveLength(1)
    await ExpectEnoent(removedPaths[0]!)
    await ExpectEnoent(dirname(removedPaths[0]!))
  })

  test("returns only tagged admission issues from real TS7 projects after clean cleanup", async () => {
    const module = await LoadProjectSession()
    const cases = [
      {
        scenario: "project-count-zero",
        Code: "PROJECT_SESSION_PROJECT_COUNT",
        Path: "project/tsconfig.json"
      },
      {
        scenario: "project-count-multiple",
        Code: "PROJECT_SESSION_PROJECT_COUNT",
        Path: "project/tsconfig.json"
      },
      {
        scenario: "project-identity",
        Code: "PROJECT_SESSION_PROJECT_IDENTITY",
        Path: "project/tsconfig.json"
      },
      {
        scenario: "admission-failure",
        Code: "PROJECT_SESSION_SOURCE_ZERO",
        Path: "project/src"
      },
      {
        scenario: "source-realpath-escape",
        Code: "PROJECT_SESSION_SOURCE_ESCAPE",
        Path: "project/src/index.ts"
      },
      {
        scenario: "external-source",
        Code: "PROJECT_SESSION_EXTERNAL_SOURCE",
        Path: "project/node_modules/package-dependency/index.d.ts"
      }
    ] as const

    for (const item of cases) {
      const root = await RepositoryFixture(`likego-project-session-${item.scenario}-`)
      const descriptor = await ReadProbeDescriptor(item.scenario)
      const cleanupOrder: string[] = []
      const removedPaths: string[] = []
      const operations = RealScenarioOperations(
        module.NodeProjectSessionOperations(root),
        descriptor,
        cleanupOrder,
        removedPaths
      )
      const result = await module.AnalyzeProjectSessionWithOperations(
        DescriptorSnapshot(descriptor),
        descriptor.projectPrefix,
        operations
      )

      expect(result.SourceFilesChecked).toBe(0)
      expect(result.Issues).toHaveLength(1)
      expect(result.Issues[0]).toEqual({
        Code: item.Code,
        Path: item.Path,
        Message: expect.any(String)
      })
      expect(result.Issues[0]!.Message).not.toContain(root)
      expect(cleanupOrder).toEqual(["snapshot.dispose", "api.close", "remove-staging"])
      expect(removedPaths).toHaveLength(1)
      await ExpectEnoent(removedPaths[0]!)
      await ExpectEnoent(dirname(removedPaths[0]!))
    }
  })

  test("rejects a real regular local program source outside the staged project src directory", async () => {
    const module = await LoadProjectSession()
    const root = await RepositoryFixture("likego-project-session-source-outside-")
    const snapshot = SnapshotFiles([
      File("project/tsconfig.json", "{\n  \"compilerOptions\": { \"strict\": true, \"noEmit\": true },\n  \"files\": [\"outside.ts\"]\n}\n"),
      File("project/outside.ts", "export const outside = true\n")
    ])
    const cleanupOrder: string[] = []
    const removedPaths: string[] = []
    const operations = CleanObservedOperations(
      module.NodeProjectSessionOperations(root),
      cleanupOrder,
      removedPaths
    )
    const result = await module.AnalyzeProjectSessionWithOperations(snapshot, "project", operations)

    expect(result).toEqual({
      SourceFilesChecked: 0,
      Issues: [{
        Code: "PROJECT_SESSION_SOURCE_ESCAPE",
        Path: "project/outside.ts",
        Message: expect.any(String)
      }]
    })
    expect(cleanupOrder).toEqual(["snapshot.dispose", "api.close", "remove-staging"])
    expect(removedPaths).toHaveLength(1)
    await ExpectEnoent(removedPaths[0]!)
    await ExpectEnoent(dirname(removedPaths[0]!))

    const callbackRoot = await RepositoryFixture("likego-project-session-source-outside-callback-")
    const callbackCleanupOrder: string[] = []
    const callbackRemovedPaths: string[] = []
    const callbackOperations = CleanObservedOperations(
      module.NodeProjectSessionOperations(callbackRoot),
      callbackCleanupOrder,
      callbackRemovedPaths
    )
    let callbackCount = 0
    let admissionPrimary: unknown
    try {
      await module.WithProjectSessionWithOperations(snapshot, "project", async () => {
        callbackCount += 1
      }, callbackOperations)
    } catch (error) {
      admissionPrimary = error
    }
    expect(callbackCount).toBe(0)
    expect(admissionPrimary).toBeInstanceOf(Error)
    expect(callbackCleanupOrder).toEqual(["snapshot.dispose", "api.close", "remove-staging"])
    expect(callbackRemovedPaths).toHaveLength(1)
    await ExpectEnoent(callbackRemovedPaths[0]!)
    await ExpectEnoent(dirname(callbackRemovedPaths[0]!))
  })

  test("rejects a real TS source replaced by a directory after the real snapshot returns", async () => {
    const module = await LoadProjectSession()
    const root = await RepositoryFixture("likego-project-session-source-directory-")
    const cleanupOrder: string[] = []
    const removedPaths: string[] = []
    const base = module.NodeProjectSessionOperations(root)
    const operations: TestProjectSessionOperations = {
      ...CleanObservedOperations(base, cleanupOrder, removedPaths),
      UpdateSnapshot: async (api, canonicalTsconfig) => {
        const snapshot = await base.UpdateSnapshot(api, canonicalTsconfig)
        const source = join(dirname(canonicalTsconfig), "src/index.ts")
        await rm(source)
        await mkdir(source, { mode: 0o700 })
        return snapshot
      }
    }
    const result = await module.AnalyzeProjectSessionWithOperations(
      ValidProjectSnapshot(),
      "project",
      operations
    )

    expect(result).toEqual({
      SourceFilesChecked: 0,
      Issues: [{
        Code: "PROJECT_SESSION_SOURCE_ESCAPE",
        Path: "project/src/index.ts",
        Message: expect.any(String)
      }]
    })
    expect(cleanupOrder).toEqual(["snapshot.dispose", "api.close", "remove-staging"])
    expect(removedPaths).toHaveLength(1)
    await ExpectEnoent(removedPaths[0]!)
    await ExpectEnoent(dirname(removedPaths[0]!))
  })

  test("rejects canonical config identity after replacing it with a staged self-contained symlink", async () => {
    const module = await LoadProjectSession()
    const root = await RepositoryFixture("likego-project-session-config-symlink-")
    const configText = "{\n  \"compilerOptions\": { \"strict\": true, \"noEmit\": true },\n  \"files\": [\"src/index.ts\"]\n}\n"
    const snapshot = SnapshotFiles([
      File("project/tsconfig.json", configText),
      File("project/config-target.json", configText),
      File("project/src/index.ts", "export const value = 1\n")
    ])
    const cleanupOrder: string[] = []
    const removedPaths: string[] = []
    const base = module.NodeProjectSessionOperations(root)
    const operations: TestProjectSessionOperations = {
      ...CleanObservedOperations(base, cleanupOrder, removedPaths),
      UpdateSnapshot: async (api, canonicalTsconfig) => {
        const realSnapshot = await base.UpdateSnapshot(api, canonicalTsconfig)
        await rm(canonicalTsconfig)
        await symlink("config-target.json", canonicalTsconfig)
        return realSnapshot
      }
    }
    const result = await module.AnalyzeProjectSessionWithOperations(snapshot, "project", operations)

    expect(result).toEqual({
      SourceFilesChecked: 0,
      Issues: [{
        Code: "PROJECT_SESSION_PROJECT_IDENTITY",
        Path: "project/tsconfig.json",
        Message: expect.any(String)
      }]
    })
    expect(cleanupOrder).toEqual(["snapshot.dispose", "api.close", "remove-staging"])
    expect(removedPaths).toHaveLength(1)
    await ExpectEnoent(removedPaths[0]!)
    await ExpectEnoent(dirname(removedPaths[0]!))
  })

  test("propagates the exact unexpected worker error after independently closing API and removing staging", async () => {
    const module = await LoadProjectSession()
    const root = await RepositoryFixture("likego-project-session-unexpected-")
    const sentinel = new Error("unexpected update failure")
    const cleanupOrder: string[] = []
    const removedPaths: string[] = []
    const base = module.NodeProjectSessionOperations(root)
    const clean = CleanObservedOperations(base, cleanupOrder, removedPaths)
    const operations: TestProjectSessionOperations = {
      ...clean,
      UpdateSnapshot: async (api, canonicalTsconfig) => {
        await api.parseConfigFile(canonicalTsconfig)
        throw sentinel
      }
    }
    let caught: unknown
    try {
      await module.AnalyzeProjectSessionWithOperations(
        ValidProjectSnapshot(),
        "project",
        operations
      )
    } catch (error) {
      caught = error
    }

    expect(caught).toBe(sentinel)
    expect(cleanupOrder).toEqual(["api.close", "remove-staging"])
    expect(removedPaths).toHaveLength(1)
    await ExpectEnoent(removedPaths[0]!)
    await ExpectEnoent(dirname(removedPaths[0]!))
  })
})

describe("project-session production selector RED", () => {
  test("exports the frozen project session interface", async () => {
    const module = await LoadProjectSession()
    for (const name of [
      "NodeProjectSessionOperations",
      "WithProjectSession",
      "WithProjectSessionWithOperations",
      "AnalyzeProjectSession",
      "AnalyzeProjectSessionWithOperations",
      "WithWorkspaceProjectSessionWithOperations",
      "AnalyzeWorkspaceProjectSessionWithOperations"
    ]) {
      expect(module[name]).toBeFunction()
    }
  })
})

describe("Pre-kernel Task 7a workspace project authority RED", () => {
  test("Task 7a rereview regression: rejects source BOM and detects both restored BOM worker inputs", async () => {
    const module = await LoadProjectSession()
    const sourceBytes = Encoder.encode("export const authority = 'canonical'\n")
    const bomSourceBytes = ConcatenateBytes(new Uint8Array([0xef, 0xbb, 0xbf]), sourceBytes)
    const expectedIssue = {
      Code: "PROJECT_SESSION_SOURCE_NOT_SNAPSHOT",
      Path: "packages/a/src/index.ts",
      Message: expect.any(String)
    }

    async function AnalyzeBytes(
      label: string,
      snapshotBytes: Uint8Array,
      workerBytes: Uint8Array | null
    ): Promise<{
      readonly Result: { readonly SourceFilesChecked: number; readonly Issues: readonly TestSessionIssue[] }
      readonly Calls: readonly string[]
    }> {
      const root = await RepositoryFixture(`likego-workspace-bom-${label}-`)
      const base = module.NodeProjectSessionOperations(root)
      const calls: string[] = []
      const source = BytesFile("packages/a/src/index.ts", snapshotBytes)
      const result = await module.AnalyzeWorkspaceProjectSessionWithOperations(
        SnapshotFiles([
          File("packages/a/package.json", '{"name":"@workspace/a"}\n'),
          File("packages/a/tsconfig.json", WorkspaceConfig()),
          source
        ]),
        { ProjectPrefix: "packages/a", DependencyPrefixes: [] },
        {
          ...base,
          UpdateSnapshot: async (api, canonicalTsconfig) => {
            calls.push("update")
            if (workerBytes === null) return base.UpdateSnapshot(api, canonicalTsconfig)
            const stagedSource = join(dirname(canonicalTsconfig), "src/index.ts")
            await Bun.write(stagedSource, workerBytes)
            try {
              return await base.UpdateSnapshot(api, canonicalTsconfig)
            } finally {
              await Bun.write(stagedSource, source.Bytes)
            }
          }
        }
      )
      return { Result: result, Calls: calls }
    }

    const bomToPlain = await AnalyzeBytes("snapshot-bom-worker-plain", bomSourceBytes, sourceBytes)
    const plainToBom = await AnalyzeBytes("snapshot-plain-worker-bom", sourceBytes, bomSourceBytes)
    const unchangedBom = await AnalyzeBytes("unchanged-bom", bomSourceBytes, null)
    const unchangedPlain = await AnalyzeBytes("unchanged-plain", sourceBytes, null)

    expect([bomToPlain, plainToBom, unchangedBom, unchangedPlain]).toEqual([
      { Result: { SourceFilesChecked: 0, Issues: [expectedIssue] }, Calls: [] },
      { Result: { SourceFilesChecked: 0, Issues: [expectedIssue] }, Calls: ["update"] },
      { Result: { SourceFilesChecked: 0, Issues: [expectedIssue] }, Calls: [] },
      { Result: { SourceFilesChecked: 1, Issues: [] }, Calls: ["update"] }
    ])

    const legacyRoot = await RepositoryFixture("likego-project-legacy-bom-")
    const legacy = await module.AnalyzeProjectSessionWithOperations(
      SnapshotFiles([
        File("project/tsconfig.json", WorkspaceConfig()),
        BytesFile("project/src/index.ts", bomSourceBytes)
      ]),
      "project",
      module.NodeProjectSessionOperations(legacyRoot)
    )
    expect(legacy).toEqual({ SourceFilesChecked: 1, Issues: [] })
  })

  test("Task 7a rereview regression: seals every selected input across the worker update", async () => {
    const module = await LoadProjectSession()
    const root = await RepositoryFixture("likego-workspace-selected-input-seal-")
    const base = module.NodeProjectSessionOperations(root)
    const config = File("packages/a/tsconfig.json", WorkspaceConfig())
    const calls: string[] = []
    const result = await module.AnalyzeWorkspaceProjectSessionWithOperations(
      SnapshotFiles([
        File("packages/a/package.json", '{"name":"@workspace/a"}\n'),
        config,
        File("packages/a/src/index.ts", "export const a = true\n")
      ]),
      { ProjectPrefix: "packages/a", DependencyPrefixes: [] },
      {
        ...base,
        UpdateSnapshot: async (api, canonicalTsconfig) => {
          calls.push("update")
          await Bun.write(canonicalTsconfig, ConcatenateBytes(config.Bytes, Encoder.encode("\n")))
          try {
            return await base.UpdateSnapshot(api, canonicalTsconfig)
          } finally {
            await Bun.write(canonicalTsconfig, config.Bytes)
          }
        }
      }
    )

    expect(result).toEqual({
      SourceFilesChecked: 0,
      Issues: [{
        Code: "PROJECT_SESSION_STAGE_INVALID",
        Path: "packages/a/tsconfig.json",
        Message: expect.any(String)
      }]
    })
    expect(calls).toEqual(["update"])
    expect(await readdir(join(root, ".artifacts/gates/work"))).toEqual([])
  })

  test("Task 7a rereview regression: preserves only selected diagnostic replacements as non-escapes", async () => {
    const module = await LoadProjectSession()
    const root = await RepositoryFixture("likego-workspace-diagnostic-replacement-scope-")
    const base = module.NodeProjectSessionOperations(root)
    let stagedRoot = ""
    const result = await WithInjectedProgramDiagnostics(
      () => [{
        pos: 0,
        end: 0,
        code: 9902,
        category: 1,
        text: `target ${join(stagedRoot, "packages/a/src/index.ts")}`,
        messageChain: [{
          pos: 0,
          end: 0,
          code: 9902,
          category: 1,
          text: `dependency ${join(stagedRoot, "packages/b/src/index.ts")}`
        }, {
          pos: 0,
          end: 0,
          code: 9902,
          category: 1,
          text: `broad ${stagedRoot}`
        }, {
          pos: 0,
          end: 0,
          code: 9902,
          category: 1,
          text: `parent ${stagedRoot}/packages/a/../d/src/secret-parent.ts`
        }, {
          pos: 0,
          end: 0,
          code: 9902,
          category: 1,
          text: `dot ${stagedRoot}/packages/a/./src/secret-dot.ts`
        }, {
          pos: 0,
          end: 0,
          code: 9902,
          category: 1,
          text: `duplicate ${stagedRoot}/packages/a//src/secret-duplicate.ts`
        }, {
          pos: 0,
          end: 0,
          code: 9902,
          category: 1,
          text: `backslash ${stagedRoot}/packages/a\\..\\d\\src\\secret-backslash.ts`
        }],
        relatedInformation: [{
          pos: 0,
          end: 0,
          code: 9902,
          category: 1,
          text: `sibling ${join(stagedRoot, "packages/d/src/secret.ts")}`
        }]
      }],
      () => module.AnalyzeWorkspaceProjectSessionWithOperations(
        SnapshotFiles([
          ...WorkspacePackage(
            "packages/a",
            "@workspace/a",
            'import { b } from "@workspace/b"\nexport const a = b\n',
            WorkspaceConfig({ "@workspace/b": ["../b/src/index.ts"] })
          ),
          ...WorkspacePackage("packages/b", "@workspace/b", "export const b = 1\n")
        ]),
        { ProjectPrefix: "packages/a", DependencyPrefixes: ["packages/b"] },
        {
          ...base,
          UpdateSnapshot: async (api, canonicalTsconfig) => {
            stagedRoot = dirname(dirname(dirname(canonicalTsconfig)))
            return base.UpdateSnapshot(api, canonicalTsconfig)
          }
        }
      )
    )

    expect(result.SourceFilesChecked).toBe(1)
    expect(result.Issues.filter((issue) => issue.Code === "PROJECT_SESSION_DIAGNOSTIC_PATH_ESCAPE"))
      .toHaveLength(6)
    expect(result.Issues.find((issue) => issue.Code === "TYPESCRIPT_PROGRAM_9902")).toEqual({
      Code: "TYPESCRIPT_PROGRAM_9902",
      Path: "packages/a",
      Message: [
        "target packages/a/src/index.ts",
        "dependency packages/b/src/index.ts",
        "broad packages/a",
        "parent packages/a",
        "dot packages/a",
        "duplicate packages/a",
        "backslash packages/a",
        "sibling packages/a"
      ].join("\n")
    })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(stagedRoot)
    expect(serialized).not.toContain("packages/a/packages/d")
    expect(serialized).not.toContain("secret.ts")
  })

  test("Task 7a rereview regression: redacts raw UNC paths through top, chain and related diagnostics", async () => {
    const module = await LoadProjectSession()
    const root = await RepositoryFixture("likego-workspace-diagnostic-unc-")
    const unc = "\\\\server\\share\\secret.ts"
    const extended = "\\\\?\\C:\\secret.ts"
    const device = "\\\\.\\C:\\device.ts"
    const relatedUnc = "\\\\fileserver\\private\\related.ts"
    const https = "https://safe.example/path.ts"
    const protocolRelative = "//cdn.safe.example/path.ts"
    const result = await WithInjectedProgramDiagnostics(
      () => [{
        pos: 0,
        end: 0,
        code: 9903,
        category: 1,
        text: `top "${unc}" ${https} ${protocolRelative} path=${unc} [${extended}]`,
        messageChain: [{
          pos: 0,
          end: 0,
          code: 9903,
          category: 1,
          text: `chain ${extended} ${device} ${https} {${unc}} :${device} ,${extended}`
        }],
        relatedInformation: [{
          pos: 0,
          end: 0,
          code: 9903,
          category: 1,
          text: `related ${relatedUnc} ${protocolRelative} path=/private/tmp/related-posix.ts [/private/tmp/bracket-posix.ts]`
        }]
      }],
      () => module.AnalyzeWorkspaceProjectSessionWithOperations(
        SnapshotFiles(WorkspacePackage(
          "packages/a",
          "@workspace/a",
          "export const a = true\n"
        )),
        { ProjectPrefix: "packages/a", DependencyPrefixes: [] },
        module.NodeProjectSessionOperations(root)
      )
    )

    expect(result.SourceFilesChecked).toBe(1)
    expect(result.Issues.find((issue) => issue.Code === "TYPESCRIPT_PROGRAM_9903")?.Message).toBe([
      `top "packages/a" ${https} ${protocolRelative} path=packages/a [packages/a]`,
      `chain packages/a packages/a ${https} {packages/a} :packages/a ,packages/a`,
      `related packages/a ${protocolRelative} path=packages/a [packages/a]`
    ].join("\n"))
    expect(result.Issues.filter((issue) => issue.Code === "PROJECT_SESSION_DIAGNOSTIC_PATH_ESCAPE"))
      .toHaveLength(3)
    const serialized = JSON.stringify(result)
    for (const forbidden of ["server", "share", "secret.ts", "device.ts", "fileserver", "private", "tmp", "C:"]) {
      expect(serialized).not.toContain(forbidden)
    }
    expect(serialized).toContain(https)
    expect(serialized).toContain(protocolRelative)
  })

  test("Task 7a rereview regression: preserves complete URLs and relatives but redacts file URIs", async () => {
    const module = await LoadProjectSession()
    const snapshot = SnapshotFiles(WorkspacePackage(
      "packages/a",
      "@workspace/a",
      "export const a = true\n"
    ))

    async function AnalyzeDiagnostic(label: string, code: number, text: string): Promise<{
      readonly SourceFilesChecked: number
      readonly Issues: readonly TestSessionIssue[]
    }> {
      const root = await RepositoryFixture(`likego-workspace-diagnostic-url-${label}-`)
      return WithInjectedProgramDiagnostics(
        () => [{ pos: 0, end: 0, code, category: 1, text }],
        () => module.AnalyzeWorkspaceProjectSessionWithOperations(
          snapshot,
          { ProjectPrefix: "packages/a", DependencyPrefixes: [] },
          module.NodeProjectSessionOperations(root)
        )
      )
    }

    const richUrls = [
      "https://[::1]/path.ts",
      "https://safe.example/?next=/docs/x",
      "//[::1]/path.ts",
      "//cdn.example/#/route",
      "URL:https://[::1]/label-path.ts"
    ].join(" ")
    const urlsAndRelatives = await AnalyzeDiagnostic(
      "preserved",
      9904,
      `urls ${richUrls} relatives ./relative.ts ../parent.ts`
    )
    const fileUris = [
      "file:///private/tmp/file-uri-secret.ts",
      "file://localhost/private/localhost-secret.ts",
      "file://server/share/server-secret.ts",
      "file:///C:/drive-secret.ts",
      "URI:file:///private/tmp/label-secret.ts",
      "path:file://server/share/path-label-secret.ts"
    ]
    const fileResult = await AnalyzeDiagnostic("file-uri", 9905, `files ${fileUris.join(" ")}`)
    expect({ urlsAndRelatives, fileResult }).toEqual({
      urlsAndRelatives: {
        SourceFilesChecked: 1,
        Issues: [{
          Code: "TYPESCRIPT_PROGRAM_9904",
          Path: "packages/a",
          Message: `urls ${richUrls} relatives ./relative.ts ../parent.ts`
        }]
      },
      fileResult: {
        SourceFilesChecked: 1,
        Issues: [{
          Code: "PROJECT_SESSION_DIAGNOSTIC_PATH_ESCAPE",
          Path: "packages/a",
          Message: "TypeScript diagnostic file path is outside the staged project"
        }, {
          Code: "TYPESCRIPT_PROGRAM_9905",
          Path: "packages/a",
          Message: "files file:///packages/a file:///packages/a file:///packages/a file:///packages/a URI:file:///packages/a path:file:///packages/a"
        }]
      }
    })
    expect(JSON.stringify(fileResult)).not.toContain("private")
    for (const forbidden of ["file-uri-secret.ts", "localhost", "server", "drive-secret.ts", "label-secret.ts"]) {
      expect(JSON.stringify(fileResult)).not.toContain(forbidden)
    }
  })

  test("Task 7a rereview regression: validates authority prototypes and data descriptors before reads", async () => {
    const module = await LoadProjectSession()
    const snapshot = SnapshotFiles(WorkspacePackage(
      "packages/a",
      "@workspace/a",
      "export const a = true\n"
    ))
    let getterReads = 0

    function DataAuthority(prototype: object | null, dependencies: unknown): object {
      const authority = Object.create(prototype) as object
      Object.defineProperties(authority, {
        ProjectPrefix: { value: "packages/a", enumerable: true },
        DependencyPrefixes: { value: dependencies, enumerable: true }
      })
      return authority
    }

    const projectAccessor = Object.defineProperties({}, {
      ProjectPrefix: {
        enumerable: true,
        get: () => { getterReads += 1; return "packages/a" }
      },
      DependencyPrefixes: { value: [], enumerable: true }
    })
    const dependenciesAccessor = Object.defineProperties({}, {
      ProjectPrefix: { value: "packages/a", enumerable: true },
      DependencyPrefixes: {
        enumerable: true,
        get: () => { getterReads += 1; return [] }
      }
    })
    const customArray: unknown[] = []
    Object.setPrototypeOf(customArray, Object.create(Array.prototype) as object)
    const extraArray: unknown[] = []
    Object.defineProperty(extraArray, "Extra", { value: true })
    const symbolArray: unknown[] = []
    Object.defineProperty(symbolArray, Symbol("extra"), { value: true })
    const accessorArray: unknown[] = ["packages/b"]
    Object.defineProperty(accessorArray, "0", {
      enumerable: true,
      configurable: true,
      get: () => { getterReads += 1; return "packages/b" }
    })
    const invalidAuthorities = [
      DataAuthority({ marker: true }, []),
      DataAuthority(null, []),
      projectAccessor,
      dependenciesAccessor,
      DataAuthority(Object.prototype, customArray),
      DataAuthority(Object.prototype, extraArray),
      DataAuthority(Object.prototype, symbolArray),
      DataAuthority(Object.prototype, new Array(1)),
      DataAuthority(Object.prototype, accessorArray)
    ]
    const observed: {
      readonly Result: { readonly SourceFilesChecked: number; readonly Issues: readonly TestSessionIssue[] }
      readonly Calls: readonly string[]
    }[] = []

    for (const [index, authority] of invalidAuthorities.entries()) {
      const root = await RepositoryFixture(`likego-workspace-authority-descriptor-${index}-`)
      const base = module.NodeProjectSessionOperations(root)
      const calls: string[] = []
      const result = await module.AnalyzeWorkspaceProjectSessionWithOperations(
        snapshot,
        authority as TestWorkspaceProjectAuthority,
        {
          ...base,
          UpdateSnapshot: async (api, canonicalTsconfig) => {
            calls.push("update")
            return base.UpdateSnapshot(api, canonicalTsconfig)
          }
        }
      )
      observed.push({ Result: result, Calls: calls })
    }

    expect(observed).toEqual(invalidAuthorities.map(() => ({
      Result: {
        SourceFilesChecked: 0,
        Issues: [{
          Code: "PROJECT_SESSION_SCOPE_INVALID",
          Path: "",
          Message: expect.any(String)
        }]
      },
      Calls: []
    })))
    expect(getterReads).toBe(0)

    const frozenRoot = await RepositoryFixture("likego-workspace-authority-frozen-")
    const frozenAuthority = Object.freeze({
      ProjectPrefix: "packages/a",
      DependencyPrefixes: Object.freeze([] as string[])
    })
    expect(await module.AnalyzeWorkspaceProjectSessionWithOperations(
      snapshot,
      frozenAuthority,
      module.NodeProjectSessionOperations(frozenRoot)
    )).toEqual({ SourceFilesChecked: 1, Issues: [] })
  })

  test("Task 7a review regression: binds worker AST text to fatal UTF-8 snapshot text", async () => {
    const module = await LoadProjectSession()
    const expectedIssue = {
      Code: "PROJECT_SESSION_SOURCE_NOT_SNAPSHOT",
      Path: "packages/a/src/index.ts",
      Message: expect.any(String)
    }
    const results: { readonly SourceFilesChecked: number; readonly Issues: readonly TestSessionIssue[] }[] = []

    const changedRoot = await RepositoryFixture("likego-workspace-project-ast-snapshot-")
    const changedBase = module.NodeProjectSessionOperations(changedRoot)
    const changedSource = File("packages/a/src/index.ts", "export const authority = 'snapshot'\n")
    const changedSnapshot = SnapshotFiles([
      File("packages/a/package.json", '{"name":"@workspace/a"}\n'),
      File("packages/a/tsconfig.json", WorkspaceConfig()),
      changedSource
    ])
    results.push(await module.AnalyzeWorkspaceProjectSessionWithOperations(
      changedSnapshot,
      { ProjectPrefix: "packages/a", DependencyPrefixes: [] },
      {
        ...changedBase,
        UpdateSnapshot: async (api, canonicalTsconfig) => {
          const stagedSource = join(dirname(canonicalTsconfig), "src/index.ts")
          await Bun.write(stagedSource, "export const authority = 'worker'\n")
          try {
            return await changedBase.UpdateSnapshot(api, canonicalTsconfig)
          } finally {
            await Bun.write(stagedSource, changedSource.Bytes)
          }
        }
      }
    ))

    const invalidRoot = await RepositoryFixture("likego-workspace-project-invalid-utf8-")
    const invalidSource = BytesFile(
      "packages/a/src/index.ts",
      new Uint8Array([0x65, 0x78, 0x70, 0x6f, 0x72, 0x74, 0x20, 0xc3, 0x28])
    )
    results.push(await module.AnalyzeWorkspaceProjectSessionWithOperations(
      SnapshotFiles([
        File("packages/a/package.json", '{"name":"@workspace/a"}\n'),
        File("packages/a/tsconfig.json", WorkspaceConfig()),
        invalidSource
      ]),
      { ProjectPrefix: "packages/a", DependencyPrefixes: [] },
      module.NodeProjectSessionOperations(invalidRoot)
    ))

    expect(results).toEqual([
      { SourceFilesChecked: 0, Issues: [expectedIssue] },
      { SourceFilesChecked: 0, Issues: [expectedIssue] }
    ])
  })

  test("Task 7a review regression: preserves legacy src/node_modules admission only", async () => {
    const module = await LoadProjectSession()
    const source = "export const local = true\n"
    const legacyRoot = await RepositoryFixture("likego-project-legacy-local-node-modules-")
    const legacy = await module.AnalyzeProjectSessionWithOperations(
      SnapshotFiles([
        File(
          "project/tsconfig.json",
          WorkspaceConfig({}, { files: ["src/node_modules/local.ts"] })
        ),
        File("project/src/node_modules/local.ts", source)
      ]),
      "project",
      module.NodeProjectSessionOperations(legacyRoot)
    )
    expect(legacy).toEqual({ SourceFilesChecked: 1, Issues: [] })

    const workspaceRoot = await RepositoryFixture("likego-workspace-local-node-modules-")
    const workspace = await module.AnalyzeWorkspaceProjectSessionWithOperations(
      SnapshotFiles([
        File("packages/a/package.json", '{"name":"@workspace/a"}\n'),
        File(
          "packages/a/tsconfig.json",
          WorkspaceConfig({}, { files: ["src/node_modules/local.ts"] })
        ),
        File("packages/a/src/node_modules/local.ts", source)
      ]),
      { ProjectPrefix: "packages/a", DependencyPrefixes: [] },
      module.NodeProjectSessionOperations(workspaceRoot)
    )
    expect(workspace).toEqual({
      SourceFilesChecked: 0,
      Issues: [{
        Code: "PROJECT_SESSION_EXTERNAL_SOURCE",
        Path: "packages/a/src/node_modules/local.ts",
        Message: expect.any(String)
      }]
    })
  })

  test("Task 7a review regression: redacts path escapes in real fileless TS6053 diagnostics", async () => {
    const module = await LoadProjectSession()
    const repositoryRoot = await RepositoryFixture("likego-workspace-fileless-diagnostic-repository-")
    const hostRoot = await RepositoryFixture("likego-workspace-fileless-diagnostic-host-")
    const missingHostPath = join(hostRoot, "private", "missing.ts")
    const result = await module.AnalyzeWorkspaceProjectSessionWithOperations(
      SnapshotFiles(WorkspacePackage(
        "packages/a",
        "@workspace/a",
        "export const a = true\n",
        WorkspaceConfig({}, { files: ["src/index.ts", missingHostPath] })
      )),
      { ProjectPrefix: "packages/a", DependencyPrefixes: [] },
      module.NodeProjectSessionOperations(repositoryRoot)
    )

    expect(result.SourceFilesChecked).toBe(1)
    const missingIssue = result.Issues.find((issue) => issue.Code === "TYPESCRIPT_PROGRAM_6053")
    expect(missingIssue).toBeDefined()
    expect(missingIssue?.Path).toBe("packages/a")
    expect(result.Issues.map((issue) => issue.Code))
      .toContain("PROJECT_SESSION_DIAGNOSTIC_PATH_ESCAPE")
    const serialized = JSON.stringify(result)
    for (const forbidden of [
      missingHostPath,
      hostRoot,
      repositoryRoot,
      RepositoryRoot,
      ".artifacts/gates/work"
    ]) expect(serialized).not.toContain(forbidden)
  })

  test("Task 7a review regression: rejects extra workspace authority runtime keys", async () => {
    const module = await LoadProjectSession()
    const root = await RepositoryFixture("likego-workspace-project-extra-authority-key-")
    const calls: string[] = []
    const authority = {
      ProjectPrefix: "packages/a",
      DependencyPrefixes: [],
      Unexpected: true
    }

    const result = await module.AnalyzeWorkspaceProjectSessionWithOperations(
      ValidWorkspaceSnapshot(),
      authority,
      ForbiddenOperations(root, calls)
    )

    expect(result).toEqual({
      SourceFilesChecked: 0,
      Issues: [{
        Code: "PROJECT_SESSION_SCOPE_INVALID",
        Path: "",
        Message: expect.any(String)
      }]
    })
    expect(calls).toEqual([])
    await ExpectEnoent(join(root, ".artifacts"))
  })

  test("stages exactly the selected transitive closure and returns only sorted target sources", async () => {
    const module = await LoadProjectSession()
    const root = await RepositoryFixture("likego-workspace-project-valid-")
    const base = module.NodeProjectSessionOperations(root)
    const openedConfigs: string[] = []
    const operations: TestProjectSessionOperations = {
      ...base,
      UpdateSnapshot: async (api, canonicalTsconfig) => {
        openedConfigs.push(canonicalTsconfig)
        return base.UpdateSnapshot(api, canonicalTsconfig)
      }
    }
    const snapshot = ValidWorkspaceSnapshot()

    const callbackValue = await module.WithWorkspaceProjectSessionWithOperations(
      snapshot,
      ValidWorkspaceAuthority,
      async (session) => {
        expect(session.SourceFiles.map((file) => relative(session.StagedRoot, file.fileName))).toEqual([
          "packages/a/src/index.ts"
        ])
        const sourceNames = (await session.Project.program.getSourceFileNames())
          .map((path) => relative(session.StagedRoot, path).split("\\").join("/"))
        expect(sourceNames).toContain("packages/a/src/index.ts")
        expect(sourceNames).toContain("packages/b/src/index.ts")
        expect(sourceNames).toContain("packages/c/src/index.ts")
        expect(sourceNames).not.toContain("packages/d/src/index.ts")
        await ExpectEnoent(join(session.StagedRoot, "packages/d"))
        return "workspace-callback"
      },
      operations
    )

    expect(callbackValue).toBe("workspace-callback")
    expect(openedConfigs).toHaveLength(1)
    expect(openedConfigs[0]).toEndWith("/packages/a/tsconfig.json")
    expect(await readdir(join(root, ".artifacts/gates/work"))).toEqual([])

    const analyzed = await module.AnalyzeWorkspaceProjectSessionWithOperations(
      snapshot,
      ValidWorkspaceAuthority,
      operations
    )
    expect(analyzed).toEqual({ SourceFilesChecked: 1, Issues: [] })
    expect(openedConfigs).toHaveLength(2)
    expect(await readdir(join(root, ".artifacts/gates/work"))).toEqual([])
  })

  test("preserves isolated selection semantics for the legacy API", async () => {
    const module = await LoadProjectSession()
    const root = await RepositoryFixture("likego-workspace-project-legacy-")
    const snapshot = ValidWorkspaceSnapshot()

    const result = await module.AnalyzeProjectSessionWithOperations(
      snapshot,
      "packages/a",
      module.NodeProjectSessionOperations(root)
    )

    expect(result.SourceFilesChecked).toBe(1)
    expect(result.Issues.map((issue) => issue.Code)).toContain("TYPESCRIPT_SEMANTIC_2307")
    expect(result.Issues.some((issue) => issue.Path === "packages/a/src/index.ts")).toBe(true)
    expect(await readdir(join(root, ".artifacts/gates/work"))).toEqual([])
  })

  test("rejects malformed, unsafe, unordered, duplicate, self and overlapping authority before staging", async () => {
    const module = await LoadProjectSession()
    const root = await RepositoryFixture("likego-workspace-project-scope-")
    const calls: string[] = []
    const operations = ForbiddenOperations(root, calls)
    const authorities: readonly unknown[] = [
      null,
      { ProjectPrefix: "../packages/a", DependencyPrefixes: [] },
      { ProjectPrefix: "packages/a", DependencyPrefixes: "packages/b" },
      { ProjectPrefix: "packages/a", DependencyPrefixes: [17] },
      { ProjectPrefix: "packages/a", DependencyPrefixes: ["packages/c", "packages/b"] },
      { ProjectPrefix: "packages/a", DependencyPrefixes: ["packages/b", "packages/b"] },
      { ProjectPrefix: "packages/a", DependencyPrefixes: ["packages/a"] },
      { ProjectPrefix: "packages/a", DependencyPrefixes: ["packages/b", "packages/b/nested"] },
      { ProjectPrefix: "packages/a", DependencyPrefixes: ["packages/b", "packages\\c"] }
    ]

    for (const authority of authorities) {
      const result = await module.AnalyzeWorkspaceProjectSessionWithOperations(
        ValidWorkspaceSnapshot(),
        authority as TestWorkspaceProjectAuthority,
        operations
      )
      expect(result.SourceFilesChecked).toBe(0)
      expect(result.Issues).toEqual([{
        Code: "PROJECT_SESSION_SCOPE_INVALID",
        Path: expect.any(String),
        Message: expect.any(String)
      }])
    }
    expect(calls).toEqual([])
    await ExpectEnoent(join(root, ".artifacts"))
  })

  test("requires each selected package manifest, config and source snapshot byte", async () => {
    const module = await LoadProjectSession()
    const complete = SnapshotFiles([
      ...WorkspacePackage(
        "packages/a",
        "@workspace/a",
        'import { b } from "@workspace/b"\nexport const a = b\n',
        WorkspaceConfig({ "@workspace/b": ["../b/src/index.ts"] })
      ),
      ...WorkspacePackage("packages/b", "@workspace/b", "export const b = 1\n")
    ])
    const authority = {
      ProjectPrefix: "packages/a",
      DependencyPrefixes: ["packages/b"]
    }
    const missingCases = [
      { removed: "packages/a/package.json", Path: "packages/a/package.json" },
      { removed: "packages/a/tsconfig.json", Path: "packages/a/tsconfig.json" },
      { removed: "packages/a/src/index.ts", Path: "packages/a/src" },
      { removed: "packages/b/package.json", Path: "packages/b/package.json" },
      { removed: "packages/b/tsconfig.json", Path: "packages/b/tsconfig.json" },
      { removed: "packages/b/src/index.ts", Path: "packages/b/src" }
    ] as const

    for (const item of missingCases) {
      const root = await RepositoryFixture(`likego-workspace-project-missing-${basename(item.removed)}-`)
      const calls: string[] = []
      const snapshot = SnapshotFiles(complete.Files.filter((file) => file.Path !== item.removed))
      const result = await module.AnalyzeWorkspaceProjectSessionWithOperations(
        snapshot,
        authority,
        ForbiddenOperations(root, calls)
      )
      expect(result).toEqual({
        SourceFilesChecked: 0,
        Issues: [{
          Code: "PROJECT_SESSION_INPUT_MISSING",
          Path: item.Path,
          Message: expect.any(String)
        }]
      })
      expect(calls).toEqual([])
      await ExpectEnoent(join(root, ".artifacts"))
    }
  })

  test("fails closed on unselected, unsnapshotted, changed and node_modules program sources", async () => {
    const module = await LoadProjectSession()

    const unselectedRoot = await RepositoryFixture("likego-workspace-project-unselected-")
    const unselectedBase = module.NodeProjectSessionOperations(unselectedRoot)
    const unselectedSnapshot = ValidWorkspaceSnapshot({
      ASource: 'import { unrelated } from "@workspace/d"\nexport const a = unrelated\n',
      AConfig: WorkspaceConfig({ "@workspace/d": ["../d/src/index.ts"] })
    })
    const unselected = await module.AnalyzeWorkspaceProjectSessionWithOperations(
      unselectedSnapshot,
      { ProjectPrefix: "packages/a", DependencyPrefixes: [] },
      {
        ...unselectedBase,
        UpdateSnapshot: async (api, canonicalTsconfig) => {
          const stagedRoot = dirname(dirname(dirname(canonicalTsconfig)))
          await Bun.write(
            join(stagedRoot, "packages/d/src/index.ts"),
            "export const unrelated = true\n"
          )
          return unselectedBase.UpdateSnapshot(api, canonicalTsconfig)
        }
      }
    )
    expect(unselected).toEqual({
      SourceFilesChecked: 0,
      Issues: [{
        Code: "PROJECT_SESSION_SOURCE_UNAUTHORIZED",
        Path: "packages/d/src/index.ts",
        Message: expect.any(String)
      }]
    })

    for (const kind of ["created", "changed"] as const) {
      const root = await RepositoryFixture(`likego-workspace-project-not-snapshot-${kind}-`)
      const base = module.NodeProjectSessionOperations(root)
      const snapshot = SnapshotFiles(WorkspacePackage(
        "packages/a",
        "@workspace/a",
        "export const a = 1\n"
      ))
      const result = await module.AnalyzeWorkspaceProjectSessionWithOperations(
        snapshot,
        { ProjectPrefix: "packages/a", DependencyPrefixes: [] },
        {
          ...base,
          UpdateSnapshot: async (api, canonicalTsconfig) => {
            const sourceRoot = join(dirname(canonicalTsconfig), "src")
            if (kind === "created") {
              await Bun.write(join(sourceRoot, "created.ts"), "export const created = true\n")
              return base.UpdateSnapshot(api, canonicalTsconfig)
            }
            const workerSnapshot = await base.UpdateSnapshot(api, canonicalTsconfig)
            await Bun.write(join(sourceRoot, "index.ts"), "export const a = 2\n")
            return workerSnapshot
          }
        }
      )
      expect(result.SourceFilesChecked).toBe(0)
      expect(result.Issues).toEqual([{
        Code: "PROJECT_SESSION_SOURCE_NOT_SNAPSHOT",
        Path: `packages/a/src/${kind === "created" ? "created.ts" : "index.ts"}`,
        Message: expect.any(String)
      }])
    }

    const externalRoot = await RepositoryFixture("likego-workspace-project-external-")
    const externalSnapshot = SnapshotFiles(WorkspacePackage(
      "packages/a",
      "@workspace/a",
      'import { dependency } from "package-dependency"\nexport const a = dependency\n',
      WorkspaceConfig(),
      [
        File(
          "packages/a/node_modules/package-dependency/package.json",
          '{"name":"package-dependency","types":"index.d.ts"}\n'
        ),
        File(
          "packages/a/node_modules/package-dependency/index.d.ts",
          "export declare const dependency: number\n"
        )
      ]
    ))
    const external = await module.AnalyzeWorkspaceProjectSessionWithOperations(
      externalSnapshot,
      { ProjectPrefix: "packages/a", DependencyPrefixes: [] },
      module.NodeProjectSessionOperations(externalRoot)
    )
    expect(external).toEqual({
      SourceFilesChecked: 0,
      Issues: [{
        Code: "PROJECT_SESSION_EXTERNAL_SOURCE",
        Path: "packages/a/node_modules/package-dependency/index.d.ts",
        Message: expect.any(String)
      }]
    })
  })

  test("requires at least one admitted target source even when a dependency is admitted", async () => {
    const module = await LoadProjectSession()
    const root = await RepositoryFixture("likego-workspace-project-target-zero-")
    const snapshot = SnapshotFiles([
      ...WorkspacePackage(
        "packages/a",
        "@workspace/a",
        "export const unused = true\n",
        WorkspaceConfig(
          { "@workspace/b": ["../b/src/index.ts"] },
          { files: ["../b/src/index.ts"] }
        )
      ),
      ...WorkspacePackage("packages/b", "@workspace/b", "export const b = 1\n")
    ])

    const result = await module.AnalyzeWorkspaceProjectSessionWithOperations(
      snapshot,
      { ProjectPrefix: "packages/a", DependencyPrefixes: ["packages/b"] },
      module.NodeProjectSessionOperations(root)
    )

    expect(result).toEqual({
      SourceFilesChecked: 0,
      Issues: [{
        Code: "PROJECT_SESSION_SOURCE_ZERO",
        Path: "packages/a/src",
        Message: expect.any(String)
      }]
    })
    expect(await readdir(join(root, ".artifacts/gates/work"))).toEqual([])
  })

  test("maps dependency syntactic, semantic and related diagnostic paths without host leakage", async () => {
    const module = await LoadProjectSession()
    for (const diagnostic of [
      { family: "TYPESCRIPT_SYNTACTIC_", source: "export const broken = ;\n" },
      { family: "TYPESCRIPT_SEMANTIC_", source: "export const broken: string = 1\n" }
    ] as const) {
      const root = await RepositoryFixture(`likego-workspace-project-diagnostic-${diagnostic.family}-`)
      const snapshot = SnapshotFiles([
        ...WorkspacePackage(
          "packages/a",
          "@workspace/a",
          'import { broken } from "@workspace/b"\nexport const a = broken\n',
          WorkspaceConfig({ "@workspace/b": ["../b/src/index.ts"] })
        ),
        ...WorkspacePackage("packages/b", "@workspace/b", diagnostic.source)
      ])
      const result = await module.AnalyzeWorkspaceProjectSessionWithOperations(
        snapshot,
        { ProjectPrefix: "packages/a", DependencyPrefixes: ["packages/b"] },
        module.NodeProjectSessionOperations(root)
      )
      const familyIssues = result.Issues.filter((issue) => issue.Code.startsWith(diagnostic.family))
      expect(result.SourceFilesChecked).toBe(1)
      expect(familyIssues.length).toBeGreaterThan(0)
      expect(familyIssues.every((issue) => issue.Path === "packages/b/src/index.ts")).toBe(true)
      const serialized = JSON.stringify(result)
      expect(serialized).not.toContain(root)
      expect(serialized).not.toContain(RepositoryRoot)
      expect(serialized).not.toContain(".artifacts/gates/work")
    }

    const relatedRoot = await RepositoryFixture("likego-workspace-project-diagnostic-related-")
    const relatedSnapshot = ValidWorkspaceSnapshot({
      ASource: [
        'import "@workspace/b"',
        'import "@workspace/c"',
        "export const a = true"
      ].join("\n"),
      BSource: "declare global { interface WorkspaceMerge { value: string } }\nexport {}\n",
      CSource: "declare global { interface WorkspaceMerge { value: number } }\nexport {}\n"
    })
    const related = await module.AnalyzeWorkspaceProjectSessionWithOperations(
      relatedSnapshot,
      ValidWorkspaceAuthority,
      module.NodeProjectSessionOperations(relatedRoot)
    )
    const relatedIssue = related.Issues.find((issue) => issue.Code === "TYPESCRIPT_SEMANTIC_2717")
    expect(relatedIssue).toBeDefined()
    expect(relatedIssue?.Path).toMatch(/^packages\/[bc]\/src\/index\.ts$/)
    expect(relatedIssue?.Message).toMatch(/packages\/[bc]\/src\/index\.ts/)
    expect(JSON.stringify(related)).not.toContain(relatedRoot)
  })

  test("keeps diagnostic escapes stable for workspace sessions", async () => {
    const module = await LoadProjectSession()
    const root = await RepositoryFixture("likego-workspace-project-diagnostic-escape-")
    const snapshot = SnapshotFiles(WorkspacePackage(
      "packages/a",
      "@workspace/a",
      "export {}\ndeclare global { type Array<T> = T }\n"
    ))

    const result = await module.AnalyzeWorkspaceProjectSessionWithOperations(
      snapshot,
      { ProjectPrefix: "packages/a", DependencyPrefixes: [] },
      module.NodeProjectSessionOperations(root)
    )

    expect(result.SourceFilesChecked).toBe(1)
    expect(result.Issues.map((issue) => issue.Code))
      .toContain("PROJECT_SESSION_DIAGNOSTIC_PATH_ESCAPE")
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(root)
    expect(serialized).not.toContain(RepositoryRoot)
    expect(serialized).not.toContain("node_modules")
  })

  test("binds workspace sessions to the explicit repository root despite later cwd changes", async () => {
    const module = await LoadProjectSession()
    const container = await RepositoryFixture("likego-workspace-project-root-")
    const root = join(container, "repository")
    const later = join(container, "later")
    await mkdir(root)
    await mkdir(later)
    const operations = module.NodeProjectSessionOperations(root)
    const snapshot = SnapshotFiles(WorkspacePackage(
      "packages/a",
      "@workspace/a",
      "export const a = 1\n"
    ))
    const previousCwd = process.cwd()
    let stagedRoot = ""
    try {
      process.chdir(later)
      await module.WithWorkspaceProjectSessionWithOperations(
        snapshot,
        { ProjectPrefix: "packages/a", DependencyPrefixes: [] },
        async (session) => { stagedRoot = session.StagedRoot },
        operations
      )
    } finally {
      process.chdir(previousCwd)
    }

    expect(stagedRoot.startsWith(`${await realpath(root)}/`)).toBe(true)
    await ExpectEnoent(join(later, ".artifacts"))
    expect(await readdir(join(root, ".artifacts/gates/work"))).toEqual([])
  })

  test("settles workspace worker, callback and cleanup failures through the shared lifecycle", async () => {
    const module = await LoadProjectSession()
    const snapshot = SnapshotFiles(WorkspacePackage(
      "packages/a",
      "@workspace/a",
      "export const a = 1\n"
    ))
    const authority = { ProjectPrefix: "packages/a", DependencyPrefixes: [] }

    const callbackRoot = await RepositoryFixture("likego-workspace-project-cleanup-")
    const callbackBase = module.NodeProjectSessionOperations(callbackRoot)
    const callbackPrimary = new Error("workspace callback primary")
    const snapshotFault = new Error("workspace snapshot cleanup")
    const apiFault = new Error("workspace api cleanup")
    const removeFault = new Error("workspace remove cleanup")
    const cleanupOrder: string[] = []
    let callbackCaught: unknown
    try {
      await module.WithWorkspaceProjectSessionWithOperations(
        snapshot,
        authority,
        async () => { throw callbackPrimary },
        {
          RepositoryRoot: callbackBase.RepositoryRoot,
          UpdateSnapshot: callbackBase.UpdateSnapshot,
          DisposeSnapshot: async (workerSnapshot) => {
            cleanupOrder.push("snapshot.dispose")
            await callbackBase.DisposeSnapshot(workerSnapshot)
            throw snapshotFault
          },
          CloseAPI: async (api) => {
            cleanupOrder.push("api.close")
            await callbackBase.CloseAPI(api)
            throw apiFault
          },
          RemoveStaging: async (path) => {
            cleanupOrder.push("remove-staging")
            await callbackBase.RemoveStaging(path)
            throw removeFault
          }
        }
      )
    } catch (error) {
      callbackCaught = error
    }
    expect(callbackCaught).toBeInstanceOf(AggregateError)
    expect((callbackCaught as AggregateError).errors).toEqual([
      callbackPrimary,
      snapshotFault,
      apiFault,
      removeFault
    ])
    expect(cleanupOrder).toEqual(["snapshot.dispose", "api.close", "remove-staging"])
    expect(await readdir(join(callbackRoot, ".artifacts/gates/work"))).toEqual([])

    const workerRoot = await RepositoryFixture("likego-workspace-project-worker-")
    const workerBase = module.NodeProjectSessionOperations(workerRoot)
    const workerPrimary = new Error("workspace worker primary")
    const workerOrder: string[] = []
    let workerCaught: unknown
    try {
      await module.WithWorkspaceProjectSessionWithOperations(
        snapshot,
        authority,
        async () => { throw new Error("workspace callback must not run") },
        {
          ...CleanObservedOperations(workerBase, workerOrder),
          UpdateSnapshot: async (api, canonicalTsconfig) => {
            await api.parseConfigFile(canonicalTsconfig)
            throw workerPrimary
          }
        }
      )
    } catch (error) {
      workerCaught = error
    }
    expect(workerCaught).toBe(workerPrimary)
    expect(workerOrder).toEqual(["api.close", "remove-staging"])
    expect(await readdir(join(workerRoot, ".artifacts/gates/work"))).toEqual([])
  })
})
