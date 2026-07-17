import { createHash } from "node:crypto"
import { lstat, rm, symlink } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import { isDeepStrictEqual } from "node:util"
import {
  NodeProjectSessionOperations,
  WithProjectSessionWithOperations,
  type ProjectSessionOperations
} from "./project-session.ts"
import {
  EmitGateResultWithDependencies,
  NodeAtomicWriterOperations,
  RunGate,
  SnapshotInputs,
  WriteProcessStderr,
  WriteProcessStdout,
  type InputSnapshot,
  type SnapshotFile
} from "../gates/result.ts"

interface ProbeCase {
  readonly scenario: ProbeScenario
  readonly path: string
}

interface ProbeDescriptor {
  readonly schemaVersion: 1
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

interface CanonicalProbeContract {
  readonly projectPrefix: string
  readonly virtualInputsSha256: string
  readonly actions: ProbeDescriptor["actions"]
  readonly expected: ProbeDescriptor["expected"]
}

export interface ProjectSessionProbeResult {
  readonly schemaVersion: 1
  readonly scenario: string
  readonly outcome: "success" | "primary-error" | "aggregate-error"
  readonly cleanupOrder: readonly string[]
  readonly errorOrder: readonly string[]
  readonly stageReadback: "absent" | "retained-then-harness-removed" | "not-acquired"
}

export interface ProjectSessionProbeExecution {
  readonly ExitCode: 0 | 7
  readonly Result: ProjectSessionProbeResult
  readonly Failure:
    | { readonly Thrown: false }
    | { readonly Thrown: true; readonly Value: unknown }
}

export interface ProjectSessionProbeIO {
  readonly WriteStdout: (value: string) => void | Promise<void>
  readonly WriteStderr: (value: string) => void | Promise<void>
}

export interface ProjectSessionProbeReadbackOperations {
  readonly Lstat: (path: string) => Promise<unknown>
}

interface ParsedArguments {
  readonly Mode: "lifecycle" | "gate"
  readonly Scenario: ProbeScenario
  readonly Root: string
  readonly RunId?: string
}

const ProbeRoot = "tools/boundaries/probes/project-session"
const ProbeCasesPath = `${ProbeRoot}/cases.json`
const Encoder = new TextEncoder()
const Decoder = new TextDecoder("utf-8", { fatal: true })
const Scenarios = [
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
type ProbeScenario = (typeof Scenarios)[number]
const DefaultIO: ProjectSessionProbeIO = {
  WriteStdout: WriteProcessStdout,
  WriteStderr: WriteProcessStderr
}
const NodeReadbackOperations: ProjectSessionProbeReadbackOperations = {
  Lstat: lstat
}

const VirtualInputHashes: Readonly<Record<ProbeScenario, string>> = {
  success: "3f36de135d47804c908599299de232eabf5a0aeaa1ce15019e61f9438b3c5349",
  "primary-error": "277a42f43e5555617e14c2669365c33c115600f07c79401a2ae54ce3b8b289e0",
  "primary-undefined": "3f36de135d47804c908599299de232eabf5a0aeaa1ce15019e61f9438b3c5349",
  "materialization-failure": "a56a0154e9671a168c5aeb8b2200cab6ec4f230682fc3b3d008e8579b8d2d6f3",
  "update-before-snapshot": "277a42f43e5555617e14c2669365c33c115600f07c79401a2ae54ce3b8b289e0",
  "update-after-snapshot": "277a42f43e5555617e14c2669365c33c115600f07c79401a2ae54ce3b8b289e0",
  "admission-failure": "311470c0dc3a97655cc28591e9d707abfd7704d6372ea5bac64b7ffc52726ba9",
  "snapshot-cleanup": "277a42f43e5555617e14c2669365c33c115600f07c79401a2ae54ce3b8b289e0",
  "api-cleanup": "277a42f43e5555617e14c2669365c33c115600f07c79401a2ae54ce3b8b289e0",
  "remove-before": "277a42f43e5555617e14c2669365c33c115600f07c79401a2ae54ce3b8b289e0",
  "remove-after": "277a42f43e5555617e14c2669365c33c115600f07c79401a2ae54ce3b8b289e0",
  "primary-plus-all-cleanups": "277a42f43e5555617e14c2669365c33c115600f07c79401a2ae54ce3b8b289e0",
  "value-plus-all-cleanups": "277a42f43e5555617e14c2669365c33c115600f07c79401a2ae54ce3b8b289e0",
  "project-count-zero": "ac1e9df2bd6a00647403d0bd0b54abaf451fee81ec065427035a4137a9cf031d",
  "project-count-multiple": "0a6e8ce3a4c751add16781a3141b8576ce0d634845aa81f2648e92f9d6f28c63",
  "project-identity": "0a6e8ce3a4c751add16781a3141b8576ce0d634845aa81f2648e92f9d6f28c63",
  "input-invalid-prefix": "598b9c64d03cb71761e64be7fe938f71728e1b37f9a19d6ada348ee39a032190",
  "input-invalid-path": "602a1927a1f6b47d59ea08eddfb2bc12aef558e03ef05331c08f801cab7f0527",
  "source-realpath-escape": "190928c40fbc78865ff06e069ce5f5e1a8ceaafef5a588d65068a8c798a44f02",
  "external-source": "cc8c501837c6ece9d62e9a555a88eabbf32a3816181e4ee110879f2b90b043d1"
}

const NormalStage = { kind: "normal", path: "", targetPath: "" } as const
const NormalUpdate = { kind: "normal", path: "" } as const
const DelegateCleanup = { snapshot: "delegate", api: "delegate", remove: "delegate" } as const
const AllCleanupOrder = ["snapshot.dispose", "api.close", "remove-staging"] as const
const FailGate = { exitCode: 1, status: "fail", checkIds: ["GATE_INTERNAL_ERROR"] } as const
const OverlongMaterializationPath = "project/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/value.ts"

function Sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

function CompareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
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

function IsProbeScenario(value: string): value is ProbeScenario {
  return (Scenarios as readonly string[]).includes(value)
}

function Actions(
  callback: string = "return-value",
  stage: ProbeDescriptor["actions"]["stage"] = NormalStage,
  update: ProbeDescriptor["actions"]["update"] = NormalUpdate,
  cleanup: ProbeDescriptor["actions"]["cleanup"] = DelegateCleanup
): ProbeDescriptor["actions"] {
  return { stage, update, callback: { kind: callback }, cleanup }
}

function Lifecycle(
  exitCode: number,
  outcome: string,
  cleanupOrder: readonly string[],
  errorOrder: readonly string[],
  stageReadback: string
): ProbeDescriptor["expected"]["lifecycle"] {
  return { exitCode, outcome, cleanupOrder, errorOrder, stageReadback }
}

function ExpectedActions(scenario: ProbeScenario): ProbeDescriptor["actions"] {
  if (scenario === "primary-error") return Actions("throw-error")
  if (scenario === "primary-undefined") return Actions("throw-undefined")
  if (scenario === "materialization-failure") {
    return Actions("return-value", {
      kind: "materialization-failure",
      path: OverlongMaterializationPath,
      targetPath: ""
    })
  }
  if (scenario === "update-before-snapshot") {
    return Actions("return-value", NormalStage, { kind: "throw-before-snapshot", path: "" })
  }
  if (scenario === "update-after-snapshot") {
    return Actions("return-value", NormalStage, { kind: "throw-after-snapshot", path: "" })
  }
  if (scenario === "snapshot-cleanup") {
    return Actions("return-value", NormalStage, NormalUpdate, {
      snapshot: "delegate-then-throw",
      api: "delegate",
      remove: "delegate"
    })
  }
  if (scenario === "api-cleanup") {
    return Actions("return-value", NormalStage, NormalUpdate, {
      snapshot: "delegate",
      api: "delegate-then-throw",
      remove: "delegate"
    })
  }
  if (scenario === "remove-before") {
    return Actions("return-value", NormalStage, NormalUpdate, {
      snapshot: "delegate",
      api: "delegate",
      remove: "throw-before-delegate"
    })
  }
  if (scenario === "remove-after") {
    return Actions("return-value", NormalStage, NormalUpdate, {
      snapshot: "delegate",
      api: "delegate",
      remove: "delegate-then-throw"
    })
  }
  if (scenario === "primary-plus-all-cleanups") {
    return Actions("throw-error", NormalStage, NormalUpdate, {
      snapshot: "delegate-then-throw",
      api: "delegate-then-throw",
      remove: "delegate-then-throw"
    })
  }
  if (scenario === "value-plus-all-cleanups") {
    return Actions("return-value", NormalStage, NormalUpdate, {
      snapshot: "delegate-then-throw",
      api: "delegate-then-throw",
      remove: "delegate-then-throw"
    })
  }
  if (scenario === "project-count-zero") {
    return Actions("return-value", NormalStage, { kind: "project-count-zero", path: "project/missing/tsconfig.json" })
  }
  if (scenario === "project-count-multiple") {
    return Actions("return-value", NormalStage, {
      kind: "project-count-multiple",
      path: "project/alternate/tsconfig.json"
    })
  }
  if (scenario === "project-identity") {
    return Actions("return-value", NormalStage, {
      kind: "project-identity",
      path: "project/alternate/tsconfig.json"
    })
  }
  if (scenario === "source-realpath-escape") {
    return Actions("return-value", {
      kind: "source-realpath-escape",
      path: "project/src/index.ts",
      targetPath: "project/escape-target.ts"
    })
  }
  return Actions()
}

function ExpectedLifecycle(scenario: ProbeScenario): ProbeDescriptor["expected"]["lifecycle"] {
  if (scenario === "success") return Lifecycle(0, "success", AllCleanupOrder, [], "absent")
  if (scenario === "input-invalid-prefix" || scenario === "input-invalid-path") {
    return Lifecycle(7, "primary-error", [], ["primary"], "not-acquired")
  }
  if (scenario === "materialization-failure") {
    return Lifecycle(7, "primary-error", ["remove-staging"], ["primary"], "absent")
  }
  if (scenario === "update-before-snapshot" || scenario === "update-after-snapshot") {
    return Lifecycle(7, "primary-error", ["api.close", "remove-staging"], ["primary"], "absent")
  }
  if (scenario === "snapshot-cleanup") {
    return Lifecycle(7, "aggregate-error", AllCleanupOrder, ["snapshot.dispose"], "absent")
  }
  if (scenario === "api-cleanup") {
    return Lifecycle(7, "aggregate-error", AllCleanupOrder, ["api.close"], "absent")
  }
  if (scenario === "remove-before") {
    return Lifecycle(7, "aggregate-error", AllCleanupOrder, ["remove-staging"], "retained-then-harness-removed")
  }
  if (scenario === "remove-after") {
    return Lifecycle(7, "aggregate-error", AllCleanupOrder, ["remove-staging"], "absent")
  }
  if (scenario === "primary-plus-all-cleanups") {
    return Lifecycle(7, "aggregate-error", AllCleanupOrder, [
      "primary",
      "snapshot.dispose",
      "api.close",
      "remove-staging"
    ], "absent")
  }
  if (scenario === "value-plus-all-cleanups") {
    return Lifecycle(7, "aggregate-error", AllCleanupOrder, [
      "snapshot.dispose",
      "api.close",
      "remove-staging"
    ], "absent")
  }
  return Lifecycle(7, "primary-error", AllCleanupOrder, ["primary"], "absent")
}

function ExpectedContract(scenario: ProbeScenario): CanonicalProbeContract {
  const success = scenario === "success"
  return {
    projectPrefix: scenario === "input-invalid-prefix" ? "../project" : "project",
    virtualInputsSha256: VirtualInputHashes[scenario],
    actions: ExpectedActions(scenario),
    expected: {
      lifecycle: ExpectedLifecycle(scenario),
      gate: success
        ? { exitCode: 0, status: "pass", checkIds: ["PROJECT_SESSION_PROBE_PASS"] }
        : FailGate
    }
  }
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
  const cases: { readonly scenario: string; readonly path: string }[] = []
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
  if (
    scenarios.size !== Scenarios.length
    || Scenarios.some((scenario) => !scenarios.has(scenario))
  ) throw new Error("probe inventory must contain the canonical scenario set")
  const canonical = new Map<string, ProbeScenario>(Scenarios.map((scenario) => [scenario, scenario]))
  return cases.map((item) => ({
    scenario: canonical.get(item.scenario) as ProbeScenario,
    path: item.path
  }))
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

function VirtualInputsSha256(files: ProbeDescriptor["virtualFiles"]): string {
  const inventory = [...files]
    .sort((left, right) => CompareCodeUnits(left.path, right.path))
    .map((file) => `${file.path}\0${Sha256(Encoder.encode(file.utf8))}\n`)
    .join("")
  return Sha256(inventory)
}

function AdmitProbeDescriptor(descriptor: ProbeDescriptor, scenario: ProbeScenario): void {
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

  const contract = {
    projectPrefix: descriptor.projectPrefix,
    virtualInputsSha256: VirtualInputsSha256(descriptor.virtualFiles),
    actions: descriptor.actions,
    expected: descriptor.expected
  }
  if (!isDeepStrictEqual(contract, ExpectedContract(scenario))) {
    throw new Error("probe descriptor input, actions and expected outcome do not match its scenario")
  }
}

function RequireSnapshotIntegrity(snapshot: InputSnapshot): void {
  const paths = new Set<string>()
  const files = [...snapshot.Files].sort((left, right) => CompareCodeUnits(left.Path, right.Path))
  for (const file of files) {
    if (paths.has(file.Path) || !(file.Bytes instanceof Uint8Array) || Sha256(file.Bytes) !== file.Sha256) {
      throw new Error("probe snapshot file integrity is invalid")
    }
    paths.add(file.Path)
  }
  const inventory = files.map((file) => `${file.Path}\0${file.Sha256}\n`).join("")
  if (Sha256(inventory) !== snapshot.Sha256) throw new Error("probe snapshot inventory hash is invalid")
}

function SelectProbe(snapshot: InputSnapshot, scenario: string): ProbeDescriptor {
  RequireSnapshotIntegrity(snapshot)
  const files = new Map(snapshot.Files.map((file) => [file.Path, file]))
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
  AdmitProbeDescriptor(descriptor, selected[0]!.scenario)
  return descriptor
}

function VirtualSnapshot(descriptor: ProbeDescriptor): InputSnapshot {
  const Files = descriptor.virtualFiles.map((file) => {
    const Bytes = Encoder.encode(file.utf8)
    return {
      Path: file.path,
      RealPath: `/project-session-probe/${file.path}`,
      Sha256: Sha256(Bytes),
      Bytes
    }
  }).sort((left, right) => CompareCodeUnits(left.Path, right.Path))
  return {
    Sha256: Sha256(Files.map((file) => `${file.Path}\0${file.Sha256}\n`).join("")),
    Files
  }
}

function ErrorCode(error: unknown): string | null {
  return IsRecord(error) && typeof error.code === "string" ? error.code : null
}

async function Exists(
  path: string,
  readback: ProjectSessionProbeReadbackOperations
): Promise<boolean> {
  try {
    await readback.Lstat(path)
    return true
  } catch (error) {
    if (ErrorCode(error) === "ENOENT") return false
    throw error
  }
}

function ErrorOrder(
  failure: unknown,
  aggregate: boolean,
  snapshotFault: Error,
  apiFault: Error,
  removeFault: Error
): readonly string[] {
  const errors = aggregate && failure instanceof AggregateError ? failure.errors : [failure]
  return errors.map((error: unknown) => {
    if (error === snapshotFault) return "snapshot.dispose"
    if (error === apiFault) return "api.close"
    if (error === removeFault) return "remove-staging"
    return "primary"
  })
}

async function ReadStageState(
  stagedRoot: string | null,
  base: ProjectSessionOperations,
  removeBefore: boolean,
  readback: ProjectSessionProbeReadbackOperations
): Promise<ProjectSessionProbeResult["stageReadback"]> {
  if (stagedRoot === null) return "not-acquired"
  const nonce = dirname(stagedRoot)
  const stageExists = await Exists(stagedRoot, readback)
  const nonceExists = await Exists(nonce, readback)
  if (!stageExists && !nonceExists) return "absent"
  if (removeBefore && stageExists && nonceExists) {
    await base.RemoveStaging(stagedRoot)
    if (await Exists(stagedRoot, readback) || await Exists(nonce, readback)) {
      throw new Error("project session probe harness cleanup readback failed")
    }
    return "retained-then-harness-removed"
  }
  throw new Error("project session probe stage readback is partial or unexpected")
}

export async function EvaluateProjectSessionProbe(
  snapshot: InputSnapshot,
  scenario: string,
  repositoryRoot: string
): Promise<ProjectSessionProbeExecution> {
  return EvaluateProjectSessionProbeWithReadbackOperations(
    snapshot,
    scenario,
    repositoryRoot,
    NodeReadbackOperations
  )
}

export async function EvaluateProjectSessionProbeWithReadbackOperations(
  snapshot: InputSnapshot,
  scenario: string,
  repositoryRoot: string,
  readback: ProjectSessionProbeReadbackOperations
): Promise<ProjectSessionProbeExecution> {
  const descriptor = SelectProbe(snapshot, scenario)
  const input = VirtualSnapshot(descriptor)
  const base = NodeProjectSessionOperations(repositoryRoot)
  const cleanupOrder: string[] = []
  const primaryFault = new Error("project session probe primary")
  const snapshotFault = new Error("project session probe snapshot cleanup")
  const apiFault = new Error("project session probe api cleanup")
  const removeFault = new Error("project session probe remove cleanup")
  let stagedRoot: string | null = null
  const operations: ProjectSessionOperations = {
    RepositoryRoot: base.RepositoryRoot,
    UpdateSnapshot: async (api, canonicalTsconfig) => {
      stagedRoot = dirname(dirname(canonicalTsconfig))
      const stage = descriptor.actions.stage
      if (stage.kind === "source-realpath-escape") {
        const source = join(stagedRoot, ...stage.path.split("/"))
        const target = join(stagedRoot, ...stage.targetPath.split("/"))
        await rm(source)
        await symlink(relative(dirname(source), target), source)
      }
      const update = descriptor.actions.update
      if (update.kind === "throw-before-snapshot") {
        await api.parseConfigFile(canonicalTsconfig)
        throw primaryFault
      }
      if (update.kind === "throw-after-snapshot") {
        await base.UpdateSnapshot(api, canonicalTsconfig)
        throw primaryFault
      }
      if (update.kind === "project-count-zero") {
        return api.updateSnapshot({ openProjects: [join(stagedRoot, ...update.path.split("/"))] })
      }
      if (update.kind === "project-count-multiple") {
        return api.updateSnapshot({
          openProjects: [canonicalTsconfig, join(stagedRoot, ...update.path.split("/"))]
        })
      }
      if (update.kind === "project-identity") {
        return api.updateSnapshot({ openProjects: [join(stagedRoot, ...update.path.split("/"))] })
      }
      return base.UpdateSnapshot(api, canonicalTsconfig)
    },
    DisposeSnapshot: async (workerSnapshot) => {
      cleanupOrder.push("snapshot.dispose")
      await base.DisposeSnapshot(workerSnapshot)
      if (descriptor.actions.cleanup.snapshot === "delegate-then-throw") throw snapshotFault
    },
    CloseAPI: async (api) => {
      cleanupOrder.push("api.close")
      await base.CloseAPI(api)
      if (descriptor.actions.cleanup.api === "delegate-then-throw") throw apiFault
    },
    RemoveStaging: async (path) => {
      stagedRoot = path
      cleanupOrder.push("remove-staging")
      if (descriptor.actions.cleanup.remove === "throw-before-delegate") throw removeFault
      await base.RemoveStaging(path)
      if (descriptor.actions.cleanup.remove === "delegate-then-throw") throw removeFault
    }
  }

  let failure: unknown
  let thrown = false
  try {
    await WithProjectSessionWithOperations(
      input,
      descriptor.projectPrefix,
      async () => {
        if (descriptor.actions.callback.kind === "throw-error") throw primaryFault
        if (descriptor.actions.callback.kind === "throw-undefined") throw undefined
        return "project session probe value"
      },
      operations
    )
  } catch (error) {
    thrown = true
    failure = error
  }

  const outcome = !thrown
    ? "success"
    : failure instanceof AggregateError
      ? "aggregate-error"
      : "primary-error"
  const stageReadback = await ReadStageState(
    stagedRoot,
    base,
    descriptor.actions.cleanup.remove === "throw-before-delegate",
    readback
  )
  const result: ProjectSessionProbeResult = {
    schemaVersion: 1,
    scenario,
    outcome,
    cleanupOrder,
    errorOrder: thrown
      ? ErrorOrder(failure, outcome === "aggregate-error", snapshotFault, apiFault, removeFault)
      : [],
    stageReadback
  }
  const expected = descriptor.expected.lifecycle
  if (
    !isDeepStrictEqual(result, {
      schemaVersion: 1,
      scenario,
      outcome: expected.outcome,
      cleanupOrder: expected.cleanupOrder,
      errorOrder: expected.errorOrder,
      stageReadback: expected.stageReadback
    })
    || (thrown ? 7 : 0) !== expected.exitCode
  ) throw new Error("project session probe actual lifecycle differs from descriptor expectation")

  return thrown
    ? { ExitCode: 7, Result: result, Failure: { Thrown: true, Value: failure } }
    : { ExitCode: 0, Result: result, Failure: { Thrown: false } }
}

function ParseArguments(args: readonly string[]): ParsedArguments | null {
  let Mode: "lifecycle" | "gate" | undefined
  let Scenario: ProbeScenario | undefined
  let Root = process.cwd()
  let RunId: string | undefined
  const seen = new Set<string>()
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    const value = args[index + 1]
    if (name === undefined || value === undefined || value.length === 0 || seen.has(name)) return null
    seen.add(name)
    if (name === "--mode" && (value === "lifecycle" || value === "gate")) Mode = value
    else if (name === "--scenario" && IsProbeScenario(value)) Scenario = value
    else if (name === "--root") Root = value
    else if (name === "--run-id") RunId = value
    else return null
  }
  if (
    Mode === undefined
    || Scenario === undefined
    || (Mode === "lifecycle" && RunId !== undefined)
    || (Mode === "gate" && RunId === undefined)
  ) return null
  return RunId === undefined
    ? { Mode, Scenario, Root }
    : { Mode, Scenario, Root, RunId }
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

export async function Main(
  args: readonly string[],
  io: ProjectSessionProbeIO = DefaultIO
): Promise<number> {
  const parsed = ParseArguments(args)
  if (parsed === null) {
    await io.WriteStderr("PROJECT_SESSION_PROBE_USAGE invalid arguments\n")
    return 1
  }
  if (parsed.Mode === "gate") {
    const result = await RunGate({
      root: parsed.Root,
      gate: "boundary-project-session-probe",
      mode: "runtime-probe",
      readinessPolicy: "evaluation-only",
      expectedSubjects: 1,
      inputPaths: [ProbeCasesPath, `${ProbeRoot}/${parsed.Scenario}.json`],
      toolchain: { bun: Bun.version, typescript: "7.0.2" },
      runId: parsed.RunId as string
    }, async (snapshot) => {
      const execution = await EvaluateProjectSessionProbe(snapshot, parsed.Scenario, parsed.Root)
      if (execution.Failure.Thrown) throw execution.Failure.Value
      return {
        SubjectsChecked: 1,
        Checks: [{ id: "PROJECT_SESSION_PROBE_PASS", status: "pass" }]
      }
    })
    try {
      await EmitGateResultWithDependencies(parsed.Root, result, {
        AtomicWriterOperations: NodeAtomicWriterOperations(),
        WriteStdout: io.WriteStdout
      })
    } catch (error) {
      await io.WriteStderr(`PROJECT_SESSION_PROBE_EMIT_ERROR ${ErrorMessage(error)}\n`)
      return 1
    }
    return result.status === "pass" ? 0 : 1
  }

  const inputs = await SnapshotInputs(parsed.Root, [
    ProbeCasesPath,
    `${ProbeRoot}/${parsed.Scenario}.json`
  ])
  if (inputs.Snapshot === null) {
    await io.WriteStderr("PROJECT_SESSION_PROBE_INPUT_ERROR required inputs could not be snapshotted\n")
    return 1
  }

  let execution: ProjectSessionProbeExecution
  try {
    execution = await EvaluateProjectSessionProbe(inputs.Snapshot, parsed.Scenario, parsed.Root)
  } catch (error) {
    await io.WriteStderr(`PROJECT_SESSION_PROBE_EXECUTION_ERROR ${ErrorMessage(error)}\n`)
    return 1
  }
  try {
    await io.WriteStdout(`LIKEGO_PROJECT_SESSION_PROBE=${JSON.stringify(execution.Result)}\n`)
  } catch (error) {
    await io.WriteStderr(`PROJECT_SESSION_PROBE_OUTPUT_ERROR ${ErrorMessage(error)}\n`)
    return 1
  }
  return execution.ExitCode
}

if (import.meta.main) process.exitCode = await Main(process.argv.slice(2))
