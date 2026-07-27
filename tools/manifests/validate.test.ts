import { afterEach, describe, expect, test } from "bun:test"
import { Ajv2020, type AnySchema } from "ajv/dist/2020.js"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import { tmpdir } from "node:os"
import type { GateEvaluation, InputSnapshot, SnapshotFile } from "../gates/result"
import { discoverWorkspaces } from "../workspaces/discovery"

interface TestIssue {
  readonly Code: string
  readonly Path: string
  readonly Message: string
}

const RepositoryRoot = join(import.meta.dir, "../..")
const TemporaryRoots: string[] = []
const RuntimeRows = [
  {
    runtime: "bun",
    lane: "exact",
    minimumVersion: "1.3.14",
    testedVersions: ["1.3.14"],
    terminalObservability: "not-applicable"
  },
  {
    runtime: "node",
    lane: "lts",
    minimumVersion: "24.18.0",
    testedVersions: ["24.18.0"],
    terminalObservability: "not-applicable"
  },
  {
    runtime: "node",
    lane: "current",
    minimumVersion: "26.5.0",
    testedVersions: ["26.5.0"],
    terminalObservability: "not-applicable"
  },
  {
    runtime: "deno",
    lane: "exact",
    minimumVersion: "2.9.4",
    testedVersions: ["2.9.4"],
    terminalObservability: "not-applicable"
  }
] as const

afterEach(async () => {
  await Promise.all(
    TemporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

async function LoadValidator() {
  return import("./validate")
}

async function LoadCli() {
  return import("./check.cli")
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
  const Files: SnapshotFile[] = Object.entries(files)
    .map(([Path, value]) => {
      const Bytes = encoder.encode(value)
      return { Path, RealPath: join("/virtual/manifests", Path), Sha256: Sha256(Bytes), Bytes }
    })
    .sort((left, right) => (left.Path < right.Path ? -1 : left.Path > right.Path ? 1 : 0))
  return { Sha256: Sha256(Files.map((file) => `${file.Path}\0${file.Sha256}\n`).join("")), Files }
}

async function SharedFiles(): Promise<Record<string, string>> {
  const paths = [
    "schemas/capability-manifest.schema.json",
    "schemas/owner-manifest.schema.json",
    "config/runtime-matrix.json"
  ]
  return Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => [path, await readFile(join(RepositoryRoot, path), "utf8")] as const)
    )
  )
}

function Capability(name: string, resident = false): Record<string, any> {
  const runtimes = Clone(
    resident ? RuntimeRows.filter((row) => row.runtime === "node") : RuntimeRows
  ) as Array<Record<string, any>>
  if (resident) {
    for (const runtime of runtimes) runtime.terminalObservability = "observable"
  }
  return {
    schemaVersion: 2,
    package: name,
    packageKind: resident ? "integration" : "portable",
    stability: resident ? "beta" : "stable",
    releaseBlocking: true,
    exports: {
      ".": {
        kind: resident ? "integration" : "portable",
        residency: resident ? "resident" : "non-resident",
        ownerResources: resident ? ["server", "native-client"] : [],
        capabilities: [resident ? "server" : "web"],
        runtimes
      }
    }
  }
}

function RootExport(capability: Record<string, any>): Record<string, any> {
  return capability.exports["."] as Record<string, any>
}

function Owner(name: string, resident = false): Record<string, any> {
  return {
    schemaVersion: 1,
    package: name,
    resources: resident
      ? [
          {
            id: "server",
            owner: "likego-owned",
            exposure: "managed-private",
            stopContract: "likego-owned"
          },
          {
            id: "native-client",
            owner: "application-owned",
            exposure: "native-borrowed",
            stopContract: "application-owned"
          }
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
    ...(await SharedFiles()),
    [`${directory}/package.json`]: Json({
      name,
      version: "0.1.0",
      private: false,
      type: "module",
      exports: { ".": "./dist/index.js" }
    }),
    [`${directory}/capability.json`]: Json(Capability(name, resident)),
    [`${directory}/owner.json`]: Json(Owner(name, resident))
  }
}

async function CurrentOfficialFiles(
  directory = "packages/context"
): Promise<Record<string, string>> {
  const absolute = join(RepositoryRoot, directory)
  const files = await SharedFiles()
  const rootManifest = JSON.parse(
    await readFile(join(RepositoryRoot, "package.json"), "utf8")
  ) as Record<string, unknown>
  rootManifest.workspaces = [directory]
  files["package.json"] = Json(rootManifest)
  for (const path of await FilesBelow(absolute)) {
    files[`${directory}/${path}`] = await readFile(join(absolute, path), "utf8")
  }
  return files
}

function FailedCodes(issues: readonly TestIssue[]): string[] {
  return issues.map((issue) => issue.Code).sort()
}

function GateFailures(evaluation: GateEvaluation): string[] {
  return evaluation.Checks.filter((check) => check.status === "fail").map((check) => check.id)
}

async function MutatedFiles(
  mutate: (values: {
    packageJson: Record<string, any>
    capability: Record<string, any>
    owner: Record<string, any>
  }) => void,
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
  await Bun.write(
    join(root, "package.json"),
    Json({
      name: "likego-manifest-fixture",
      private: true,
      workspaces: ["packages/*", "adapters/*", "examples/*"]
    })
  )
  return root
}

async function WriteFiles(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [path, value] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await Bun.write(join(root, path), value)
  }
}

async function WritePrivateWorkspace(root: string): Promise<void> {
  await WriteFiles(root, {
    "examples/private/package.json": Json({ name: "@likego/example-private", private: true })
  })
}

describe("manifest schemas", () => {
  test("compile strictly, freeze top-level fields, and close nested objects", async () => {
    const ajv = new Ajv2020({ strict: true, allErrors: true })
    const capability = JSON.parse(
      await readFile(join(RepositoryRoot, "schemas/capability-manifest.schema.json"), "utf8")
    ) as AnySchema
    const owner = JSON.parse(
      await readFile(join(RepositoryRoot, "schemas/owner-manifest.schema.json"), "utf8")
    ) as AnySchema
    expect(() => ajv.compile(capability)).not.toThrow()
    expect(() => ajv.compile(owner)).not.toThrow()
    expect((capability as Record<string, any>).additionalProperties).toBe(false)
    expect((capability as Record<string, any>).required.sort()).toEqual([
      "exports",
      "package",
      "packageKind",
      "releaseBlocking",
      "schemaVersion",
      "stability"
    ])
    expect(Object.keys((capability as Record<string, any>).properties).sort()).toEqual([
      "exports",
      "package",
      "packageKind",
      "releaseBlocking",
      "schemaVersion",
      "stability"
    ])
    expect((capability as Record<string, any>).properties.schemaVersion.const).toBe(2)
    expect((capability as Record<string, any>).properties.packageKind.enum).toEqual([
      "portable",
      "integration",
      "hybrid"
    ])
    expect((capability as Record<string, any>).properties.exports.minProperties).toBe(1)
    expect((capability as Record<string, any>).$defs.export.additionalProperties).toBe(false)
    expect((capability as Record<string, any>).$defs.export.required.sort()).toEqual([
      "capabilities",
      "kind",
      "ownerResources",
      "residency",
      "runtimes"
    ])
    expect(Object.keys((capability as Record<string, any>).$defs.export.properties).sort()).toEqual(
      ["capabilities", "kind", "ownerResources", "residency", "runtimes"]
    )
    expect((capability as Record<string, any>).$defs.export.properties.capabilities.minItems).toBe(
      1
    )
    expect(
      (capability as Record<string, any>).$defs.export.properties.capabilities.uniqueItems
    ).toBe(true)
    expect(
      (capability as Record<string, any>).$defs.export.properties.ownerResources.uniqueItems
    ).toBe(true)
    expect(
      (capability as Record<string, any>).$defs.export.properties.capabilities.items.enum
    ).toContain("context")
    expect(
      (capability as Record<string, any>).$defs.export.properties.capabilities.items.enum
    ).not.toContain("grpc")
    expect((capability as Record<string, any>).$defs.runtime.additionalProperties).toBe(false)
    expect((owner as Record<string, any>).additionalProperties).toBe(false)
    expect(Object.keys((owner as Record<string, any>).properties).sort()).toEqual([
      "package",
      "resources",
      "schemaVersion"
    ])
    expect((owner as Record<string, any>).$defs.resource.additionalProperties).toBe(false)
  })

  test("keeps exactly one legacy-v1 fixture whose expected result is schema rejection", async () => {
    const fixtureRoot = join(RepositoryRoot, "tools/manifests/fixtures")
    const capabilityPaths = (await FilesBelow(fixtureRoot)).filter((path) =>
      path.endsWith("/capability.json")
    )
    const legacyPaths: string[] = []
    for (const path of capabilityPaths) {
      const capability = JSON.parse(await readFile(join(fixtureRoot, path), "utf8")) as Record<
        string,
        any
      >
      if (capability.schemaVersion === 1) legacyPaths.push(path)
    }
    const cases = JSON.parse(await readFile(join(fixtureRoot, "cases.json"), "utf8")) as Record<
      string,
      any
    >
    const legacyCase = cases.cases.find(
      (entry: Record<string, any>) => entry.path === "invalid/schema"
    )

    expect(legacyPaths).toEqual(["invalid/schema/packages/schema-fixture/capability.json"])
    expect(legacyCase).toEqual({
      id: "invalid-schema",
      path: "invalid/schema",
      expectedCodes: ["MANIFEST_SCHEMA"]
    })
  })

  test("admits exactly the reviewed capability vocabulary", async () => {
    const { officialCapabilityVocabulary } = await import("./capability-vocabulary")
    const capability = JSON.parse(
      await readFile(join(RepositoryRoot, "schemas/capability-manifest.schema.json"), "utf8")
    ) as Record<string, any>
    const schemaClaims = capability.$defs.export.properties.capabilities.items
      .enum as readonly string[]
    const reviewedClaims = Object.values(officialCapabilityVocabulary).flatMap((exports) =>
      Object.values(exports).flatMap((claims) => Object.keys(claims))
    )

    expect(schemaClaims).toEqual([...new Set(reviewedClaims)].sort())
  })
})

describe("final release capability inventory", () => {
  test("locks all 46 current package identities to their 67 public export keys", async () => {
    const expected = {
      "@likego/broker": [".", "./provider"],
      "@likego/broker-memory": ["."],
      "@likego/broker-rabbitmq": ["."],
      "@likego/bullmq": ["."],
      "@likego/cache": [".", "./provider"],
      "@likego/cache-memory": ["."],
      "@likego/cache-redis": ["."],
      "@likego/client": ["."],
      "@likego/config": [".", "./env", "./file", "./node", "./yaml"],
      "@likego/config-consul": ["."],
      "@likego/config-etcd": ["."],
      "@likego/config-kubernetes": ["."],
      "@likego/config-vault": ["."],
      "@likego/context": ["."],
      "@likego/core": [".", "./lifecycle", "./node"],
      "@likego/create": ["."],
      "@likego/croner": ["."],
      "@likego/elysia": ["."],
      "@likego/event": ["."],
      "@likego/h3": ["."],
      "@likego/health": ["."],
      "@likego/hono": ["."],
      "@likego/metadata": ["."],
      "@likego/nats": [".", "./broker", "./jetstream", "./jetstream/broker"],
      "@likego/otel": ["."],
      "@likego/pino": ["."],
      "@likego/prometheus": ["."],
      "@likego/registry": [".", "./provider"],
      "@likego/registry-consul": ["."],
      "@likego/registry-etcd": ["."],
      "@likego/registry-kubernetes": ["."],
      "@likego/registry-mdns": [".", "./node"],
      "@likego/registry-zookeeper": ["."],
      "@likego/resilience": ["."],
      "@likego/server": ["."],
      "@likego/store": [".", "./provider"],
      "@likego/store-consul": ["."],
      "@likego/store-etcd": ["."],
      "@likego/store-file": [".", "./node"],
      "@likego/store-memory": ["."],
      "@likego/store-vault": ["."],
      "@likego/transport": [".", "./headers", "./json", "./provider"],
      "@likego/transport-http": [".", "./node"],
      "@likego/transport-memory": ["."],
      "@likego/web": [".", "./health", "./node"],
      "@likego/winston": ["."]
    }
    const workspaces = (await discoverWorkspaces(RepositoryRoot)).filter(
      (workspace) => !workspace.private
    )
    const actual: Record<string, readonly string[]> = {}
    for (const workspace of workspaces) {
      const capability = await Bun.file(
        join(RepositoryRoot, workspace.root, "capability.json")
      ).json()
      actual[workspace.name] = Object.keys(capability.exports).sort()
    }

    expect(actual).toEqual(expected)
    expect(Object.values(actual).reduce((total, exports) => total + exports.length, 0)).toBe(67)
  })
})

describe("validateOfficialPackage", () => {
  test("enumerates one frozen, sorted, deduplicated evidence inventory across portable packages and adapters", async () => {
    const { officialCapabilityEvidencePaths } = await import("./capability-vocabulary")
    const paths = officialCapabilityEvidencePaths()

    expect(Object.isFrozen(paths)).toBe(true)
    expect(paths).toEqual([...new Set(paths)].sort())
    expect(paths).toContain("packages/context/src/cancel.ts")
    expect(paths).toContain("packages/nats/test/e2e/core-docker-e2e.ts")
    expect(
      await Promise.all(paths.map(async (path) => Bun.file(join(RepositoryRoot, path)).exists()))
    ).not.toContain(false)
  })

  test("accepts portable packages with truthful residency and resident integrations", async () => {
    const { validateOfficialPackage } = await LoadValidator()
    expect(validateOfficialPackage(Snapshot(await OfficialFiles()).Files)).toEqual([])
    const portableResident = await OfficialFiles()
    const portableCapability = JSON.parse(
      portableResident["packages/fixture/capability.json"]!
    ) as Record<string, any>
    RootExport(portableCapability).residency = "resident"
    RootExport(portableCapability).ownerResources = ["server", "native-client"]
    for (const runtime of RootExport(portableCapability).runtimes)
      runtime.terminalObservability = "observable"
    portableResident["packages/fixture/capability.json"] = Json(portableCapability)
    portableResident["packages/fixture/owner.json"] = Json(Owner("@likego/fixture", true))
    expect(validateOfficialPackage(Snapshot(portableResident).Files)).toEqual([])
    expect(
      validateOfficialPackage(
        Snapshot(await OfficialFiles("adapters/fixture", "@likego/fixture", true)).Files
      )
    ).toEqual([])
  })

  test("accepts a truthful non-resident portable export under the adapters directory", async () => {
    const { validateOfficialPackage } = await LoadValidator()
    const directory = "adapters/fixture"
    const files = await OfficialFiles(directory, "@likego/fixture")
    expect(validateOfficialPackage(Snapshot(files).Files)).toEqual([])
  })

  test("derives package kind from exports and never from the physical directory", async () => {
    const { validateOfficialPackage } = await LoadValidator()
    const portableInAdapters = await OfficialFiles("adapters/fixture", "@likego/fixture")
    const integrationInPackages = await OfficialFiles()
    const capabilityPath = "packages/fixture/capability.json"
    const packageCapability = JSON.parse(integrationInPackages[capabilityPath]!) as Record<
      string,
      any
    >
    packageCapability.packageKind = "integration"
    RootExport(packageCapability).kind = "integration"
    integrationInPackages[capabilityPath] = Json(packageCapability)

    expect(validateOfficialPackage(Snapshot(portableInAdapters).Files)).toEqual([])
    expect(validateOfficialPackage(Snapshot(integrationInPackages).Files)).toEqual([])
  })

  test("matches every business export exactly while ignoring only package metadata", async () => {
    const { validateOfficialPackage } = await LoadValidator()
    const metadataExport = await MutatedFiles(({ packageJson }) => {
      packageJson.exports["./package.json"] = "./package.json"
    })
    const packageOnly = await MutatedFiles(({ packageJson }) => {
      packageJson.exports["./testing"] = "./dist/testing.js"
    })
    const capabilityOnly = await MutatedFiles(({ capability }) => {
      capability.exports["./testing"] = Clone(RootExport(capability))
    })
    const missingRoot = await MutatedFiles(({ packageJson }) => {
      delete packageJson.exports["."]
    })

    expect(validateOfficialPackage(Snapshot(metadataExport).Files)).toEqual([])
    expect(FailedCodes(validateOfficialPackage(Snapshot(packageOnly).Files))).toEqual([
      "MANIFEST_EXPORT_MISMATCH"
    ])
    expect(FailedCodes(validateOfficialPackage(Snapshot(capabilityOnly).Files))).toEqual([
      "MANIFEST_EXPORT_MISMATCH"
    ])
    expect(FailedCodes(validateOfficialPackage(Snapshot(missingRoot).Files))).toEqual([
      "MANIFEST_SCHEMA"
    ])
  })

  test("validates hybrid package kind and runtime lanes independently for each export", async () => {
    const { validateOfficialPackage } = await LoadValidator()
    const files = await OfficialFiles()
    const packagePath = "packages/fixture/package.json"
    const capabilityPath = "packages/fixture/capability.json"
    const ownerPath = "packages/fixture/owner.json"
    const packageJson = JSON.parse(files[packagePath]!) as Record<string, any>
    const capability = JSON.parse(files[capabilityPath]!) as Record<string, any>
    const nodeRuntimes = Clone(RuntimeRows.filter((row) => row.runtime === "node")) as Array<
      Record<string, any>
    >
    for (const runtime of nodeRuntimes) runtime.terminalObservability = "observable"
    packageJson.exports["./node"] = "./dist/node.js"
    capability.packageKind = "hybrid"
    capability.exports["./node"] = {
      kind: "integration",
      residency: "resident",
      ownerResources: ["server"],
      capabilities: ["server"],
      runtimes: nodeRuntimes
    }
    files[packagePath] = Json(packageJson)
    files[capabilityPath] = Json(capability)
    files[ownerPath] = Json({
      schemaVersion: 1,
      package: "@likego/fixture",
      resources: [
        {
          id: "server",
          owner: "likego-owned",
          exposure: "managed-private",
          stopContract: "likego-owned"
        }
      ]
    })

    expect(validateOfficialPackage(Snapshot(files).Files)).toEqual([])

    const wrongKind = Clone(files)
    const wrongCapability = JSON.parse(wrongKind[capabilityPath]!) as Record<string, any>
    wrongCapability.packageKind = "portable"
    wrongKind[capabilityPath] = Json(wrongCapability)
    expect(FailedCodes(validateOfficialPackage(Snapshot(wrongKind).Files))).toEqual([
      "MANIFEST_PACKAGE_KIND"
    ])

    const missingNodeLane = Clone(files)
    const missingLaneCapability = JSON.parse(missingNodeLane[capabilityPath]!) as Record<
      string,
      any
    >
    missingLaneCapability.exports["./node"].runtimes.pop()
    missingNodeLane[capabilityPath] = Json(missingLaneCapability)
    expect(validateOfficialPackage(Snapshot(missingNodeLane).Files)).toContainEqual(
      expect.objectContaining({
        Code: "MANIFEST_NODE_LANES",
        Message: expect.stringContaining("./node")
      })
    )
  })

  test("returns stable schema and package mismatch codes without cascades", async () => {
    const { validateOfficialPackage } = await LoadValidator()
    const schema = await MutatedFiles(({ capability }) => {
      capability.extra = true
    })
    const emptyCapabilities = await MutatedFiles(({ capability }) => {
      RootExport(capability).capabilities = []
    })
    const inventedCapability = await MutatedFiles(({ capability }) => {
      RootExport(capability).capabilities = ["grpc"]
    })
    const mismatch = await MutatedFiles(({ owner }) => {
      owner.package = "@likego/other"
    })
    expect(FailedCodes(validateOfficialPackage(Snapshot(schema).Files))).toEqual([
      "MANIFEST_SCHEMA"
    ])
    expect(FailedCodes(validateOfficialPackage(Snapshot(emptyCapabilities).Files))).toEqual([
      "MANIFEST_SCHEMA"
    ])
    expect(FailedCodes(validateOfficialPackage(Snapshot(inventedCapability).Files))).toEqual([
      "MANIFEST_SCHEMA"
    ])
    expect(FailedCodes(validateOfficialPackage(Snapshot(mismatch).Files))).toEqual([
      "MANIFEST_PACKAGE_MISMATCH"
    ])
  })

  test("locks runtime set, exact-version, Node-lane, and terminal observability codes", async () => {
    const { validateOfficialPackage } = await LoadValidator()
    const runtimeSet = await MutatedFiles(({ capability }) => {
      RootExport(capability).runtimes.pop()
    })
    const runtimeVersionDrift = await MutatedFiles(({ capability }) => {
      RootExport(capability).runtimes[0].testedVersions = ["1.3.15"]
    })
    const runtimeVersionBelowMinimum = await MutatedFiles(({ capability }) => {
      RootExport(capability).runtimes[0].minimumVersion = "2.0.0"
    })
    const nodeLanes = await MutatedFiles(({ capability }) => {
      RootExport(capability).runtimes[2].lane = "lts"
    })
    const terminal = await MutatedFiles(({ capability }) => {
      RootExport(capability).runtimes[0].terminalObservability = "not-applicable"
    }, true)
    expect(FailedCodes(validateOfficialPackage(Snapshot(runtimeSet).Files))).toEqual([
      "MANIFEST_RUNTIME_SET"
    ])
    expect(FailedCodes(validateOfficialPackage(Snapshot(runtimeVersionDrift).Files))).toEqual([
      "MANIFEST_RUNTIME_VERSION"
    ])
    expect(
      FailedCodes(validateOfficialPackage(Snapshot(runtimeVersionBelowMinimum).Files))
    ).toEqual(["MANIFEST_RUNTIME_VERSION"])
    expect(FailedCodes(validateOfficialPackage(Snapshot(nodeLanes).Files))).toEqual([
      "MANIFEST_NODE_LANES"
    ])
    expect(FailedCodes(validateOfficialPackage(Snapshot(terminal).Files))).toEqual([
      "MANIFEST_TERMINAL_OBSERVABILITY"
    ])
  })

  test("separates terminal observability truth from release-gate participation", async () => {
    const { validateOfficialPackage } = await LoadValidator()
    const portableTerminal = await MutatedFiles(({ capability }) => {
      RootExport(capability).runtimes[0].terminalObservability = "observable"
    })
    const nonBlockingResident = await MutatedFiles(({ capability }) => {
      capability.releaseBlocking = false
      for (const runtime of RootExport(capability).runtimes)
        runtime.terminalObservability = "unobservable"
    }, true)
    const blockingUnobservableResident = await MutatedFiles(({ capability }) => {
      capability.releaseBlocking = true
      for (const runtime of RootExport(capability).runtimes)
        runtime.terminalObservability = "unobservable"
    }, true)

    expect(FailedCodes(validateOfficialPackage(Snapshot(portableTerminal).Files))).toEqual([
      "MANIFEST_TERMINAL_OBSERVABILITY"
    ])
    expect(validateOfficialPackage(Snapshot(nonBlockingResident).Files)).toEqual([])
    expect(validateOfficialPackage(Snapshot(blockingUnobservableResident).Files)).toEqual([])
  })

  test("locks missing, duplicate, and conflicting resource codes", async () => {
    const { validateOfficialPackage } = await LoadValidator()
    const missing = await MutatedFiles(({ capability, owner }) => {
      RootExport(capability).ownerResources = ["server"]
      owner.resources = []
    }, true)
    const duplicate = await MutatedFiles(({ owner }) => {
      owner.resources.push(Clone(owner.resources[0]))
    }, true)
    const splitLifecycle = await MutatedFiles(({ owner }) => {
      owner.resources[1].stopContract = "likego-owned"
    }, true)
    const nativeConflict = await MutatedFiles(({ owner }) => {
      owner.resources[0].exposure = "native-borrowed"
    }, true)
    const stopConflict = await MutatedFiles(({ owner }) => {
      owner.resources[0].stopContract = "application-owned"
    }, true)
    expect(FailedCodes(validateOfficialPackage(Snapshot(missing).Files))).toEqual([
      "MANIFEST_RESOURCE_MISSING"
    ])
    expect(FailedCodes(validateOfficialPackage(Snapshot(duplicate).Files))).toEqual([
      "MANIFEST_RESOURCE_DUPLICATE"
    ])
    expect(validateOfficialPackage(Snapshot(splitLifecycle).Files)).toEqual([])
    expect(FailedCodes(validateOfficialPackage(Snapshot(nativeConflict).Files))).toEqual([
      "MANIFEST_RESOURCE_CONFLICT"
    ])
    expect(FailedCodes(validateOfficialPackage(Snapshot(stopConflict).Files))).toEqual([
      "MANIFEST_RESOURCE_CONFLICT"
    ])
  })

  test("rejects empty resident runtimes, non-resident resources, and each conflicting resource id", async () => {
    const { validateOfficialPackage } = await LoadValidator()
    const emptyResidentRuntimes = await MutatedFiles(({ capability }) => {
      RootExport(capability).runtimes = []
    }, true)
    const nonResidentResources = await MutatedFiles(({ owner }) => {
      owner.resources = [
        {
          id: "server",
          owner: "likego-owned",
          exposure: "managed-private",
          stopContract: "likego-owned"
        }
      ]
    })
    const twoConflicts = await MutatedFiles(({ capability, owner }) => {
      RootExport(capability).ownerResources = ["first", "second"]
      owner.resources = [
        {
          id: "first",
          owner: "likego-owned",
          exposure: "native-borrowed",
          stopContract: "likego-owned"
        },
        {
          id: "second",
          owner: "likego-owned",
          exposure: "managed-private",
          stopContract: "application-owned"
        }
      ]
    }, true)

    expect(FailedCodes(validateOfficialPackage(Snapshot(emptyResidentRuntimes).Files))).toEqual([
      "MANIFEST_RUNTIME_SET"
    ])
    expect(FailedCodes(validateOfficialPackage(Snapshot(nonResidentResources).Files))).toEqual([
      "MANIFEST_RESIDENCY_CONFLICT"
    ])
    expect(FailedCodes(validateOfficialPackage(Snapshot(twoConflicts).Files))).toEqual([
      "MANIFEST_RESOURCE_CONFLICT",
      "MANIFEST_RESOURCE_CONFLICT"
    ])
  })

  test("enforces owner resource references at each export residency boundary", async () => {
    const { validateOfficialPackage } = await LoadValidator()
    const residentWithoutResources = await MutatedFiles(({ capability, owner }) => {
      RootExport(capability).ownerResources = []
      owner.resources = []
    }, true)
    const nonResidentWithResources = await MutatedFiles(({ capability, owner }) => {
      RootExport(capability).ownerResources = ["server"]
      owner.resources = [
        {
          id: "server",
          owner: "likego-owned",
          exposure: "managed-private",
          stopContract: "likego-owned"
        }
      ]
    })

    expect(FailedCodes(validateOfficialPackage(Snapshot(residentWithoutResources).Files))).toEqual([
      "MANIFEST_RESOURCE_MISSING"
    ])
    expect(FailedCodes(validateOfficialPackage(Snapshot(nonResidentWithResources).Files))).toEqual([
      "MANIFEST_RESIDENCY_CONFLICT"
    ])
  })

  test("compares exact prerelease tested versions against their declared minimum", async () => {
    const { validateOfficialPackage } = await LoadValidator()
    async function VersionCase(tested: string, minimum: string): Promise<readonly TestIssue[]> {
      const files = await OfficialFiles()
      const matrix = JSON.parse(files["config/runtime-matrix.json"]!) as Record<string, any>
      matrix.Lanes[0].Version = tested
      files["config/runtime-matrix.json"] = Json(matrix)
      const capability = JSON.parse(files["packages/fixture/capability.json"]!) as Record<
        string,
        any
      >
      RootExport(capability).runtimes[0].testedVersions = [tested]
      RootExport(capability).runtimes[0].minimumVersion = minimum
      files["packages/fixture/capability.json"] = Json(capability)
      return validateOfficialPackage(Snapshot(files).Files)
    }

    expect(await VersionCase("1.0.0-alpha", "1.0.0-alpha")).toEqual([])
    expect(FailedCodes(await VersionCase("1.0.0-alpha", "1.0.0-alpha.1"))).toEqual([
      "MANIFEST_RUNTIME_VERSION"
    ])
    expect(await VersionCase("1.0.0-alpha.2", "1.0.0-alpha.1")).toEqual([])
    expect(await VersionCase("1.0.0-alpha", "1.0.0-1")).toEqual([])
    expect(await VersionCase("1.0.0-beta", "1.0.0-alpha")).toEqual([])
  })

  test("fails closed for duplicate or multiple packages and malformed shared inputs", async () => {
    const { validateOfficialPackage } = await LoadValidator()
    const exact = Snapshot(await OfficialFiles())
    const duplicate: InputSnapshot = {
      Sha256: exact.Sha256,
      Files: [...exact.Files, exact.Files[0]!]
    }
    const multiple = await OfficialFiles()
    multiple["packages/other/package.json"] = Json({
      name: "@likego/other",
      exports: { ".": "./dist/index.js" }
    })
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
      expect(FailedCodes(validateOfficialPackage(files))).toContain("MANIFEST_SCHEMA")
    }
  })

  test("rejects a structurally complete capability manifest v1 in repository mode", async () => {
    const { checkOfficialManifests } = await LoadValidator()
    const files = await CurrentOfficialFiles()
    files["packages/context/capability.json"] = Json({
      schemaVersion: 1,
      package: "@likego/context",
      packageKind: "portable",
      stability: "provisional",
      releaseBlocking: true,
      residency: "non-resident",
      capabilities: ["context"],
      runtimes: Clone(RuntimeRows)
    })

    expect(GateFailures(checkOfficialManifests(Snapshot(files), ["packages/context"]))).toEqual([
      "MANIFEST_SCHEMA"
    ])
  })
})

describe("checkOfficialManifests", () => {
  test("uses snapshotted canonical package groups and ignores application-owned structural Server files", async () => {
    const { checkOfficialManifests } = await LoadValidator()
    const files = await CurrentOfficialFiles()
    files["examples/custom/server.ts"] = "export const Server = {}\n"
    const evaluation = checkOfficialManifests(Snapshot(files), ["packages/context"])
    expect(evaluation.SubjectsChecked).toBe(1)
    expect(GateFailures(evaluation)).toEqual([])
  })

  test("fails an empty official inventory with MANIFEST_PACKAGE_ZERO", async () => {
    const { checkOfficialManifests } = await LoadValidator()
    const evaluation = checkOfficialManifests(Snapshot(await SharedFiles()), [])
    expect(evaluation.SubjectsChecked).toBe(0)
    expect(GateFailures(evaluation)).toEqual(["MANIFEST_PACKAGE_ZERO"])
  })

  test("fails closed for non-canonical or duplicate subject directories", async () => {
    const { checkOfficialManifests } = await LoadValidator()
    const snapshot = Snapshot(await SharedFiles())

    for (const subjectDirectories of [
      ["context"],
      ["tools/context"],
      ["packages/../context"],
      ["packages/context", "packages/context"]
    ]) {
      expect(checkOfficialManifests(snapshot, subjectDirectories)).toEqual({
        SubjectsChecked: 0,
        Checks: [
          {
            id: "MANIFEST_PACKAGE_INVENTORY",
            status: "fail",
            expected: "unique canonical public workspace roots",
            detail: "canonical public workspace roots must be normalized package directories"
          }
        ]
      })
    }
  })

  test("reports MANIFEST_SCHEMA when a direct official package lacks capability or owner", async () => {
    const { checkOfficialManifests } = await LoadValidator()
    const missingCapability = await CurrentOfficialFiles()
    delete missingCapability["packages/context/capability.json"]
    const missingOwner = await CurrentOfficialFiles()
    delete missingOwner["packages/context/owner.json"]

    for (const files of [missingCapability, missingOwner]) {
      const evaluation = checkOfficialManifests(Snapshot(files), ["packages/context"])
      expect(evaluation.SubjectsChecked).toBe(1)
      expect(GateFailures(evaluation)).toEqual(["MANIFEST_SCHEMA"])
    }
  })

  test("fails closed when a vocabulary claim is assigned to the wrong package or loses bound evidence", async () => {
    const { checkOfficialManifests, validateOfficialPackage } = await LoadValidator()
    expect(
      FailedCodes(validateOfficialPackage(Snapshot(await OfficialFiles()).Files, true))
    ).toEqual(["MANIFEST_CAPABILITY_PACKAGE"])

    const wrongClaim = await CurrentOfficialFiles()
    const capability = JSON.parse(wrongClaim["packages/context/capability.json"]!) as Record<
      string,
      any
    >
    RootExport(capability).capabilities = ["web"]
    wrongClaim["packages/context/capability.json"] = Json(capability)
    expect(
      GateFailures(checkOfficialManifests(Snapshot(wrongClaim), ["packages/context"]))
    ).toEqual(["MANIFEST_CAPABILITY_CONTRACT"])

    const missingEvidence = await CurrentOfficialFiles()
    delete missingEvidence["packages/context/test/deadline.test.ts"]
    expect(
      GateFailures(checkOfficialManifests(Snapshot(missingEvidence), ["packages/context"]))
    ).toEqual(["MANIFEST_CAPABILITY_EVIDENCE"])

    const { officialCapabilityVocabulary } = await import("./capability-vocabulary")
    const contracts = officialCapabilityVocabulary["@likego/context"]?.["."] as Record<
      string,
      {
        readonly code: readonly string[]
        readonly tests: readonly string[]
      }
    >
    const original = contracts.context
    contracts.context = { code: [], tests: original!.tests }
    try {
      expect(
        GateFailures(
          checkOfficialManifests(Snapshot(await CurrentOfficialFiles()), ["packages/context"])
        )
      ).toEqual(["MANIFEST_CAPABILITY_EVIDENCE"])
    } finally {
      contracts.context = original!
    }

    contracts.context = { code: original!.code, tests: [] }
    try {
      expect(
        GateFailures(
          checkOfficialManifests(Snapshot(await CurrentOfficialFiles()), ["packages/context"])
        )
      ).toEqual(["MANIFEST_CAPABILITY_EVIDENCE"])
    } finally {
      contracts.context = original!
    }
  })

  test("binds capability vocabulary and evidence to the precise public subpath", async () => {
    const { checkOfficialManifests } = await LoadValidator()
    const wrongClaim = await CurrentOfficialFiles("packages/core")
    const capabilityPath = "packages/core/capability.json"
    const capability = JSON.parse(wrongClaim[capabilityPath]!) as Record<string, any>
    capability.exports["./lifecycle"].capabilities = ["registry"]
    wrongClaim[capabilityPath] = Json(capability)
    const wrongClaimChecks = checkOfficialManifests(Snapshot(wrongClaim), [
      "packages/core"
    ]).Checks.filter((check) => check.status === "fail")

    expect(wrongClaimChecks).toEqual([
      expect.objectContaining({
        id: "MANIFEST_CAPABILITY_CONTRACT",
        detail: expect.stringContaining("./lifecycle")
      })
    ])

    const missingEvidence = await CurrentOfficialFiles("packages/core")
    delete missingEvidence["packages/core/test/public-api.test.ts"]
    const missingEvidenceChecks = checkOfficialManifests(Snapshot(missingEvidence), [
      "packages/core"
    ]).Checks.filter((check) => check.status === "fail")
    expect(missingEvidenceChecks).toEqual([
      expect.objectContaining({
        id: "MANIFEST_CAPABILITY_EVIDENCE",
        detail: expect.stringContaining("./lifecycle capability lifecycle")
      })
    ])
  })
})

describe("manifest CLI modes", () => {
  test("fixture mode emits a current-run evaluation-only PASS over the exact complete corpus", async () => {
    const { main } = await LoadCli()
    const fixturePaths = [
      "schemas/capability-manifest.schema.json",
      "schemas/owner-manifest.schema.json",
      "config/runtime-matrix.json",
      ...(await FilesBelow(join(RepositoryRoot, "tools/manifests/fixtures")).then((paths) =>
        paths.map((path) => `tools/manifests/fixtures/${path}`)
      ))
    ]
    const root = await NewRoot(fixturePaths)
    await WriteFiles(root, { "packages/not-a-fixture/package.json": "{\n" })
    const stdout: string[] = []
    const stderr: string[] = []
    const exitCode = await main(
      ["--root", root, "--mode", "fixture", "--run-id", "manifest-fixture-current"],
      {
        WriteStdout: (value: string) => {
          stdout.push(value)
        },
        WriteStderr: (value: string) => {
          stderr.push(value)
        }
      }
    )
    const result = JSON.parse(stdout[0]!.slice("LIKEGO_GATE_RESULT=".length)) as Record<string, any>
    const canonical = JSON.parse(
      await readFile(join(root, ".artifacts/gates/manifest-fixtures.json"), "utf8")
    ) as Record<string, any>
    expect(exitCode).toBe(0)
    expect(stderr).toEqual([])
    expect(result).toEqual(canonical)
    expect({
      gate: result.gate,
      mode: result.mode,
      status: result.status,
      readiness: result.releaseReadiness
    }).toEqual({
      gate: "manifest-fixtures",
      mode: "fixture",
      status: "pass",
      readiness: "not-evaluated"
    })
    expect(result.runId).toBe("manifest-fixture-current")
    expect(result.subjects.expected).toBeGreaterThan(0)
    expect(result.subjects.checked).toBe(result.subjects.expected)
  })

  test("fixture mode snapshots an extra discovered payload and fails the common corpus inventory", async () => {
    const { main } = await LoadCli()
    const fixturePaths = [
      "schemas/capability-manifest.schema.json",
      "schemas/owner-manifest.schema.json",
      "config/runtime-matrix.json",
      ...(await FilesBelow(join(RepositoryRoot, "tools/manifests/fixtures")).then((paths) =>
        paths.map((path) => `tools/manifests/fixtures/${path}`)
      ))
    ]
    const root = await NewRoot(fixturePaths)
    await WriteFiles(root, { "tools/manifests/fixtures/unlisted/payload.json": "{}\n" })
    const stdout: string[] = []
    const stderr: string[] = []

    expect(
      await main(["--root", root, "--mode", "fixture", "--run-id", "manifest-fixture-extra"], {
        WriteStdout: (value: string) => {
          stdout.push(value)
        },
        WriteStderr: (value: string) => {
          stderr.push(value)
        }
      })
    ).toBe(1)
    const result = JSON.parse(stdout[0]!.slice("LIKEGO_GATE_RESULT=".length)) as Record<string, any>
    expect(stderr).toEqual([])
    expect(result.checks).toContainEqual(
      expect.objectContaining({ id: "FIXTURE_INVENTORY_MISMATCH", status: "fail" })
    )
  })

  test("repository mode with no official package exits one, checks zero, and is not-ready", async () => {
    const { main } = await LoadCli()
    const root = await NewRoot([
      "schemas/capability-manifest.schema.json",
      "schemas/owner-manifest.schema.json",
      "config/runtime-matrix.json"
    ])
    await WritePrivateWorkspace(root)
    await WriteFiles(root, { "tools/manifests/fixtures/unlisted/payload.json": "{}\n" })
    const stdout: string[] = []
    const stderr: string[] = []
    expect(
      await main(["--root", root, "--mode", "repository", "--run-id", "manifest-repository-zero"], {
        WriteStdout: (value: string) => {
          stdout.push(value)
        },
        WriteStderr: (value: string) => {
          stderr.push(value)
        }
      })
    ).toBe(1)
    const result = JSON.parse(stdout[0]!.slice("LIKEGO_GATE_RESULT=".length)) as Record<string, any>
    expect(stderr).toEqual([])
    expect({
      gate: result.gate,
      mode: result.mode,
      status: result.status,
      readiness: result.releaseReadiness,
      checked: result.subjects.checked
    }).toEqual({
      gate: "official-manifests",
      mode: "repository",
      status: "fail",
      readiness: "not-ready",
      checked: 0
    })
    expect(result.runId).toBe("manifest-repository-zero")
    expect(result.checks).toContainEqual(
      expect.objectContaining({ id: "MANIFEST_PACKAGE_ZERO", status: "fail" })
    )
  })

  test("repository mode inventories both parent and explicitly nested workspaces", async () => {
    const { main } = await LoadCli()
    const root = await NewRoot([])
    await WriteFiles(root, {
      ...(await OfficialFiles("packages/config", "@likego/config")),
      ...(await OfficialFiles("packages/config/consul", "@likego/config-consul")),
      "package.json": Json({
        name: "likego-manifest-fixture",
        private: true,
        workspaces: ["./packages/*/", "packages/config/*/", "./packages/config/consul/"]
      })
    })
    const stdout: string[] = []
    const stderr: string[] = []

    expect(
      await main(
        ["--root", root, "--mode", "repository", "--run-id", "manifest-repository-nested"],
        {
          WriteStdout: (value: string) => {
            stdout.push(value)
          },
          WriteStderr: (value: string) => {
            stderr.push(value)
          }
        }
      )
    ).toBe(1)
    const result = JSON.parse(stdout[0]!.slice("LIKEGO_GATE_RESULT=".length)) as Record<string, any>
    expect(stderr).toEqual([])
    expect(result.subjects.expected).toBe(2)
    expect(result.subjects.checked).toBe(2)
  })

  test("repository mode does not infer package groups from workspace test fixtures", async () => {
    const { main } = await LoadCli()
    const root = await NewRoot([])
    await WriteFiles(root, await CurrentOfficialFiles())
    await WriteFiles(root, {
      "packages/context/test/fixtures/nested/package.json": Json({
        name: "@fixture/not-a-workspace"
      }),
      "packages/context/test/fixtures/nested/capability.json": "{}\n",
      "packages/context/test/fixtures/nested/owner.json": "{}\n"
    })
    const stdout: string[] = []
    const stderr: string[] = []

    expect(
      await main(
        ["--root", root, "--mode", "repository", "--run-id", "manifest-repository-test-fixture"],
        {
          WriteStdout: (value: string) => {
            stdout.push(value)
          },
          WriteStderr: (value: string) => {
            stderr.push(value)
          }
        }
      )
    ).toBe(0)
    const result = JSON.parse(stdout[0]!.slice("LIKEGO_GATE_RESULT=".length)) as Record<string, any>
    expect(stderr).toEqual([])
    expect({ expected: result.subjects.expected, checked: result.subjects.checked }).toEqual({
      expected: 1,
      checked: 1
    })
  })

  test("repository mode snapshots one complete direct official package and becomes ready", async () => {
    const { main } = await LoadCli()
    const root = await NewRoot([])
    await WriteFiles(root, await CurrentOfficialFiles())
    await WriteFiles(root, { "packages/ignored.txt": "not an official package directory\n" })
    const stdout: string[] = []
    const stderr: string[] = []

    expect(
      await main(["--root", root, "--mode", "repository", "--run-id", "manifest-repository-one"], {
        WriteStdout: (value: string) => {
          stdout.push(value)
        },
        WriteStderr: (value: string) => {
          stderr.push(value)
        }
      })
    ).toBe(0)
    const result = JSON.parse(stdout[0]!.slice("LIKEGO_GATE_RESULT=".length)) as Record<string, any>
    expect(stderr).toEqual([])
    expect({
      status: result.status,
      readiness: result.releaseReadiness,
      expected: result.subjects.expected,
      checked: result.subjects.checked
    }).toEqual({
      status: "pass",
      readiness: "ready",
      expected: 1,
      checked: 1
    })
    expect(result.checks).toContainEqual(
      expect.objectContaining({ id: "MANIFEST_PACKAGE_VALID", status: "pass" })
    )
  })

  test("fails closed for invalid arguments, malformed cases, discovery errors, and emission errors", async () => {
    const { main } = await LoadCli()
    const stdout: string[] = []
    const stderr: string[] = []
    const io = {
      WriteStdout: (value: string) => {
        stdout.push(value)
      },
      WriteStderr: (value: string) => {
        stderr.push(value)
      }
    }
    expect(await main([], io)).toBe(1)

    const malformedRoot = await NewRoot([
      "schemas/capability-manifest.schema.json",
      "schemas/owner-manifest.schema.json",
      "config/runtime-matrix.json"
    ])
    await WriteFiles(malformedRoot, { "tools/manifests/fixtures/cases.json": "{\n" })
    expect(await main(["--root", malformedRoot, "--mode", "fixture"], io)).toBe(1)

    const fileContainer = await NewRoot([])
    const fileRoot = join(fileContainer, "not-a-directory")
    await Bun.write(fileRoot, "blocked\n")
    expect(await main(["--root", fileRoot, "--mode", "fixture"], io)).toBe(1)

    const linkedRoot = await NewRoot([])
    await mkdir(join(linkedRoot, "packages"), { recursive: true })
    await Bun.write(join(linkedRoot, "regular-file"), "blocked\n")
    await symlink(join(linkedRoot, "regular-file"), join(linkedRoot, "packages", "linked"))
    expect(await main(["--root", linkedRoot, "--mode", "repository"], io)).toBe(1)

    const fixturePaths = [
      "schemas/capability-manifest.schema.json",
      "schemas/owner-manifest.schema.json",
      "config/runtime-matrix.json",
      ...(await FilesBelow(join(RepositoryRoot, "tools/manifests/fixtures")).then((paths) =>
        paths.map((path) => `tools/manifests/fixtures/${path}`)
      ))
    ]
    const emissionRoot = await NewRoot(fixturePaths)
    await Bun.write(join(emissionRoot, ".artifacts"), "blocked\n")
    expect(await main(["--root", emissionRoot, "--mode", "fixture"], io)).toBe(1)

    expect(stderr[0]).toBe("MANIFEST_USAGE invalid arguments\n")
    expect(stderr.filter((value) => value.startsWith("MANIFEST_DISCOVERY_ERROR "))).toHaveLength(2)
    expect(stderr.some((value) => value.startsWith("MANIFEST_EMIT_ERROR "))).toBe(true)
  })

  test("resolves with a stable emission diagnostic for a non-coercible thrown value", async () => {
    const { main } = await LoadCli()
    const root = await NewRoot([
      "schemas/capability-manifest.schema.json",
      "schemas/owner-manifest.schema.json",
      "config/runtime-matrix.json"
    ])
    await WritePrivateWorkspace(root)
    const hostile = {
      [Symbol.toPrimitive](): never {
        throw new Error("coercion escaped")
      }
    }
    const stderr: string[] = []

    await expect(
      main(["--root", root, "--mode", "repository", "--run-id", "manifest-hostile-emission"], {
        WriteStdout: () => {
          throw hostile
        },
        WriteStderr: (value: string) => {
          stderr.push(value)
        }
      })
    ).resolves.toBe(1)
    expect(stderr).toEqual(["MANIFEST_EMIT_ERROR unprintable error\n"])
  })

  test("uses default process IO for generated-run repository output and usage errors", async () => {
    const { main } = await LoadCli()
    const root = await NewRoot([
      "schemas/capability-manifest.schema.json",
      "schemas/owner-manifest.schema.json",
      "config/runtime-matrix.json"
    ])
    await WritePrivateWorkspace(root)
    const stdout: string[] = []
    const stderr: string[] = []
    const originalStdout = process.stdout.write
    const originalStderr = process.stderr.write
    process.stdout.write = ((
      value: string | Uint8Array,
      callback?: (error?: Error | null) => void
    ) => {
      stdout.push(String(value))
      callback?.()
      return true
    }) as typeof process.stdout.write
    process.stderr.write = ((
      value: string | Uint8Array,
      callback?: (error?: Error | null) => void
    ) => {
      stderr.push(String(value))
      callback?.()
      return true
    }) as typeof process.stderr.write

    try {
      expect(await main(["--root", root, "--mode", "repository"])).toBe(1)
      expect(await main([])).toBe(1)
    } finally {
      process.stdout.write = originalStdout
      process.stderr.write = originalStderr
    }
    expect(stdout).toHaveLength(1)
    expect(stderr).toEqual(["MANIFEST_USAGE invalid arguments\n"])
    const result = JSON.parse(stdout[0]!.slice("LIKEGO_GATE_RESULT=".length)) as Record<
      string,
      unknown
    >
    expect(result.runId).toMatch(/^[a-z0-9][a-z0-9_-]{0,95}$/)
  })
})
