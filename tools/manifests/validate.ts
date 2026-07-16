import { Ajv2020, type AnySchema, type ValidateFunction } from "ajv/dist/2020.js"
import type { GateCheck, GateEvaluation, InputSnapshot, SnapshotFile } from "../gates/result.ts"

export interface ManifestIssue {
  readonly Code: string
  readonly Path: string
  readonly Message: string
}

interface RuntimeRow {
  readonly runtime: "bun" | "node" | "deno"
  readonly lane: "exact" | "lts" | "current"
  readonly minimumVersion: string
  readonly testedVersions: readonly string[]
  readonly terminalObservability: "not-applicable" | "observable" | "unobservable"
}

interface CapabilityManifest {
  readonly schemaVersion: 1
  readonly package: string
  readonly packageKind: "portable" | "adapter"
  readonly stability: "provisional" | "beta" | "stable"
  readonly releaseBlocking: boolean
  readonly residency: "non-resident" | "resident"
  readonly capabilities: readonly string[]
  readonly runtimes: readonly RuntimeRow[]
}

interface ResourceContract {
  readonly id: string
  readonly owner: "likego-owned" | "application-owned"
  readonly exposure: "managed-private" | "native-borrowed"
  readonly stopContract: "likego-owned" | "application-owned"
}

interface OwnerManifest {
  readonly schemaVersion: 1
  readonly package: string
  readonly resources: readonly ResourceContract[]
}

interface RuntimeMatrixLane {
  readonly Id: string
  readonly Runtime: string
  readonly Channel: string
  readonly Version: string
}

interface PackageGroup {
  readonly Directory: string
  readonly Root: "packages" | "adapters"
  readonly Name: string
  readonly Files: readonly SnapshotFile[]
}

const Decoder = new TextDecoder("utf-8", { fatal: true })
const CapabilitySchemaPath = "schemas/capability-manifest.schema.json"
const OwnerSchemaPath = "schemas/owner-manifest.schema.json"
const RuntimeMatrixPath = "config/runtime-matrix.json"
const SharedPaths = new Set([CapabilitySchemaPath, OwnerSchemaPath, RuntimeMatrixPath])
const ManifestNames = new Set(["package.json", "capability.json", "owner.json"])

function CompareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function IsRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function ParseJson(file: SnapshotFile): unknown {
  return JSON.parse(Decoder.decode(file.Bytes)) as unknown
}

function NewIssue(Code: string, Path: string, Message: string): ManifestIssue {
  return { Code, Path, Message }
}

function SortIssues(issues: readonly ManifestIssue[]): readonly ManifestIssue[] {
  return [...issues].sort((left, right) => (
    CompareCodeUnits(left.Code, right.Code)
    || CompareCodeUnits(left.Path, right.Path)
    || CompareCodeUnits(left.Message, right.Message)
  ))
}

function DirectManifest(file: SnapshotFile): {
  readonly Directory: string
  readonly Root: "packages" | "adapters"
  readonly Name: string
} | null {
  const parts = file.Path.split("/")
  if (
    parts.length !== 3
    || (parts[0] !== "packages" && parts[0] !== "adapters")
    || parts[1] === undefined
    || parts[1].length === 0
    || parts[2] === undefined
    || !ManifestNames.has(parts[2])
  ) {
    return null
  }
  return { Directory: `${parts[0]}/${parts[1]}`, Root: parts[0], Name: parts[1] }
}

function DiscoverGroups(files: readonly SnapshotFile[]): readonly PackageGroup[] {
  const groups = new Map<string, { Root: "packages" | "adapters"; Name: string; Files: SnapshotFile[] }>()
  for (const file of files) {
    const direct = DirectManifest(file)
    if (direct === null) continue
    const group = groups.get(direct.Directory) ?? { Root: direct.Root, Name: direct.Name, Files: [] }
    group.Files.push(file)
    groups.set(direct.Directory, group)
  }
  return [...groups.entries()]
    .sort(([left], [right]) => CompareCodeUnits(left, right))
    .map(([Directory, group]) => ({
      Directory,
      Root: group.Root,
      Name: group.Name,
      Files: group.Files.sort((left, right) => CompareCodeUnits(left.Path, right.Path))
    }))
}

function FileMap(files: readonly SnapshotFile[]): ReadonlyMap<string, SnapshotFile> | null {
  const map = new Map<string, SnapshotFile>()
  for (const file of files) {
    if (map.has(file.Path)) return null
    map.set(file.Path, file)
  }
  return map
}

function CompileSchemas(files: ReadonlyMap<string, SnapshotFile>): {
  readonly Capability: ValidateFunction
  readonly Owner: ValidateFunction
} | null {
  try {
    const capabilityFile = files.get(CapabilitySchemaPath)
    const ownerFile = files.get(OwnerSchemaPath)
    if (capabilityFile === undefined || ownerFile === undefined) return null
    const ajv = new Ajv2020({ strict: true, allErrors: true })
    const Capability = ajv.compile(ParseJson(capabilityFile) as AnySchema)
    const Owner = ajv.compile(ParseJson(ownerFile) as AnySchema)
    return { Capability, Owner }
  } catch {
    return null
  }
}

function ParseRuntimeMatrix(file: SnapshotFile | undefined): readonly RuntimeMatrixLane[] | null {
  try {
    if (file === undefined) return null
    const value = ParseJson(file)
    if (!IsRecord(value) || !Array.isArray(value.Lanes)) return null
    const lanes: RuntimeMatrixLane[] = []
    for (const lane of value.Lanes) {
      if (
        !IsRecord(lane)
        || typeof lane.Id !== "string"
        || typeof lane.Runtime !== "string"
        || typeof lane.Channel !== "string"
        || typeof lane.Version !== "string"
      ) {
        return null
      }
      lanes.push({ Id: lane.Id, Runtime: lane.Runtime, Channel: lane.Channel, Version: lane.Version })
    }
    return lanes
  } catch {
    return null
  }
}

function ParseSemver(version: string): readonly [number, number, number, readonly string[]] | null {
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z.-]+))?$/.exec(version)
  if (match === null) return null
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4]?.split(".") ?? []]
}

function ComparePrerelease(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) {
    return left.length === right.length ? 0 : left.length === 0 ? 1 : -1
  }
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const leftPart = left[index]
    const rightPart = right[index]
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1
    }
    if (leftPart === rightPart) continue
    const leftNumeric = /^[0-9]+$/.test(leftPart)
    const rightNumeric = /^[0-9]+$/.test(rightPart)
    if (leftNumeric && rightNumeric) return Number(leftPart) - Number(rightPart)
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return CompareCodeUnits(leftPart, rightPart)
  }
  return 0
}

function SemverAtLeast(version: string, minimum: string): boolean {
  const actual = ParseSemver(version)
  const floor = ParseSemver(minimum)
  if (actual === null || floor === null) return false
  for (const index of [0, 1, 2] as const) {
    const difference = actual[index]! - floor[index]!
    if (difference !== 0) return difference > 0
  }
  return ComparePrerelease(actual[3], floor[3]) >= 0
}

function RuntimeKey(row: RuntimeRow): string {
  return `${row.runtime}/${row.lane}`
}

function MatrixVersions(lanes: readonly RuntimeMatrixLane[]): ReadonlyMap<string, string> {
  const versions = new Map<string, string>()
  for (const lane of lanes) versions.set(`${lane.Runtime}/${lane.Channel}`, lane.Version)
  return versions
}

function RuntimeSetIsValid(capability: CapabilityManifest): boolean {
  const bun = capability.runtimes.filter((row) => row.runtime === "bun")
  const node = capability.runtimes.filter((row) => row.runtime === "node")
  const deno = capability.runtimes.filter((row) => row.runtime === "deno")
  const nonNodeLanesValid = bun.every((row) => row.lane === "exact")
    && deno.every((row) => row.lane === "exact")
  if (!nonNodeLanesValid || bun.length > 1 || deno.length > 1 || capability.runtimes.length === 0) {
    return false
  }
  if (capability.packageKind === "portable") {
    return bun.length === 1 && node.length === 2 && deno.length === 1
  }
  return true
}

function NodeLanesAreValid(capability: CapabilityManifest): boolean {
  const lanes = capability.runtimes
    .filter((row) => row.runtime === "node")
    .map((row) => row.lane)
    .sort(CompareCodeUnits)
  return lanes.length === 0 || (lanes.length === 2 && lanes[0] === "current" && lanes[1] === "lts")
}

function RuntimeVersionsAreValid(
  capability: CapabilityManifest,
  matrix: readonly RuntimeMatrixLane[]
): boolean {
  const versions = MatrixVersions(matrix)
  return capability.runtimes.every((row) => {
    const expected = versions.get(RuntimeKey(row))
    return expected !== undefined
      && row.testedVersions.length === 1
      && row.testedVersions[0] === expected
      && row.testedVersions.every((version) => SemverAtLeast(version, row.minimumVersion))
  })
}

function TerminalObservabilityIsValid(capability: CapabilityManifest): boolean {
  if (capability.residency === "non-resident") {
    return capability.runtimes.every((row) => row.terminalObservability === "not-applicable")
  }
  return !capability.releaseBlocking
    || capability.runtimes.every((row) => row.terminalObservability === "observable")
}

function ResourceTupleIsValid(resource: ResourceContract): boolean {
  return (
    resource.owner === "likego-owned"
    && resource.exposure === "managed-private"
    && resource.stopContract === "likego-owned"
  ) || (
    resource.owner === "application-owned"
    && resource.exposure === "native-borrowed"
    && resource.stopContract === "application-owned"
  )
}

function ValidateResources(
  directory: string,
  capability: CapabilityManifest,
  owner: OwnerManifest
): readonly ManifestIssue[] {
  const path = `${directory}/owner.json`
  const issues: ManifestIssue[] = []
  if (capability.residency === "resident" && owner.resources.length === 0) {
    issues.push(NewIssue("MANIFEST_RESOURCE_MISSING", path, "resident official adapters must declare owned resources"))
  }
  if (capability.residency === "non-resident" && owner.resources.length !== 0) {
    issues.push(NewIssue("MANIFEST_RESIDENCY_CONFLICT", path, "non-resident packages must not declare resources"))
  }

  const byId = new Map<string, ResourceContract[]>()
  for (const resource of owner.resources) {
    const contracts = byId.get(resource.id) ?? []
    contracts.push(resource)
    byId.set(resource.id, contracts)
  }
  for (const [id, contracts] of [...byId.entries()].sort(([left], [right]) => CompareCodeUnits(left, right))) {
    if (contracts.length > 1) {
      issues.push(NewIssue("MANIFEST_RESOURCE_DUPLICATE", path, `resource id must be unique: ${id}`))
    }
    if (contracts.some((resource) => !ResourceTupleIsValid(resource))) {
      issues.push(NewIssue("MANIFEST_RESOURCE_CONFLICT", path, `resource ownership tuple conflicts: ${id}`))
    }
  }
  return issues
}

function PackageSchemaIssues(
  map: ReadonlyMap<string, SnapshotFile>,
  group: PackageGroup,
  schemas: { readonly Capability: ValidateFunction; readonly Owner: ValidateFunction }
): {
  readonly Issues: readonly ManifestIssue[]
  readonly PackageName: string | null
  readonly Capability: CapabilityManifest | null
  readonly Owner: OwnerManifest | null
} {
  const packagePath = `${group.Directory}/package.json`
  const capabilityPath = `${group.Directory}/capability.json`
  const ownerPath = `${group.Directory}/owner.json`
  const issues: ManifestIssue[] = []
  const packageFile = map.get(packagePath)
  const capabilityFile = map.get(capabilityPath)
  const ownerFile = map.get(ownerPath)
  let packageName: string | null = null
  let capability: CapabilityManifest | null = null
  let owner: OwnerManifest | null = null

  try {
    if (packageFile === undefined) throw new Error("missing")
    const value = ParseJson(packageFile)
    if (!IsRecord(value) || typeof value.name !== "string") throw new Error("shape")
    packageName = value.name
  } catch {
    issues.push(NewIssue("MANIFEST_SCHEMA", packagePath, "package.json must be valid JSON with a string name"))
  }
  try {
    if (capabilityFile === undefined) throw new Error("missing")
    const value = ParseJson(capabilityFile)
    if (!schemas.Capability(value)) throw new Error("shape")
    capability = value as CapabilityManifest
  } catch {
    issues.push(NewIssue("MANIFEST_SCHEMA", capabilityPath, "capability manifest must satisfy the snapshotted schema"))
  }
  try {
    if (ownerFile === undefined) throw new Error("missing")
    const value = ParseJson(ownerFile)
    if (!schemas.Owner(value)) throw new Error("shape")
    owner = value as OwnerManifest
  } catch {
    issues.push(NewIssue("MANIFEST_SCHEMA", ownerPath, "owner manifest must satisfy the snapshotted schema"))
  }
  return { Issues: issues, PackageName: packageName, Capability: capability, Owner: owner }
}

export function ValidateOfficialPackage(files: readonly SnapshotFile[]): readonly ManifestIssue[] {
  const map = FileMap(files)
  if (map === null) return [NewIssue("MANIFEST_SCHEMA", "<snapshot>", "manifest snapshot paths must be unique")]
  const groups = DiscoverGroups(files)
  if (groups.length === 0) return []
  if (groups.length !== 1) {
    return [NewIssue("MANIFEST_SCHEMA", "<snapshot>", "official package validation requires exactly one package group")]
  }
  const group = groups[0]!
  const schemas = CompileSchemas(map)
  const matrix = ParseRuntimeMatrix(map.get(RuntimeMatrixPath))
  if (schemas === null || matrix === null) {
    return [NewIssue("MANIFEST_SCHEMA", "<shared>", "snapshotted schemas and runtime matrix must be valid and complete")]
  }
  const parsed = PackageSchemaIssues(map, group, schemas)
  if (parsed.Issues.length > 0 || parsed.PackageName === null || parsed.Capability === null || parsed.Owner === null) {
    return SortIssues(parsed.Issues)
  }

  const capability = parsed.Capability
  const owner = parsed.Owner
  const issues: ManifestIssue[] = []
  const expectedPackage = `@likego/${group.Name}`
  if (
    parsed.PackageName !== expectedPackage
    || capability.package !== parsed.PackageName
    || owner.package !== parsed.PackageName
  ) {
    issues.push(NewIssue(
      "MANIFEST_PACKAGE_MISMATCH",
      group.Directory,
      "directory, package.json, capability.json, and owner.json package names must match"
    ))
  }

  const residencyMatches = group.Root === "packages"
    ? capability.packageKind === "portable" && capability.residency === "non-resident"
    : capability.packageKind === "adapter" && capability.residency === "resident"
  if (!residencyMatches) {
    issues.push(NewIssue(
      "MANIFEST_RESIDENCY_CONFLICT",
      `${group.Directory}/capability.json`,
      "official root, package kind, and residency must agree"
    ))
  }

  const runtimeSetValid = RuntimeSetIsValid(capability)
  const nodeLanesValid = NodeLanesAreValid(capability)
  if (!runtimeSetValid) {
    issues.push(NewIssue(
      "MANIFEST_RUNTIME_SET",
      `${group.Directory}/capability.json`,
      "runtime families and non-Node lanes must satisfy the official package contract"
    ))
  }
  if (!nodeLanesValid) {
    issues.push(NewIssue(
      "MANIFEST_NODE_LANES",
      `${group.Directory}/capability.json`,
      "Node support must contain exactly the LTS and current lanes"
    ))
  }
  if (runtimeSetValid && nodeLanesValid && !RuntimeVersionsAreValid(capability, matrix)) {
    issues.push(NewIssue(
      "MANIFEST_RUNTIME_VERSION",
      `${group.Directory}/capability.json`,
      "tested versions must equal the snapshotted lane and be at least the minimum version"
    ))
  }
  if (!TerminalObservabilityIsValid(capability)) {
    issues.push(NewIssue(
      "MANIFEST_TERMINAL_OBSERVABILITY",
      `${group.Directory}/capability.json`,
      "portable terminals are not-applicable and blocking resident terminals are observable"
    ))
  }
  issues.push(...ValidateResources(group.Directory, capability, owner))
  return SortIssues(issues)
}

function SharedFiles(snapshot: InputSnapshot): readonly SnapshotFile[] {
  return snapshot.Files.filter((file) => SharedPaths.has(file.Path))
}

function IssueCheck(issue: ManifestIssue): GateCheck {
  return { id: issue.Code, status: "fail", path: issue.Path, detail: issue.Message }
}

export function CheckOfficialManifests(snapshot: InputSnapshot): GateEvaluation {
  const groups = DiscoverGroups(snapshot.Files)
  const checks: GateCheck[] = [{
    id: "MANIFEST_PACKAGE_INVENTORY",
    status: "pass",
    expected: "direct packages/* and adapters/* only",
    actual: groups.length
  }]
  if (groups.length === 0) {
    checks.push({
      id: "MANIFEST_PACKAGE_ZERO",
      status: "fail",
      actual: 0,
      detail: "repository package admission requires at least one direct official package"
    })
    return { SubjectsChecked: 0, Checks: checks }
  }

  const shared = SharedFiles(snapshot)
  for (const group of groups) {
    const issues = ValidateOfficialPackage([...shared, ...group.Files])
    if (issues.length === 0) {
      checks.push({ id: "MANIFEST_PACKAGE_VALID", status: "pass", path: group.Directory })
    } else {
      checks.push(...issues.map(IssueCheck))
    }
  }
  return { SubjectsChecked: groups.length, Checks: checks }
}
