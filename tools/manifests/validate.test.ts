import { afterEach, describe, expect, test } from "bun:test"
import { Ajv2020, type AnySchema } from "ajv/dist/2020.js"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import { tmpdir } from "node:os"
import type { GateEvaluation, InputSnapshot, SnapshotFile } from "../gates/result.ts"

interface TestIssue {
  readonly Code: string
  readonly Path: string
  readonly Message: string
}

const RepositoryRoot = join(import.meta.dir, "../..")
const TemporaryRoots: string[] = []
const RuntimeRows = [
  { runtime: "bun", lane: "exact", minimumVersion: "1.3.14", testedVersions: ["1.3.14"], terminalObservability: "not-applicable" },
  { runtime: "node", lane: "lts", minimumVersion: "24.18.0", testedVersions: ["24.18.0"], terminalObservability: "not-applicable" },
  { runtime: "node", lane: "current", minimumVersion: "26.5.0", testedVersions: ["26.5.0"], terminalObservability: "not-applicable" },
  { runtime: "deno", lane: "exact", minimumVersion: "2.9.3", testedVersions: ["2.9.3"], terminalObservability: "not-applicable" }
] as const

afterEach(async () => {
  await Promise.all(TemporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function LoadValidator() {
  return import("./validate.ts")
}

async function LoadCli() {
  return import("./check.cli.ts")
}

function Json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function Clone<T>(value: T): T {
  return structuredClone(value)
}

function Sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

function Snapshot(files: Readonly<Record<string, string>>): InputSnapshot {
  const encoder = new TextEncoder()
  const Files: SnapshotFile[] = Object.entries(files).map(([Path, value]) => {
    const Bytes = encoder.encode(value)
    return { Path, RealPath: join("/virtual/manifests", Path), Sha256: Sha256(Bytes), Bytes }
  }).sort((left, right) => left.Path < right.Path ? -1 : left.Path > right.Path ? 1 : 0)
  return { Sha256: Sha256(Files.map((file) => `${file.Path}\0${file.Sha256}\n`).join("")), Files }
}

async function SharedFiles(): Promise<Record<string, string>> {
  const paths = [
    "schemas/capability-manifest.schema.json",
    "schemas/owner-manifest.schema.json",
    "config/runtime-matrix.json"
  ]
  return Object.fromEntries(await Promise.all(paths.map(async (path) => [
    path,
    await readFile(join(RepositoryRoot, path), "utf8")
  ] as const)))
}

function Capability(name: string, resident = false): Record<string, any> {
  const runtimes = Clone(resident ? RuntimeRows.filter((row) => row.runtime === "node") : RuntimeRows) as Array<Record<string, any>>
  if (resident) {
    for (const runtime of runtimes) runtime.terminalObservability = "observable"
  }
  return {
    schemaVersion: 1,
    package: name,
    packageKind: resident ? "adapter" : "portable",
    stability: resident ? "beta" : "stable",
    releaseBlocking: true,
    residency: resident ? "resident" : "non-resident",
    capabilities: [resident ? "server" : "fetch"],
    runtimes
  }
}

function Owner(name: string, resident = false): Record<string, any> {
  return {
    schemaVersion: 1,
    package: name,
    resources: resident
      ? [
          { id: "server", owner: "likego-owned", exposure: "managed-private", stopContract: "likego-owned" },
          { id: "native-client", owner: "application-owned", exposure: "native-borrowed", stopContract: "application-owned" }
        ]
      : []
  }
}

async function OfficialFiles(
  directory = "packages/fixture",
  name = "@likego/fixture",
  resident = false
): Promise<Record<string, string>> {
  return {
    ...await SharedFiles(),
    [`${directory}/package.json`]: Json({ name, version: "0.1.0", private: true, type: "module" }),
    [`${directory}/capability.json`]: Json(Capability(name, resident)),
    [`${directory}/owner.json`]: Json(Owner(name, resident))
  }
}

function FailedCodes(issues: readonly TestIssue[]): string[] {
  return issues.map((issue) => issue.Code).sort()
}

function GateFailures(evaluation: GateEvaluation): string[] {
  return evaluation.Checks.filter((check) => check.status === "fail").map((check) => check.id)
}

async function MutatedFiles(
  mutate: (values: { packageJson: Record<string, any>; capability: Record<string, any>; owner: Record<string, any> }) => void,
  resident = false
): Promise<Record<string, string>> {
  const directory = resident ? "adapters/fixture" : "packages/fixture"
  const files = await OfficialFiles(directory, "@likego/fixture", resident)
  const values = {
    packageJson: JSON.parse(files[`${directory}/package.json`]!) as Record<string, any>,
    capability: JSON.parse(files[`${directory}/capability.json`]!) as Record<string, any>,
    owner: JSON.parse(files[`${directory}/owner.json`]!) as Record<string, any>
  }
  mutate(values)
  files[`${directory}/package.json`] = Json(values.packageJson)
  files[`${directory}/capability.json`] = Json(values.capability)
  files[`${directory}/owner.json`] = Json(values.owner)
  return files
}

async function FilesBelow(root: string): Promise<readonly string[]> {
  const paths: string[] = []
  async function Visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) await Visit(absolute)
      else if (entry.isFile()) paths.push(relative(root, absolute).split("\\").join("/"))
    }
  }
  await Visit(root)
  return paths.sort()
}

async function NewRoot(paths: readonly string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "likego-manifest-cli-"))
  TemporaryRoots.push(root)
  for (const path of paths) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await Bun.write(join(root, path), await readFile(join(RepositoryRoot, path)))
  }
  return root
}

async function WriteFiles(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [path, value] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await Bun.write(join(root, path), value)
  }
}

describe("manifest schemas", () => {
  test("compile strictly, freeze top-level fields, and close nested objects", async () => {
    const ajv = new Ajv2020({ strict: true, allErrors: true })
    const capability = JSON.parse(await readFile(join(RepositoryRoot, "schemas/capability-manifest.schema.json"), "utf8")) as AnySchema
    const owner = JSON.parse(await readFile(join(RepositoryRoot, "schemas/owner-manifest.schema.json"), "utf8")) as AnySchema
    expect(() => ajv.compile(capability)).not.toThrow()
    expect(() => ajv.compile(owner)).not.toThrow()
    expect((capability as Record<string, any>).additionalProperties).toBe(false)
    expect(Object.keys((capability as Record<string, any>).properties).sort()).toEqual([
      "capabilities", "package", "packageKind", "releaseBlocking", "residency", "runtimes", "schemaVersion", "stability"
    ])
    expect((capability as Record<string, any>).$defs.runtime.additionalProperties).toBe(false)
    expect((owner as Record<string, any>).additionalProperties).toBe(false)
    expect(Object.keys((owner as Record<string, any>).properties).sort()).toEqual(["package", "resources", "schemaVersion"])
    expect((owner as Record<string, any>).$defs.resource.additionalProperties).toBe(false)
  })
})

describe("ValidateOfficialPackage", () => {
  test("accepts exact portable/non-resident and resident adapter manifests", async () => {
    const { ValidateOfficialPackage } = await LoadValidator()
    expect(ValidateOfficialPackage(Snapshot(await OfficialFiles()).Files)).toEqual([])
    expect(ValidateOfficialPackage(Snapshot(await OfficialFiles("adapters/fixture", "@likego/fixture", true)).Files)).toEqual([])
  })

  test("returns stable schema and package mismatch codes without cascades", async () => {
    const { ValidateOfficialPackage } = await LoadValidator()
    const schema = await MutatedFiles(({ capability }) => { capability.extra = true })
    const mismatch = await MutatedFiles(({ owner }) => { owner.package = "@likego/other" })
    expect(FailedCodes(ValidateOfficialPackage(Snapshot(schema).Files))).toEqual(["MANIFEST_SCHEMA"])
    expect(FailedCodes(ValidateOfficialPackage(Snapshot(mismatch).Files))).toEqual(["MANIFEST_PACKAGE_MISMATCH"])
  })

  test("locks runtime set, exact-version, Node-lane, and terminal observability codes", async () => {
    const { ValidateOfficialPackage } = await LoadValidator()
    const runtimeSet = await MutatedFiles(({ capability }) => { capability.runtimes.pop() })
    const runtimeVersionDrift = await MutatedFiles(({ capability }) => { capability.runtimes[0].testedVersions = ["1.3.15"] })
    const runtimeVersionBelowMinimum = await MutatedFiles(({ capability }) => { capability.runtimes[0].minimumVersion = "2.0.0" })
    const nodeLanes = await MutatedFiles(({ capability }) => { capability.runtimes[2].lane = "lts" })
    const terminal = await MutatedFiles(({ capability }) => { capability.runtimes[0].terminalObservability = "unobservable" }, true)
    expect(FailedCodes(ValidateOfficialPackage(Snapshot(runtimeSet).Files))).toEqual(["MANIFEST_RUNTIME_SET"])
    expect(FailedCodes(ValidateOfficialPackage(Snapshot(runtimeVersionDrift).Files))).toEqual(["MANIFEST_RUNTIME_VERSION"])
    expect(FailedCodes(ValidateOfficialPackage(Snapshot(runtimeVersionBelowMinimum).Files))).toEqual(["MANIFEST_RUNTIME_VERSION"])
    expect(FailedCodes(ValidateOfficialPackage(Snapshot(nodeLanes).Files))).toEqual(["MANIFEST_NODE_LANES"])
    expect(FailedCodes(ValidateOfficialPackage(Snapshot(terminal).Files))).toEqual(["MANIFEST_TERMINAL_OBSERVABILITY"])
  })

  test("requires portable terminal not-applicable and observable terminals only for blocking residents", async () => {
    const { ValidateOfficialPackage } = await LoadValidator()
    const portableTerminal = await MutatedFiles(({ capability }) => {
      capability.runtimes[0].terminalObservability = "observable"
    })
    const nonBlockingResident = await MutatedFiles(({ capability }) => {
      capability.releaseBlocking = false
      for (const runtime of capability.runtimes) runtime.terminalObservability = "unobservable"
    }, true)

    expect(FailedCodes(ValidateOfficialPackage(Snapshot(portableTerminal).Files))).toEqual([
      "MANIFEST_TERMINAL_OBSERVABILITY"
    ])
    expect(ValidateOfficialPackage(Snapshot(nonBlockingResident).Files)).toEqual([])
  })

  test("locks missing, duplicate, conflicting resource, and residency codes", async () => {
    const { ValidateOfficialPackage } = await LoadValidator()
    const missing = await MutatedFiles(({ owner }) => { owner.resources = [] }, true)
    const duplicate = await MutatedFiles(({ owner }) => { owner.resources.push(Clone(owner.resources[0])) }, true)
    const nativeConflict = await MutatedFiles(({ owner }) => { owner.resources[0].exposure = "native-borrowed" }, true)
    const stopConflict = await MutatedFiles(({ owner }) => { owner.resources[0].stopContract = "application-owned" }, true)
    const residency = await MutatedFiles(({ capability, owner }) => {
      capability.releaseBlocking = false
      capability.residency = "resident"
      owner.resources = [{ id: "server", owner: "likego-owned", exposure: "managed-private", stopContract: "likego-owned" }]
    })
    expect(FailedCodes(ValidateOfficialPackage(Snapshot(missing).Files))).toEqual(["MANIFEST_RESOURCE_MISSING"])
    expect(FailedCodes(ValidateOfficialPackage(Snapshot(duplicate).Files))).toEqual(["MANIFEST_RESOURCE_DUPLICATE"])
    expect(FailedCodes(ValidateOfficialPackage(Snapshot(nativeConflict).Files))).toEqual(["MANIFEST_RESOURCE_CONFLICT"])
    expect(FailedCodes(ValidateOfficialPackage(Snapshot(stopConflict).Files))).toEqual(["MANIFEST_RESOURCE_CONFLICT"])
    expect(FailedCodes(ValidateOfficialPackage(Snapshot(residency).Files))).toEqual(["MANIFEST_RESIDENCY_CONFLICT"])
  })

  test("rejects empty resident runtimes, non-resident resources, and each conflicting resource id", async () => {
    const { ValidateOfficialPackage } = await LoadValidator()
    const emptyResidentRuntimes = await MutatedFiles(({ capability }) => { capability.runtimes = [] }, true)
    const nonResidentResources = await MutatedFiles(({ owner }) => {
      owner.resources = [{ id: "server", owner: "likego-owned", exposure: "managed-private", stopContract: "likego-owned" }]
    })
    const twoConflicts = await MutatedFiles(({ owner }) => {
      owner.resources = [
        { id: "first", owner: "likego-owned", exposure: "native-borrowed", stopContract: "likego-owned" },
        { id: "second", owner: "likego-owned", exposure: "managed-private", stopContract: "application-owned" }
      ]
    }, true)

    expect(FailedCodes(ValidateOfficialPackage(Snapshot(emptyResidentRuntimes).Files))).toEqual(["MANIFEST_RUNTIME_SET"])
    expect(FailedCodes(ValidateOfficialPackage(Snapshot(nonResidentResources).Files))).toEqual(["MANIFEST_RESIDENCY_CONFLICT"])
    expect(FailedCodes(ValidateOfficialPackage(Snapshot(twoConflicts).Files))).toEqual([
      "MANIFEST_RESOURCE_CONFLICT",
      "MANIFEST_RESOURCE_CONFLICT"
    ])
  })

  test("compares exact prerelease tested versions against their declared minimum", async () => {
    const { ValidateOfficialPackage } = await LoadValidator()
    async function VersionCase(tested: string, minimum: string): Promise<readonly TestIssue[]> {
      const files = await OfficialFiles()
      const matrix = JSON.parse(files["config/runtime-matrix.json"]!) as Record<string, any>
      matrix.Lanes[0].Version = tested
      files["config/runtime-matrix.json"] = Json(matrix)
      const capability = JSON.parse(files["packages/fixture/capability.json"]!) as Record<string, any>
      capability.runtimes[0].testedVersions = [tested]
      capability.runtimes[0].minimumVersion = minimum
      files["packages/fixture/capability.json"] = Json(capability)
      return ValidateOfficialPackage(Snapshot(files).Files)
    }

    expect(await VersionCase("1.0.0-alpha", "1.0.0-alpha")).toEqual([])
    expect(FailedCodes(await VersionCase("1.0.0-alpha", "1.0.0-alpha.1"))).toEqual(["MANIFEST_RUNTIME_VERSION"])
    expect(await VersionCase("1.0.0-alpha.2", "1.0.0-alpha.1")).toEqual([])
    expect(await VersionCase("1.0.0-alpha", "1.0.0-1")).toEqual([])
    expect(await VersionCase("1.0.0-beta", "1.0.0-alpha")).toEqual([])
  })

  test("fails closed for duplicate or multiple packages and malformed shared inputs", async () => {
    const { ValidateOfficialPackage } = await LoadValidator()
    const exact = Snapshot(await OfficialFiles())
    const duplicate: InputSnapshot = {
      Sha256: exact.Sha256,
      Files: [...exact.Files, exact.Files[0]!]
    }
    const multiple = await OfficialFiles()
    multiple["packages/other/package.json"] = Json({ name: "@likego/other" })
    multiple["packages/other/capability.json"] = Json(Capability("@likego/other"))
    multiple["packages/other/owner.json"] = Json(Owner("@likego/other"))
    const malformedSchema = await OfficialFiles()
    malformedSchema["schemas/capability-manifest.schema.json"] = "{\n"
    const malformedMatrix = await OfficialFiles()
    malformedMatrix["config/runtime-matrix.json"] = "{\n"
    const wrongLaneShape = await OfficialFiles()
    wrongLaneShape["config/runtime-matrix.json"] = Json({ Lanes: [{}] })
    const malformedPackage = await OfficialFiles()
    malformedPackage["packages/fixture/package.json"] = "{\n"

    for (const files of [
      duplicate.Files,
      Snapshot(multiple).Files,
      Snapshot(malformedSchema).Files,
      Snapshot(malformedMatrix).Files,
      Snapshot(wrongLaneShape).Files,
      Snapshot(malformedPackage).Files
    ]) {
      expect(FailedCodes(ValidateOfficialPackage(files))).toContain("MANIFEST_SCHEMA")
    }
  })
})

describe("CheckOfficialManifests", () => {
  test("discovers only direct packages and adapters and ignores application-owned structural Server files", async () => {
    const { CheckOfficialManifests } = await LoadValidator()
    const files = await OfficialFiles()
    files["packages/group/nested/package.json"] = Json({ name: "@likego/nested" })
    files["examples/custom/server.ts"] = "export const Server = {}\n"
    const evaluation = CheckOfficialManifests(Snapshot(files))
    expect(evaluation.SubjectsChecked).toBe(1)
    expect(GateFailures(evaluation)).toEqual([])
  })

  test("fails an empty official inventory with MANIFEST_PACKAGE_ZERO", async () => {
    const { CheckOfficialManifests } = await LoadValidator()
    const evaluation = CheckOfficialManifests(Snapshot(await SharedFiles()))
    expect(evaluation.SubjectsChecked).toBe(0)
    expect(GateFailures(evaluation)).toEqual(["MANIFEST_PACKAGE_ZERO"])
  })

  test("reports MANIFEST_SCHEMA when a direct official package lacks capability or owner", async () => {
    const { CheckOfficialManifests } = await LoadValidator()
    const missingCapability = await OfficialFiles()
    delete missingCapability["packages/fixture/capability.json"]
    const missingOwner = await OfficialFiles()
    delete missingOwner["packages/fixture/owner.json"]

    for (const files of [missingCapability, missingOwner]) {
      const evaluation = CheckOfficialManifests(Snapshot(files))
      expect(evaluation.SubjectsChecked).toBe(1)
      expect(GateFailures(evaluation)).toEqual(["MANIFEST_SCHEMA"])
    }
  })
})

describe("manifest CLI modes", () => {
  test("fixture mode emits a current-run evaluation-only PASS over the exact complete corpus", async () => {
    const { Main } = await LoadCli()
    const fixturePaths = [
      "schemas/capability-manifest.schema.json",
      "schemas/owner-manifest.schema.json",
      "config/runtime-matrix.json",
      ...await FilesBelow(join(RepositoryRoot, "tools/manifests/fixtures")).then((paths) => paths.map((path) => `tools/manifests/fixtures/${path}`))
    ]
    const root = await NewRoot(fixturePaths)
    await WriteFiles(root, { "packages/not-a-fixture/package.json": "{\n" })
    const stdout: string[] = []
    const stderr: string[] = []
    const exitCode = await Main(["--root", root, "--mode", "fixture", "--run-id", "manifest-fixture-current"], {
      WriteStdout: (value: string) => { stdout.push(value) },
      WriteStderr: (value: string) => { stderr.push(value) }
    })
    const result = JSON.parse(stdout[0]!.slice("LIKEGO_GATE_RESULT=".length)) as Record<string, any>
    const canonical = JSON.parse(await readFile(join(root, ".artifacts/gates/manifest-fixtures.json"), "utf8")) as Record<string, any>
    expect(exitCode).toBe(0)
    expect(stderr).toEqual([])
    expect(result).toEqual(canonical)
    expect({ gate: result.gate, mode: result.mode, status: result.status, readiness: result.releaseReadiness }).toEqual({
      gate: "manifest-fixtures", mode: "fixture", status: "pass", readiness: "not-evaluated"
    })
    expect(result.runId).toBe("manifest-fixture-current")
    expect(result.subjects.expected).toBeGreaterThan(0)
    expect(result.subjects.checked).toBe(result.subjects.expected)
  })

  test("fixture mode snapshots an extra discovered payload and fails the common corpus inventory", async () => {
    const { Main } = await LoadCli()
    const fixturePaths = [
      "schemas/capability-manifest.schema.json",
      "schemas/owner-manifest.schema.json",
      "config/runtime-matrix.json",
      ...await FilesBelow(join(RepositoryRoot, "tools/manifests/fixtures")).then((paths) => paths.map((path) => `tools/manifests/fixtures/${path}`))
    ]
    const root = await NewRoot(fixturePaths)
    await WriteFiles(root, { "tools/manifests/fixtures/unlisted/payload.json": "{}\n" })
    const stdout: string[] = []
    const stderr: string[] = []

    expect(await Main(["--root", root, "--mode", "fixture", "--run-id", "manifest-fixture-extra"], {
      WriteStdout: (value: string) => { stdout.push(value) },
      WriteStderr: (value: string) => { stderr.push(value) }
    })).toBe(1)
    const result = JSON.parse(stdout[0]!.slice("LIKEGO_GATE_RESULT=".length)) as Record<string, any>
    expect(stderr).toEqual([])
    expect(result.checks).toContainEqual(expect.objectContaining({ id: "FIXTURE_INVENTORY_MISMATCH", status: "fail" }))
  })

  test("repository mode with no official package exits one, checks zero, and is not-ready", async () => {
    const { Main } = await LoadCli()
    const root = await NewRoot([
      "schemas/capability-manifest.schema.json",
      "schemas/owner-manifest.schema.json",
      "config/runtime-matrix.json"
    ])
    await WriteFiles(root, { "tools/manifests/fixtures/unlisted/payload.json": "{}\n" })
    const stdout: string[] = []
    const stderr: string[] = []
    expect(await Main(["--root", root, "--mode", "repository", "--run-id", "manifest-repository-zero"], {
      WriteStdout: (value: string) => { stdout.push(value) },
      WriteStderr: (value: string) => { stderr.push(value) }
    })).toBe(1)
    const result = JSON.parse(stdout[0]!.slice("LIKEGO_GATE_RESULT=".length)) as Record<string, any>
    expect(stderr).toEqual([])
    expect({ gate: result.gate, mode: result.mode, status: result.status, readiness: result.releaseReadiness, checked: result.subjects.checked }).toEqual({
      gate: "official-manifests", mode: "repository", status: "fail", readiness: "not-ready", checked: 0
    })
    expect(result.runId).toBe("manifest-repository-zero")
    expect(result.checks).toContainEqual(expect.objectContaining({ id: "MANIFEST_PACKAGE_ZERO", status: "fail" }))
  })

  test("repository mode snapshots one complete direct official package and becomes ready", async () => {
    const { Main } = await LoadCli()
    const root = await NewRoot([])
    await WriteFiles(root, await OfficialFiles())
    await WriteFiles(root, { "packages/ignored.txt": "not an official package directory\n" })
    const stdout: string[] = []
    const stderr: string[] = []

    expect(await Main(["--root", root, "--mode", "repository", "--run-id", "manifest-repository-one"], {
      WriteStdout: (value: string) => { stdout.push(value) },
      WriteStderr: (value: string) => { stderr.push(value) }
    })).toBe(0)
    const result = JSON.parse(stdout[0]!.slice("LIKEGO_GATE_RESULT=".length)) as Record<string, any>
    expect(stderr).toEqual([])
    expect({ status: result.status, readiness: result.releaseReadiness, expected: result.subjects.expected, checked: result.subjects.checked }).toEqual({
      status: "pass", readiness: "ready", expected: 1, checked: 1
    })
    expect(result.checks).toContainEqual(expect.objectContaining({ id: "MANIFEST_PACKAGE_VALID", status: "pass" }))
  })

  test("fails closed for invalid arguments, malformed cases, discovery errors, and emission errors", async () => {
    const { Main } = await LoadCli()
    const stdout: string[] = []
    const stderr: string[] = []
    const io = {
      WriteStdout: (value: string) => { stdout.push(value) },
      WriteStderr: (value: string) => { stderr.push(value) }
    }
    expect(await Main([], io)).toBe(1)

    const malformedRoot = await NewRoot([
      "schemas/capability-manifest.schema.json",
      "schemas/owner-manifest.schema.json",
      "config/runtime-matrix.json"
    ])
    await WriteFiles(malformedRoot, { "tools/manifests/fixtures/cases.json": "{\n" })
    expect(await Main(["--root", malformedRoot, "--mode", "fixture"], io)).toBe(1)

    const fileContainer = await NewRoot([])
    const fileRoot = join(fileContainer, "not-a-directory")
    await Bun.write(fileRoot, "blocked\n")
    expect(await Main(["--root", fileRoot, "--mode", "fixture"], io)).toBe(1)

    const linkedRoot = await NewRoot([])
    await mkdir(join(linkedRoot, "packages"), { recursive: true })
    await Bun.write(join(linkedRoot, "regular-file"), "blocked\n")
    await symlink(join(linkedRoot, "regular-file"), join(linkedRoot, "packages", "linked"))
    expect(await Main(["--root", linkedRoot, "--mode", "repository"], io)).toBe(1)

    const fixturePaths = [
      "schemas/capability-manifest.schema.json",
      "schemas/owner-manifest.schema.json",
      "config/runtime-matrix.json",
      ...await FilesBelow(join(RepositoryRoot, "tools/manifests/fixtures")).then((paths) => paths.map((path) => `tools/manifests/fixtures/${path}`))
    ]
    const emissionRoot = await NewRoot(fixturePaths)
    await Bun.write(join(emissionRoot, ".artifacts"), "blocked\n")
    expect(await Main(["--root", emissionRoot, "--mode", "fixture"], io)).toBe(1)

    expect(stderr[0]).toBe("MANIFEST_USAGE invalid arguments\n")
    expect(stderr.filter((value) => value.startsWith("MANIFEST_DISCOVERY_ERROR "))).toHaveLength(2)
    expect(stderr.some((value) => value.startsWith("MANIFEST_EMIT_ERROR "))).toBe(true)
  })

  test("resolves with a stable emission diagnostic for a non-coercible thrown value", async () => {
    const { Main } = await LoadCli()
    const root = await NewRoot([
      "schemas/capability-manifest.schema.json",
      "schemas/owner-manifest.schema.json",
      "config/runtime-matrix.json"
    ])
    const hostile = {
      [Symbol.toPrimitive](): never {
        throw new Error("coercion escaped")
      }
    }
    const stderr: string[] = []

    await expect(Main(["--root", root, "--mode", "repository", "--run-id", "manifest-hostile-emission"], {
      WriteStdout: () => { throw hostile },
      WriteStderr: (value: string) => { stderr.push(value) }
    })).resolves.toBe(1)
    expect(stderr).toEqual(["MANIFEST_EMIT_ERROR unprintable error\n"])
  })

  test("uses default process IO for generated-run repository output and usage errors", async () => {
    const { Main } = await LoadCli()
    const root = await NewRoot([
      "schemas/capability-manifest.schema.json",
      "schemas/owner-manifest.schema.json",
      "config/runtime-matrix.json"
    ])
    const stdout: string[] = []
    const stderr: string[] = []
    const originalStdout = process.stdout.write
    const originalStderr = process.stderr.write
    process.stdout.write = ((value: string | Uint8Array) => {
      stdout.push(String(value))
      return true
    }) as typeof process.stdout.write
    process.stderr.write = ((value: string | Uint8Array) => {
      stderr.push(String(value))
      return true
    }) as typeof process.stderr.write

    try {
      expect(await Main(["--root", root, "--mode", "repository"])).toBe(1)
      expect(await Main([])).toBe(1)
    } finally {
      process.stdout.write = originalStdout
      process.stderr.write = originalStderr
    }
    expect(stdout).toHaveLength(1)
    expect(stderr).toEqual(["MANIFEST_USAGE invalid arguments\n"])
    const result = JSON.parse(stdout[0]!.slice("LIKEGO_GATE_RESULT=".length)) as Record<string, unknown>
    expect(result.runId).toMatch(/^[a-z0-9][a-z0-9_-]{0,95}$/)
  })
})
