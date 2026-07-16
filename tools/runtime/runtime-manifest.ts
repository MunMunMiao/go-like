import type { GateCheck, GateEvaluation, InputSnapshot, SnapshotFile } from "../gates/result.ts"

export interface RuntimeLane {
  readonly Id: "bun-exact" | "node-lts" | "node-current" | "deno-exact"
  readonly Runtime: "bun" | "node" | "deno"
  readonly Channel: "exact" | "lts" | "current"
  readonly Version: string
  readonly ImageTag: string
}

export interface RuntimeMatrix {
  readonly SchemaVersion: 1
  readonly TypeScript: "7.0.2"
  readonly Lanes: readonly RuntimeLane[]
}

const InputPaths = [
  "docs/adr/0001-kernel-public-api.md",
  "docs/adr/0002-build-runtime-and-coverage.md",
  "config/runtime-matrix.json",
  "package.json",
  "bunfig.toml",
  "deno.json"
] as const
const ContextContractMarker = "LIKEGO_CONTEXT_TIMING_AFTERFUNC_V1"
const CoverageContractMarker = "LIKEGO_PUBLISHED_JS_BRANCH_AUTHORITY_V1"
const ExpectedTypeScript = "7.0.2"
const ExpectedPackageManager = "bun@1.3.14"
const ExpectedLanes: readonly RuntimeLane[] = [
  {
    Id: "bun-exact",
    Runtime: "bun",
    Channel: "exact",
    Version: "1.3.14",
    ImageTag: "oven/bun:1.3.14"
  },
  {
    Id: "node-lts",
    Runtime: "node",
    Channel: "lts",
    Version: "24.18.0",
    ImageTag: "node:24.18.0-bookworm-slim"
  },
  {
    Id: "node-current",
    Runtime: "node",
    Channel: "current",
    Version: "26.5.0",
    ImageTag: "node:26.5.0-bookworm-slim"
  },
  {
    Id: "deno-exact",
    Runtime: "deno",
    Channel: "exact",
    Version: "2.9.3",
    ImageTag: "denoland/deno:2.9.3"
  }
]
const MatrixKeys = new Set(["SchemaVersion", "TypeScript", "Lanes"])
const LaneKeys = new Set(["Id", "Runtime", "Channel", "Version", "ImageTag"])
const Decoder = new TextDecoder("utf-8", { fatal: true })

function Pass(id: string, expected?: string | number, actual?: string | number): GateCheck {
  return {
    id,
    status: "pass",
    ...(expected === undefined ? {} : { expected }),
    ...(actual === undefined ? {} : { actual })
  }
}

function Fail(id: string, detail: string, expected?: string | number, actual?: string | number): GateCheck {
  return {
    id,
    status: "fail",
    detail,
    ...(expected === undefined ? {} : { expected }),
    ...(actual === undefined ? {} : { actual })
  }
}

function IsRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function HasExactKeys(value: Readonly<Record<string, unknown>>, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.size && keys.every((key) => expected.has(key))
}

function Decode(file: SnapshotFile): string {
  return Decoder.decode(file.Bytes)
}

function ParseJson(file: SnapshotFile): unknown {
  return JSON.parse(Decode(file)) as unknown
}

function IsLaneShape(value: unknown): value is Readonly<Record<string, string>> {
  return IsRecord(value)
    && HasExactKeys(value, LaneKeys)
    && [...LaneKeys].every((key) => typeof value[key] === "string")
}

function ParseMatrix(file: SnapshotFile): RuntimeMatrix | null {
  try {
    const value = ParseJson(file)
    if (
      !IsRecord(value)
      || !HasExactKeys(value, MatrixKeys)
      || value.SchemaVersion !== 1
      || typeof value.TypeScript !== "string"
      || !Array.isArray(value.Lanes)
      || !value.Lanes.every((lane) => IsLaneShape(lane))
    ) {
      return null
    }
    return value as unknown as RuntimeMatrix
  } catch {
    return null
  }
}

interface PackageContract {
  readonly PackageManager: unknown
  readonly TypeScript: unknown
}

function ParsePackage(file: SnapshotFile): PackageContract | null {
  try {
    const value = ParseJson(file)
    if (!IsRecord(value) || !IsRecord(value.devDependencies)) return null
    return {
      PackageManager: value.packageManager,
      TypeScript: value.devDependencies.typescript
    }
  } catch {
    return null
  }
}

function RenderDiagnosticValue(value: unknown): string {
  if (typeof value === "string") return value
  if (value === null) return "<null>"
  return Array.isArray(value) ? "<array>" : `<${typeof value}>`
}

function Inventory(snapshot: InputSnapshot): ReadonlyMap<string, SnapshotFile> | null {
  const expected = new Set<string>(InputPaths)
  const files = new Map<string, SnapshotFile>()
  for (const file of snapshot.Files) {
    if (!expected.has(file.Path) || files.has(file.Path)) return null
    files.set(file.Path, file)
  }
  return files.size === expected.size ? files : null
}

function LaneSetIsExact(lanes: readonly RuntimeLane[]): boolean {
  if (lanes.length !== ExpectedLanes.length) return false
  const ids = lanes.map((lane) => lane.Id)
  return new Set(ids).size === ExpectedLanes.length
    && ExpectedLanes.every((expected) => ids.includes(expected.Id))
}

function LaneMatches(actual: RuntimeLane, expected: RuntimeLane): boolean {
  return actual.Id === expected.Id
    && actual.Runtime === expected.Runtime
    && actual.Channel === expected.Channel
    && actual.Version === expected.Version
    && actual.ImageTag === expected.ImageTag
}

function LaneCheckId(id: RuntimeLane["Id"]): string {
  return `RUNTIME_LANE_${id.replaceAll("-", "_").toUpperCase()}`
}

export function ValidateRuntimeMatrix(snapshot: InputSnapshot): GateEvaluation {
  const files = Inventory(snapshot)
  if (files === null) {
    return {
      SubjectsChecked: 0,
      Checks: [Fail(
        "RUNTIME_INPUT_INVENTORY",
        "runtime contract snapshot must contain each required input exactly once",
        InputPaths.length,
        snapshot.Files.length
      )]
    }
  }

  const checks: GateCheck[] = [Pass("RUNTIME_INPUT_INVENTORY", InputPaths.length, files.size)]
  const matrix = ParseMatrix(files.get("config/runtime-matrix.json") as SnapshotFile)
  if (matrix === null) {
    checks.push(Fail("RUNTIME_MATRIX_FORMAT", "runtime matrix must use the fixed contract shape"))
    return { SubjectsChecked: 0, Checks: checks }
  }
  checks.push(Pass("RUNTIME_MATRIX_FORMAT"))

  if (!LaneSetIsExact(matrix.Lanes)) {
    checks.push(Fail(
      "RUNTIME_LANE_SET",
      "runtime lane ids must be complete, unique, and exact",
      ExpectedLanes.length,
      matrix.Lanes.length
    ))
    return { SubjectsChecked: matrix.Lanes.length, Checks: checks }
  }
  checks.push(Pass("RUNTIME_LANE_SET", ExpectedLanes.length, matrix.Lanes.length))

  const packageContract = ParsePackage(files.get("package.json") as SnapshotFile)
  if (packageContract === null) {
    checks.push(Fail("RUNTIME_PACKAGE_FORMAT", "package.json must contain a devDependencies object"))
    return { SubjectsChecked: matrix.Lanes.length, Checks: checks }
  }

  const typeScriptActual = `${RenderDiagnosticValue(matrix.TypeScript)} / ${RenderDiagnosticValue(packageContract.TypeScript)}`
  const typeScriptExact = matrix.TypeScript === ExpectedTypeScript
    && packageContract.TypeScript === ExpectedTypeScript
  checks.push(typeScriptExact
    ? Pass("RUNTIME_TYPESCRIPT_EXACT", `${ExpectedTypeScript} / ${ExpectedTypeScript}`, typeScriptActual)
    : Fail(
        "RUNTIME_TYPESCRIPT_EXACT",
        "runtime matrix and root TypeScript dependency must be exact",
        `${ExpectedTypeScript} / ${ExpectedTypeScript}`,
        typeScriptActual
      ))
  checks.push(Pass("RUNTIME_PACKAGE_FORMAT"))

  checks.push(packageContract.PackageManager === ExpectedPackageManager
    ? Pass("RUNTIME_PACKAGE_MANAGER_EXACT", ExpectedPackageManager, ExpectedPackageManager)
    : Fail(
        "RUNTIME_PACKAGE_MANAGER_EXACT",
        "root packageManager must pin the exact Bun version",
        ExpectedPackageManager,
        RenderDiagnosticValue(packageContract.PackageManager)
      ))

  const contextAdr = Decode(files.get("docs/adr/0001-kernel-public-api.md") as SnapshotFile)
  checks.push(contextAdr.includes(ContextContractMarker)
    ? Pass("RUNTIME_ADR_CONTEXT_CONTRACT")
    : Fail("RUNTIME_ADR_CONTEXT_CONTRACT", "ADR 0001 is missing the frozen Context contract marker"))
  const coverageAdr = Decode(files.get("docs/adr/0002-build-runtime-and-coverage.md") as SnapshotFile)
  checks.push(coverageAdr.includes(CoverageContractMarker)
    ? Pass("RUNTIME_ADR_COVERAGE_CONTRACT")
    : Fail("RUNTIME_ADR_COVERAGE_CONTRACT", "ADR 0002 is missing the branch authority marker"))

  for (const expected of ExpectedLanes) {
    const actual = matrix.Lanes.find((lane) => lane.Id === expected.Id) as RuntimeLane
    checks.push(LaneMatches(actual, expected)
      ? Pass(LaneCheckId(expected.Id), JSON.stringify(expected), JSON.stringify(actual))
      : Fail(
          LaneCheckId(expected.Id),
          "runtime, channel, version, and image tag must match the frozen lane",
          JSON.stringify(expected),
          JSON.stringify(actual)
        ))
  }

  return { SubjectsChecked: matrix.Lanes.length, Checks: checks }
}
