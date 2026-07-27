import { Ajv2020, type AnySchema, type ValidateFunction } from "ajv/dist/2020.js"
import type { GateCheck, GateEvaluation, InputSnapshot, SnapshotFile } from "../gates/result"
import { officialCapabilityVocabulary } from "./capability-vocabulary"

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

interface CapabilityExport {
  readonly kind: "portable" | "integration"
  readonly residency: "non-resident" | "resident"
  readonly ownerResources: readonly string[]
  readonly capabilities: readonly string[]
  readonly runtimes: readonly RuntimeRow[]
}

interface CapabilityManifest {
  readonly schemaVersion: 2
  readonly package: string
  readonly packageKind: "portable" | "integration" | "hybrid"
  readonly stability: "provisional" | "beta" | "stable"
  readonly releaseBlocking: boolean
  readonly exports: Readonly<Record<string, CapabilityExport>>
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
  return [...issues].sort(
    (left, right) =>
      CompareCodeUnits(left.Code, right.Code) ||
      CompareCodeUnits(left.Path, right.Path) ||
      CompareCodeUnits(left.Message, right.Message)
  )
}

function DirectManifest(file: SnapshotFile): string | null {
  const parts = file.Path.split("/")
  if (
    parts.length < 3 ||
    (parts[0] !== "packages" && parts[0] !== "adapters") ||
    parts.slice(1, -1).some((part) => part.length === 0) ||
    !ManifestNames.has(parts[parts.length - 1] ?? "")
  ) {
    return null
  }
  return parts.slice(0, -1).join("/")
}

function DiscoverGroups(files: readonly SnapshotFile[]): readonly PackageGroup[] {
  const groups = new Map<string, SnapshotFile[]>()
  for (const file of files) {
    const directory = DirectManifest(file)
    if (directory !== null && !groups.has(directory)) groups.set(directory, [])
  }
  for (const file of files) {
    const owner = [...groups.keys()].find((directory) => file.Path.startsWith(`${directory}/`))
    if (owner !== undefined) {
      groups.get(owner)?.push(file)
    }
  }
  return [...groups.entries()]
    .sort(([left], [right]) => CompareCodeUnits(left, right))
    .map(([Directory, groupFiles]) => ({
      Directory,
      Files: groupFiles.sort((left, right) => CompareCodeUnits(left.Path, right.Path))
    }))
}

function CanonicalGroups(
  files: readonly SnapshotFile[],
  subjectDirectories: readonly string[]
): readonly PackageGroup[] | null {
  const uniqueDirectories = new Set(subjectDirectories)
  if (uniqueDirectories.size !== subjectDirectories.length) return null

  const directories = [...uniqueDirectories].sort(CompareCodeUnits)
  const groups = new Map<string, SnapshotFile[]>()
  for (const directory of directories) {
    const parts = directory.split("/")
    if (
      parts.length < 2 ||
      (parts[0] !== "packages" && parts[0] !== "adapters") ||
      parts.slice(1).some((part) => part.length === 0 || part === "." || part === "..")
    ) {
      return null
    }
    groups.set(directory, [])
  }

  const deepestFirst = [...directories].sort(
    (left, right) =>
      right.split("/").length - left.split("/").length || CompareCodeUnits(left, right)
  )
  for (const file of files) {
    const owner = deepestFirst.find((directory) => file.Path.startsWith(`${directory}/`))
    if (owner === undefined) continue
    groups.get(owner)?.push(file)
  }

  return directories.map((Directory) => {
    const groupFiles = groups.get(Directory)!
    return {
      Directory,
      Files: groupFiles.sort((left, right) => CompareCodeUnits(left.Path, right.Path))
    }
  })
}

/** Verifies that one official package declares exactly its reviewed claims and snapshots every bound proof file. */
function ValidateCapabilityEvidence(
  group: PackageGroup,
  capability: CapabilityManifest
): readonly ManifestIssue[] {
  const path = `${group.Directory}/capability.json`
  const contracts = officialCapabilityVocabulary[capability.package]
  if (contracts === undefined) {
    return [
      NewIssue(
        "MANIFEST_CAPABILITY_PACKAGE",
        path,
        `official package has no reviewed capability vocabulary entry: ${capability.package}`
      )
    ]
  }

  const declaredExports = Object.keys(capability.exports).sort(CompareCodeUnits)
  const reviewedExports = Object.keys(contracts).sort(CompareCodeUnits)
  if (
    declaredExports.length !== reviewedExports.length ||
    declaredExports.some((exportName, index) => exportName !== reviewedExports[index])
  ) {
    return [
      NewIssue(
        "MANIFEST_CAPABILITY_CONTRACT",
        path,
        `declared exports must exactly match reviewed vocabulary: ${reviewedExports.join(",")}`
      )
    ]
  }

  const snapshotted = new Set(group.Files.map((file) => file.Path))
  const issues: ManifestIssue[] = []
  for (const exportName of reviewedExports) {
    const exportContracts = contracts[exportName]
    const exportClaim = capability.exports[exportName]
    if (exportContracts === undefined || exportClaim === undefined) continue
    const declared = [...exportClaim.capabilities].sort(CompareCodeUnits)
    const reviewed = Object.keys(exportContracts).sort(CompareCodeUnits)
    if (
      declared.length !== reviewed.length ||
      declared.some((claim, index) => claim !== reviewed[index])
    ) {
      issues.push(
        NewIssue(
          "MANIFEST_CAPABILITY_CONTRACT",
          path,
          `${exportName} capabilities must exactly match reviewed vocabulary: ${reviewed.join(",")}`
        )
      )
      continue
    }
    for (const claim of reviewed) {
      const contract = exportContracts[claim]
      if (contract === undefined || contract.code.length === 0 || contract.tests.length === 0) {
        issues.push(
          NewIssue(
            "MANIFEST_CAPABILITY_EVIDENCE",
            path,
            `capability vocabulary must bind code and tests: ${exportName} ${claim}`
          )
        )
        continue
      }
      for (const relativePath of [...contract.code, ...contract.tests]) {
        const evidencePath = `${group.Directory}/${relativePath}`
        if (!snapshotted.has(evidencePath)) {
          issues.push(
            NewIssue(
              "MANIFEST_CAPABILITY_EVIDENCE",
              evidencePath,
              `missing snapshotted evidence for ${exportName} capability ${claim}`
            )
          )
        }
      }
    }
  }
  return issues
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
        !IsRecord(lane) ||
        typeof lane.Id !== "string" ||
        typeof lane.Runtime !== "string" ||
        typeof lane.Channel !== "string" ||
        typeof lane.Version !== "string"
      ) {
        return null
      }
      lanes.push({
        Id: lane.Id,
        Runtime: lane.Runtime,
        Channel: lane.Channel,
        Version: lane.Version
      })
    }
    return lanes
  } catch {
    return null
  }
}

function ParseSemver(version: string): readonly [number, number, number, readonly string[]] | null {
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z.-]+))?$/.exec(
    version
  )
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

function RuntimeSetIsValid(exportClaim: CapabilityExport): boolean {
  const bun = exportClaim.runtimes.filter((row) => row.runtime === "bun")
  const node = exportClaim.runtimes.filter((row) => row.runtime === "node")
  const deno = exportClaim.runtimes.filter((row) => row.runtime === "deno")
  const nonNodeLanesValid =
    bun.every((row) => row.lane === "exact") && deno.every((row) => row.lane === "exact")
  if (
    !nonNodeLanesValid ||
    bun.length > 1 ||
    deno.length > 1 ||
    exportClaim.runtimes.length === 0
  ) {
    return false
  }
  if (exportClaim.kind === "portable") {
    return bun.length === 1 && node.length === 2 && deno.length === 1
  }
  return true
}

function NodeLanesAreValid(exportClaim: CapabilityExport): boolean {
  const lanes = exportClaim.runtimes
    .filter((row) => row.runtime === "node")
    .map((row) => row.lane)
    .sort(CompareCodeUnits)
  return lanes.length === 0 || (lanes.length === 2 && lanes[0] === "current" && lanes[1] === "lts")
}

function RuntimeVersionsAreValid(
  exportClaim: CapabilityExport,
  matrix: readonly RuntimeMatrixLane[]
): boolean {
  const versions = MatrixVersions(matrix)
  const keys = new Set<string>()
  return exportClaim.runtimes.every((row) => {
    const key = RuntimeKey(row)
    if (keys.has(key)) return false
    keys.add(key)
    const expected = versions.get(key)
    return (
      expected !== undefined &&
      row.testedVersions.length === 1 &&
      row.testedVersions[0] === expected &&
      row.testedVersions.every((version) => SemverAtLeast(version, row.minimumVersion))
    )
  })
}

function TerminalObservabilityIsValid(exportClaim: CapabilityExport): boolean {
  if (exportClaim.residency === "non-resident") {
    return exportClaim.runtimes.every((row) => row.terminalObservability === "not-applicable")
  }
  return exportClaim.runtimes.every((row) => row.terminalObservability !== "not-applicable")
}

/** Accepts private ownership, fully application-owned borrowing, or borrowed data-plane with LikeGo stop control. */
function ResourceTupleIsValid(resource: ResourceContract): boolean {
  return (
    (resource.owner === "likego-owned" &&
      resource.exposure === "managed-private" &&
      resource.stopContract === "likego-owned") ||
    (resource.owner === "application-owned" &&
      resource.exposure === "native-borrowed" &&
      resource.stopContract === "application-owned") ||
    (resource.owner === "application-owned" &&
      resource.exposure === "native-borrowed" &&
      resource.stopContract === "likego-owned")
  )
}

function ValidateResources(
  directory: string,
  capability: CapabilityManifest,
  owner: OwnerManifest
): readonly ManifestIssue[] {
  const path = `${directory}/owner.json`
  const issues: ManifestIssue[] = []
  const byId = new Map<string, ResourceContract[]>()
  for (const resource of owner.resources) {
    const contracts = byId.get(resource.id) ?? []
    contracts.push(resource)
    byId.set(resource.id, contracts)
  }
  for (const [id, contracts] of [...byId.entries()].sort(([left], [right]) =>
    CompareCodeUnits(left, right)
  )) {
    if (contracts.length > 1) {
      issues.push(
        NewIssue("MANIFEST_RESOURCE_DUPLICATE", path, `resource id must be unique: ${id}`)
      )
    }
    if (contracts.some((resource) => !ResourceTupleIsValid(resource))) {
      issues.push(
        NewIssue("MANIFEST_RESOURCE_CONFLICT", path, `resource ownership tuple conflicts: ${id}`)
      )
    }
  }

  const referenced = new Set<string>()
  for (const [exportName, exportClaim] of Object.entries(capability.exports).sort(
    ([left], [right]) => CompareCodeUnits(left, right)
  )) {
    if (exportClaim.residency === "resident" && exportClaim.ownerResources.length === 0) {
      issues.push(
        NewIssue(
          "MANIFEST_RESOURCE_MISSING",
          `${directory}/capability.json`,
          `resident export must reference at least one owner resource: ${exportName}`
        )
      )
    }
    if (exportClaim.residency === "non-resident" && exportClaim.ownerResources.length !== 0) {
      issues.push(
        NewIssue(
          "MANIFEST_RESIDENCY_CONFLICT",
          `${directory}/capability.json`,
          `non-resident export must not reference owner resources: ${exportName}`
        )
      )
    }
    for (const id of exportClaim.ownerResources) {
      referenced.add(id)
      if (!byId.has(id)) {
        issues.push(
          NewIssue(
            "MANIFEST_RESOURCE_MISSING",
            path,
            `export ${exportName} references an unknown owner resource: ${id}`
          )
        )
      }
    }
  }
  for (const id of [...byId.keys()].sort(CompareCodeUnits)) {
    if (!referenced.has(id)) {
      issues.push(
        NewIssue(
          "MANIFEST_RESIDENCY_CONFLICT",
          path,
          `owner resource must be referenced by at least one resident export: ${id}`
        )
      )
    }
  }
  return issues
}

interface ParsedPackageManifest {
  readonly Name: string
  readonly BusinessExports: readonly string[]
}

function ParsePackageManifest(file: SnapshotFile): ParsedPackageManifest | null {
  try {
    const value = ParseJson(file)
    if (!IsRecord(value) || typeof value.name !== "string" || !IsRecord(value.exports)) return null
    const keys = Object.keys(value.exports)
    if (keys.some((key) => key !== "./package.json" && key !== "." && !key.startsWith("./")))
      return null
    const businessExports = keys.filter((key) => key !== "./package.json").sort(CompareCodeUnits)
    if (!businessExports.includes(".") || new Set(businessExports).size !== businessExports.length)
      return null
    return { Name: value.name, BusinessExports: businessExports }
  } catch {
    return null
  }
}

function PackageSchemaIssues(
  map: ReadonlyMap<string, SnapshotFile>,
  group: PackageGroup,
  schemas: { readonly Capability: ValidateFunction; readonly Owner: ValidateFunction }
): {
  readonly Issues: readonly ManifestIssue[]
  readonly PackageManifest: ParsedPackageManifest | null
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
  let packageManifest: ParsedPackageManifest | null = null
  let capability: CapabilityManifest | null = null
  let owner: OwnerManifest | null = null

  try {
    if (packageFile === undefined) throw new Error("missing")
    packageManifest = ParsePackageManifest(packageFile)
    if (packageManifest === null) throw new Error("shape")
  } catch {
    issues.push(
      NewIssue(
        "MANIFEST_SCHEMA",
        packagePath,
        "package.json must contain a string name and a root business export map"
      )
    )
  }
  try {
    if (capabilityFile === undefined) throw new Error("missing")
    const value = ParseJson(capabilityFile)
    if (!schemas.Capability(value)) throw new Error("shape")
    capability = value as CapabilityManifest
  } catch {
    issues.push(
      NewIssue(
        "MANIFEST_SCHEMA",
        capabilityPath,
        "capability manifest must satisfy the snapshotted schema"
      )
    )
  }
  try {
    if (ownerFile === undefined) throw new Error("missing")
    const value = ParseJson(ownerFile)
    if (!schemas.Owner(value)) throw new Error("shape")
    owner = value as OwnerManifest
  } catch {
    issues.push(
      NewIssue("MANIFEST_SCHEMA", ownerPath, "owner manifest must satisfy the snapshotted schema")
    )
  }
  return { Issues: issues, PackageManifest: packageManifest, Capability: capability, Owner: owner }
}

function DerivedPackageKind(capability: CapabilityManifest): CapabilityManifest["packageKind"] {
  const kinds = new Set(Object.values(capability.exports).map((exportClaim) => exportClaim.kind))
  if (kinds.size > 1) return "hybrid"
  return kinds.has("portable") ? "portable" : "integration"
}

function ExportSetsMatch(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function ValidatePackageGroup(
  files: readonly SnapshotFile[],
  group: PackageGroup,
  requireCapabilityEvidence = false
): readonly ManifestIssue[] {
  const map = FileMap(files)
  if (map === null)
    return [NewIssue("MANIFEST_SCHEMA", "<snapshot>", "manifest snapshot paths must be unique")]
  const schemas = CompileSchemas(map)
  const matrix = ParseRuntimeMatrix(map.get(RuntimeMatrixPath))
  if (schemas === null || matrix === null) {
    return [
      NewIssue(
        "MANIFEST_SCHEMA",
        "<shared>",
        "snapshotted schemas and runtime matrix must be valid and complete"
      )
    ]
  }
  const parsed = PackageSchemaIssues(map, group, schemas)
  if (
    parsed.Issues.length > 0 ||
    parsed.PackageManifest === null ||
    parsed.Capability === null ||
    parsed.Owner === null
  ) {
    return SortIssues(parsed.Issues)
  }

  const capability = parsed.Capability
  const owner = parsed.Owner
  const issues: ManifestIssue[] = []
  if (
    !parsed.PackageManifest.Name.startsWith("@likego/") ||
    capability.package !== parsed.PackageManifest.Name ||
    owner.package !== parsed.PackageManifest.Name
  ) {
    issues.push(
      NewIssue(
        "MANIFEST_PACKAGE_MISMATCH",
        group.Directory,
        "package.json, capability.json, and owner.json package names must match one @likego identity"
      )
    )
  }

  const capabilityExports = Object.keys(capability.exports).sort(CompareCodeUnits)
  if (!ExportSetsMatch(parsed.PackageManifest.BusinessExports, capabilityExports)) {
    issues.push(
      NewIssue(
        "MANIFEST_EXPORT_MISMATCH",
        `${group.Directory}/capability.json`,
        `package and capability business exports must match: ${parsed.PackageManifest.BusinessExports.join(",")}`
      )
    )
  }
  if (DerivedPackageKind(capability) !== capability.packageKind) {
    issues.push(
      NewIssue(
        "MANIFEST_PACKAGE_KIND",
        `${group.Directory}/capability.json`,
        "packageKind must be derived from all export kinds"
      )
    )
  }

  for (const [exportName, exportClaim] of Object.entries(capability.exports).sort(
    ([left], [right]) => CompareCodeUnits(left, right)
  )) {
    const runtimeSetValid = RuntimeSetIsValid(exportClaim)
    const nodeLanesValid = NodeLanesAreValid(exportClaim)
    if (!runtimeSetValid) {
      issues.push(
        NewIssue(
          "MANIFEST_RUNTIME_SET",
          `${group.Directory}/capability.json`,
          `${exportName} runtime families and non-Node lanes must satisfy its export contract`
        )
      )
    }
    if (!nodeLanesValid) {
      issues.push(
        NewIssue(
          "MANIFEST_NODE_LANES",
          `${group.Directory}/capability.json`,
          `${exportName} Node support must contain both LTS and current lanes or neither`
        )
      )
    }
    if (runtimeSetValid && nodeLanesValid && !RuntimeVersionsAreValid(exportClaim, matrix)) {
      issues.push(
        NewIssue(
          "MANIFEST_RUNTIME_VERSION",
          `${group.Directory}/capability.json`,
          `${exportName} tested versions must equal the runtime matrix and satisfy minimum versions`
        )
      )
    }
    if (!TerminalObservabilityIsValid(exportClaim)) {
      issues.push(
        NewIssue(
          "MANIFEST_TERMINAL_OBSERVABILITY",
          `${group.Directory}/capability.json`,
          `${exportName} terminal observability must match its residency`
        )
      )
    }
  }
  if (requireCapabilityEvidence) issues.push(...ValidateCapabilityEvidence(group, capability))
  issues.push(...ValidateResources(group.Directory, capability, owner))
  return SortIssues(issues)
}

export function validateOfficialPackage(
  files: readonly SnapshotFile[],
  requireCapabilityEvidence = false
): readonly ManifestIssue[] {
  const groups = DiscoverGroups(files)
  if (groups.length === 0) return []
  if (groups.length !== 1) {
    return [
      NewIssue(
        "MANIFEST_SCHEMA",
        "<snapshot>",
        "official package validation requires exactly one package group"
      )
    ]
  }
  return ValidatePackageGroup(files, groups[0]!, requireCapabilityEvidence)
}

function SharedFiles(snapshot: InputSnapshot): readonly SnapshotFile[] {
  return snapshot.Files.filter((file) => SharedPaths.has(file.Path))
}

function IssueCheck(issue: ManifestIssue): GateCheck {
  return { id: issue.Code, status: "fail", path: issue.Path, detail: issue.Message }
}

export function checkOfficialManifests(
  snapshot: InputSnapshot,
  subjectDirectories: readonly string[]
): GateEvaluation {
  const groups = CanonicalGroups(snapshot.Files, subjectDirectories)
  if (groups === null) {
    return {
      SubjectsChecked: 0,
      Checks: [
        {
          id: "MANIFEST_PACKAGE_INVENTORY",
          status: "fail",
          expected: "unique canonical public workspace roots",
          detail: "canonical public workspace roots must be normalized package directories"
        }
      ]
    }
  }
  const checks: GateCheck[] = [
    {
      id: "MANIFEST_PACKAGE_INVENTORY",
      status: "pass",
      expected: "canonical public root workspaces only",
      actual: groups.length
    }
  ]
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
    const issues = ValidatePackageGroup([...shared, ...group.Files], group, true)
    if (issues.length === 0) {
      checks.push({ id: "MANIFEST_PACKAGE_VALID", status: "pass", path: group.Directory })
    } else {
      checks.push(...issues.map(IssueCheck))
    }
  }
  return { SubjectsChecked: groups.length, Checks: checks }
}
