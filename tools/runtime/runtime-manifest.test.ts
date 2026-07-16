import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import type { GateEvaluation, InputSnapshot, SnapshotFile } from "../gates/result.ts"

const ContextContractMarker = "LIKEGO_CONTEXT_TIMING_AFTERFUNC_V1"
const CoverageContractMarker = "LIKEGO_PUBLISHED_JS_BRANCH_AUTHORITY_V1"
const InputPaths = [
  "docs/adr/0001-kernel-public-api.md",
  "docs/adr/0002-build-runtime-and-coverage.md",
  "config/runtime-matrix.json",
  "package.json",
  "bunfig.toml",
  "deno.json"
] as const
const Roots: string[] = []

afterEach(async () => {
  await Promise.all(Roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function LoadRuntimeManifest() {
  return import("./runtime-manifest.ts")
}

async function LoadRuntimeManifestCli() {
  await LoadRuntimeManifest()
  return import("./runtime-manifest.cli.ts")
}

function Sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

function ExactMatrix(): Record<string, unknown> {
  return {
    SchemaVersion: 1,
    TypeScript: "7.0.2",
    Lanes: [
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
  }
}

function ExactPackage(): Record<string, unknown> {
  return {
    name: "likego",
    private: true,
    packageManager: "bun@1.3.14",
    devDependencies: {
      "@types/bun": "1.3.14",
      ajv: "8.20.0",
      typescript: "7.0.2"
    }
  }
}

function ExactFiles(): Record<string, string> {
  return {
    "docs/adr/0001-kernel-public-api.md": `# ADR 0001\n\nContract marker: \`${ContextContractMarker}\`.\n`,
    "docs/adr/0002-build-runtime-and-coverage.md": `# ADR 0002\n\nContract marker: \`${CoverageContractMarker}\`.\n`,
    "config/runtime-matrix.json": `${JSON.stringify(ExactMatrix(), null, 2)}\n`,
    "package.json": `${JSON.stringify(ExactPackage(), null, 2)}\n`,
    "bunfig.toml": "[install]\nexact = true\n",
    "deno.json": "{\n  \"compilerOptions\": { \"strict\": true }\n}\n"
  }
}

function Snapshot(files: Readonly<Record<string, string>> = ExactFiles()): InputSnapshot {
  const encoder = new TextEncoder()
  const snapshotFiles: SnapshotFile[] = Object.entries(files)
    .map(([Path, value]) => {
      const Bytes = encoder.encode(value)
      return {
        Path,
        RealPath: join("/virtual/runtime-contract", Path),
        Sha256: Sha256(Bytes),
        Bytes
      }
    })
    .sort((left, right) => left.Path < right.Path ? -1 : left.Path > right.Path ? 1 : 0)
  const inventory = snapshotFiles.map((file) => `${file.Path}\0${file.Sha256}\n`).join("")
  return { Sha256: Sha256(inventory), Files: snapshotFiles }
}

function FilesWithJson(
  path: "config/runtime-matrix.json" | "package.json",
  mutate: (value: Record<string, any>) => void
): Record<string, string> {
  const files = ExactFiles()
  const value = JSON.parse(files[path]!) as Record<string, any>
  mutate(value)
  files[path] = `${JSON.stringify(value, null, 2)}\n`
  return files
}

function FailedIds(evaluation: GateEvaluation): string[] {
  return evaluation.Checks.filter((check) => check.status === "fail").map((check) => check.id)
}

async function Fixture(files: Readonly<Record<string, string>> = ExactFiles()): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "likego-runtime-manifest-"))
  Roots.push(root)
  for (const [path, value] of Object.entries(files)) {
    const absolute = join(root, path)
    await mkdir(dirname(absolute), { recursive: true })
    await Bun.write(absolute, value)
  }
  return root
}

describe("ValidateRuntimeMatrix", () => {
  test("accepts the exact six-file snapshot and four pinned runtime lanes", async () => {
    const { ValidateRuntimeMatrix } = await LoadRuntimeManifest()
    const evaluation = ValidateRuntimeMatrix(Snapshot())

    expect(evaluation.SubjectsChecked).toBe(4)
    expect(evaluation.ArtifactPaths).toBeUndefined()
    expect(evaluation.Checks.map((check) => check.id)).toEqual([
      "RUNTIME_INPUT_INVENTORY",
      "RUNTIME_MATRIX_FORMAT",
      "RUNTIME_LANE_SET",
      "RUNTIME_TYPESCRIPT_EXACT",
      "RUNTIME_PACKAGE_FORMAT",
      "RUNTIME_PACKAGE_MANAGER_EXACT",
      "RUNTIME_ADR_CONTEXT_CONTRACT",
      "RUNTIME_ADR_COVERAGE_CONTRACT",
      "RUNTIME_LANE_BUN_EXACT",
      "RUNTIME_LANE_NODE_LTS",
      "RUNTIME_LANE_NODE_CURRENT",
      "RUNTIME_LANE_DENO_EXACT"
    ])
    expect(evaluation.Checks.every((check) => check.status === "pass")).toBe(true)
  })

  test("rejects missing, extra, and duplicate snapshot inventory without filesystem reads", async () => {
    const { ValidateRuntimeMatrix } = await LoadRuntimeManifest()
    const missing = ExactFiles()
    delete missing["deno.json"]
    const extra = { ...ExactFiles(), "unexpected.txt": "unexpected\n" }
    const duplicateBase = Snapshot()
    const duplicate: InputSnapshot = {
      Sha256: duplicateBase.Sha256,
      Files: [...duplicateBase.Files, duplicateBase.Files[0]!]
    }

    for (const snapshot of [Snapshot(missing), Snapshot(extra), duplicate]) {
      const evaluation = ValidateRuntimeMatrix(snapshot)
      expect(evaluation.SubjectsChecked).toBe(0)
      expect(FailedIds(evaluation)).toEqual(["RUNTIME_INPUT_INVENTORY"])
    }
  })

  test("fails closed for missing, extra, and duplicate lane ids", async () => {
    const { ValidateRuntimeMatrix } = await LoadRuntimeManifest()
    const cases = [
      FilesWithJson("config/runtime-matrix.json", (matrix) => { matrix.Lanes.pop() }),
      FilesWithJson("config/runtime-matrix.json", (matrix) => {
        matrix.Lanes.push({
          Id: "node-extra",
          Runtime: "node",
          Channel: "current",
          Version: "26.5.0",
          ImageTag: "node:26.5.0-bookworm-slim"
        })
      }),
      FilesWithJson("config/runtime-matrix.json", (matrix) => {
        matrix.Lanes[3] = { ...matrix.Lanes[0] }
      })
    ]

    expect(cases.map((files) => {
      const evaluation = ValidateRuntimeMatrix(Snapshot(files))
      return { checked: evaluation.SubjectsChecked, failed: FailedIds(evaluation) }
    })).toEqual([
      { checked: 3, failed: ["RUNTIME_LANE_SET"] },
      { checked: 5, failed: ["RUNTIME_LANE_SET"] },
      { checked: 4, failed: ["RUNTIME_LANE_SET"] }
    ])
  })

  test("rejects non-exact versions and wrong runtime, channel, tag, or digest fields", async () => {
    const { ValidateRuntimeMatrix } = await LoadRuntimeManifest()
    const cases = [
      ["Version", "1.3"],
      ["Runtime", "node"],
      ["Channel", "current"],
      ["ImageTag", "oven/bun:latest"]
    ] as const

    for (const [field, value] of cases) {
      const files = FilesWithJson("config/runtime-matrix.json", (matrix) => {
        matrix.Lanes[0][field] = value
      })
      expect(FailedIds(ValidateRuntimeMatrix(Snapshot(files)))).toContain("RUNTIME_LANE_BUN_EXACT")
    }

    const digest = FilesWithJson("config/runtime-matrix.json", (matrix) => {
      matrix.Lanes[0].ImageDigest = "sha256:deadbeef"
    })
    expect(FailedIds(ValidateRuntimeMatrix(Snapshot(digest)))).toEqual(["RUNTIME_MATRIX_FORMAT"])
  })

  test("binds TypeScript and package manager to the exact root toolchain", async () => {
    const { ValidateRuntimeMatrix } = await LoadRuntimeManifest()
    const matrixTypeScript = FilesWithJson("config/runtime-matrix.json", (matrix) => {
      matrix.TypeScript = "7.0"
    })
    const packageTypeScript = FilesWithJson("package.json", (packageJson) => {
      packageJson.devDependencies.typescript = "7.0"
    })
    const packageManager = FilesWithJson("package.json", (packageJson) => {
      packageJson.packageManager = "bun@1.3"
    })

    expect(FailedIds(ValidateRuntimeMatrix(Snapshot(matrixTypeScript))))
      .toContain("RUNTIME_TYPESCRIPT_EXACT")
    expect(FailedIds(ValidateRuntimeMatrix(Snapshot(packageTypeScript))))
      .toContain("RUNTIME_TYPESCRIPT_EXACT")
    expect(FailedIds(ValidateRuntimeMatrix(Snapshot(packageManager))))
      .toContain("RUNTIME_PACKAGE_MANAGER_EXACT")
  })

  test("returns deterministic domain failures for legal JSON wrong-type diagnostics", async () => {
    const { ValidateRuntimeMatrix } = await LoadRuntimeManifest()
    const cases = [
      { Value: { toString: null, valueOf: null }, Diagnostic: "<object>" },
      { Value: [{ toString: null, valueOf: null }], Diagnostic: "<array>" },
      { Value: null, Diagnostic: "<null>" },
      { Value: 7, Diagnostic: "<number>" }
    ] as const

    for (const { Value, Diagnostic } of cases) {
      const typeScriptFiles = FilesWithJson("package.json", (packageJson) => {
        packageJson.devDependencies.typescript = Value
      })
      const packageManagerFiles = FilesWithJson("package.json", (packageJson) => {
        packageJson.packageManager = Value
      })
      let typeScriptEvaluation: GateEvaluation | undefined
      let packageManagerEvaluation: GateEvaluation | undefined

      expect(() => {
        typeScriptEvaluation = ValidateRuntimeMatrix(Snapshot(typeScriptFiles))
      }).not.toThrow()
      expect(() => {
        packageManagerEvaluation = ValidateRuntimeMatrix(Snapshot(packageManagerFiles))
      }).not.toThrow()
      expect(typeScriptEvaluation).toBeDefined()
      expect(packageManagerEvaluation).toBeDefined()
      if (typeScriptEvaluation === undefined || packageManagerEvaluation === undefined) {
        throw new Error("runtime diagnostics did not return an evaluation")
      }

      expect(typeScriptEvaluation.SubjectsChecked).toBe(4)
      expect(FailedIds(typeScriptEvaluation)).toEqual(["RUNTIME_TYPESCRIPT_EXACT"])
      expect(typeScriptEvaluation.Checks).toContainEqual(expect.objectContaining({
        id: "RUNTIME_TYPESCRIPT_EXACT",
        status: "fail",
        actual: `7.0.2 / ${Diagnostic}`
      }))
      expect(FailedIds(typeScriptEvaluation)).not.toContain("GATE_INTERNAL_ERROR")

      expect(packageManagerEvaluation.SubjectsChecked).toBe(4)
      expect(FailedIds(packageManagerEvaluation)).toEqual(["RUNTIME_PACKAGE_MANAGER_EXACT"])
      expect(packageManagerEvaluation.Checks).toContainEqual(expect.objectContaining({
        id: "RUNTIME_PACKAGE_MANAGER_EXACT",
        status: "fail",
        actual: Diagnostic
      }))
      expect(FailedIds(packageManagerEvaluation)).not.toContain("GATE_INTERNAL_ERROR")
    }
  })

  test("requires both frozen ADR contract markers", async () => {
    const { ValidateRuntimeMatrix } = await LoadRuntimeManifest()
    const missingContext = ExactFiles()
    missingContext[InputPaths[0]] = missingContext[InputPaths[0]]!.replace(ContextContractMarker, "missing")
    const missingCoverage = ExactFiles()
    missingCoverage[InputPaths[1]] = missingCoverage[InputPaths[1]]!.replace(CoverageContractMarker, "missing")

    expect(FailedIds(ValidateRuntimeMatrix(Snapshot(missingContext))))
      .toContain("RUNTIME_ADR_CONTEXT_CONTRACT")
    expect(FailedIds(ValidateRuntimeMatrix(Snapshot(missingCoverage))))
      .toContain("RUNTIME_ADR_COVERAGE_CONTRACT")
  })

  test("returns stable format failures for malformed JSON and fixed-shape additions", async () => {
    const { ValidateRuntimeMatrix } = await LoadRuntimeManifest()
    const malformedMatrix = { ...ExactFiles(), "config/runtime-matrix.json": "{\n" }
    const malformedPackage = { ...ExactFiles(), "package.json": "{\n" }
    const extraMatrixKey = FilesWithJson("config/runtime-matrix.json", (matrix) => {
      matrix.AllowFloating = true
    })

    expect(FailedIds(ValidateRuntimeMatrix(Snapshot(malformedMatrix))))
      .toEqual(["RUNTIME_MATRIX_FORMAT"])
    expect(FailedIds(ValidateRuntimeMatrix(Snapshot(malformedPackage))))
      .toContain("RUNTIME_PACKAGE_FORMAT")
    expect(FailedIds(ValidateRuntimeMatrix(Snapshot(extraMatrixKey))))
      .toEqual(["RUNTIME_MATRIX_FORMAT"])
  })
})

describe("runtime-manifest CLI", () => {
  test("emits a current-run canonical PASS for the exact repository contract", async () => {
    const root = await Fixture()
    const { Main } = await LoadRuntimeManifestCli()
    const stdout: string[] = []
    const stderr: string[] = []
    const exitCode = await Main([
      "--root", root,
      "--run-id", "runtime-contract-current"
    ], {
      WriteStdout: (value: string) => { stdout.push(value) },
      WriteStderr: (value: string) => { stderr.push(value) }
    })
    const canonicalPath = join(root, ".artifacts", "gates", "runtime-contract.json")
    const persisted = JSON.parse(await readFile(canonicalPath, "utf8")) as Record<string, any>

    expect(exitCode).toBe(0)
    expect(stderr).toEqual([])
    expect(stdout).toHaveLength(1)
    expect(JSON.parse(stdout[0]!.slice("LIKEGO_GATE_RESULT=".length))).toEqual(persisted)
    expect({
      runId: persisted.runId,
      gate: persisted.gate,
      mode: persisted.mode,
      status: persisted.status,
      readiness: persisted.releaseReadiness,
      inputsSha256: persisted.inputsSha256 === null ? null : "present",
      expected: persisted.subjects.expected,
      checked: persisted.subjects.checked
    }).toEqual({
      runId: "runtime-contract-current",
      gate: "runtime-contract",
      mode: "repository",
      status: "pass",
      readiness: "not-evaluated",
      inputsSha256: "present",
      expected: 4,
      checked: 4
    })
    expect(persisted.checks.every((check: Record<string, unknown>) => check.status === "pass")).toBe(true)
  })

  test("persists a current-run failure when a pinned contract drifts", async () => {
    const root = await Fixture(FilesWithJson("package.json", (packageJson) => {
      packageJson.packageManager = "bun@latest"
    }))
    const { Main } = await LoadRuntimeManifestCli()
    const stdout: string[] = []
    const stderr: string[] = []

    expect(await Main([
      "--root", root,
      "--run-id", "runtime-contract-drift"
    ], {
      WriteStdout: (value: string) => { stdout.push(value) },
      WriteStderr: (value: string) => { stderr.push(value) }
    })).toBe(1)
    const persisted = JSON.parse(await readFile(
      join(root, ".artifacts", "gates", "runtime-contract.json"),
      "utf8"
    )) as Record<string, any>
    expect(stderr).toEqual([])
    expect(stdout).toHaveLength(1)
    expect(persisted.runId).toBe("runtime-contract-drift")
    expect(persisted.status).toBe("fail")
    expect(persisted.releaseReadiness).toBe("not-evaluated")
    expect(persisted.checks).toContainEqual(expect.objectContaining({
      id: "RUNTIME_PACKAGE_MANAGER_EXACT",
      status: "fail"
    }))
  })

  test("rejects invalid arguments and reports emission failures without a result line", async () => {
    const root = await Fixture()
    const { Main } = await LoadRuntimeManifestCli()
    const stdout: string[] = []
    const stderr: string[] = []

    expect(await Main(["--unknown", "value"], {
      WriteStdout: (value: string) => { stdout.push(value) },
      WriteStderr: (value: string) => { stderr.push(value) }
    })).toBe(1)
    expect(await Main(["--root"], {
      WriteStdout: (value: string) => { stdout.push(value) },
      WriteStderr: (value: string) => { stderr.push(value) }
    })).toBe(1)
    expect(await Main(["--root", join(root, "package.json")], {
      WriteStdout: (value: string) => { stdout.push(value) },
      WriteStderr: (value: string) => { stderr.push(value) }
    })).toBe(1)

    expect(stdout).toEqual([])
    expect(stderr.slice(0, 2)).toEqual([
      "RUNTIME_MANIFEST_USAGE invalid arguments\n",
      "RUNTIME_MANIFEST_USAGE invalid arguments\n"
    ])
    expect(stderr[2]).toStartWith("RUNTIME_MANIFEST_EMIT_ERROR ")
  })

  test("uses default process IO and generates a run id when omitted", async () => {
    const root = await Fixture()
    const { Main } = await LoadRuntimeManifestCli()
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
      expect(await Main(["--root", root])).toBe(0)
      expect(await Main(["--unknown", "value"])).toBe(1)
    } finally {
      process.stdout.write = originalStdout
      process.stderr.write = originalStderr
    }
    expect(stdout).toHaveLength(1)
    expect(stderr).toEqual(["RUNTIME_MANIFEST_USAGE invalid arguments\n"])
    const persisted = JSON.parse(await readFile(
      join(root, ".artifacts", "gates", "runtime-contract.json"),
      "utf8"
    )) as Record<string, unknown>
    expect(persisted.runId).toMatch(/^[a-z0-9][a-z0-9_-]{0,95}$/)
  })
})
