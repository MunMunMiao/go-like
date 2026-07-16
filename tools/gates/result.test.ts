import { afterEach, describe, expect, test } from "bun:test"
import { Ajv2020 } from "ajv/dist/2020.js"
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink } from "node:fs/promises"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const Roots: string[] = []
const SchemaPath = new URL("../../schemas/gate-result.schema.json", import.meta.url)

afterEach(async () => {
  await Promise.all(Roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function LoadResult() {
  return import("./result.ts")
}

async function LoadCli() {
  await LoadResult()
  return import("./protocol-probe.cli.ts")
}

async function Fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "likego-gate-result-"))
  Roots.push(root)
  await Bun.write(join(root, "input.txt"), "input\n")
  await Bun.write(join(root, "package.json"), "{}\n")
  return root
}

function Sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

function Options(root: string, overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    root,
    gate: "unit-fixtures",
    mode: "fixture" as const,
    readinessPolicy: "evaluation-only" as const,
    expectedSubjects: 1,
    inputPaths: ["input.txt"],
    toolchain: { bun: "1.3.14" },
    runId: "unit-run",
    ...overrides
  }
}

function PassingEvaluation(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    SubjectsChecked: 1,
    Checks: [{ id: "UNIT_PASS", status: "pass" as const }],
    ...overrides
  }
}

function ValidResult(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    schemaVersion: 1 as const,
    runId: "unit-run",
    gate: "unit-fixtures",
    mode: "fixture" as const,
    status: "pass" as const,
    releaseReadiness: "not-evaluated" as const,
    startedAt: "2026-07-17T00:00:00.000Z",
    completedAt: "2026-07-17T00:00:00.001Z",
    toolchain: { bun: "1.3.14" },
    inputsSha256: "0".repeat(64),
    subjects: { expected: 1, checked: 1 },
    checks: [{ id: "UNIT_PASS", status: "pass" as const }],
    artifacts: [],
    ...overrides
  }
}

async function ReadSchema(): Promise<Record<string, unknown>> {
  return JSON.parse(await Bun.file(SchemaPath).text()) as Record<string, unknown>
}

describe("gate-result.schema.json", () => {
  test("accepts the complete contract and rejects fixed-shape additions", async () => {
    const ajv = new Ajv2020({ strict: true })
    const validate = ajv.compile(await ReadSchema())

    expect(validate(ValidResult())).toBe(true)
    expect(validate({ ...ValidResult(), unexpected: true })).toBe(false)
    expect(validate({
      ...ValidResult(),
      subjects: { expected: 1, checked: 1, unexpected: true }
    })).toBe(false)
    expect(validate({
      ...ValidResult(),
      checks: [{ id: "UNIT_PASS", status: "pass", unexpected: true }]
    })).toBe(false)
    expect(validate({
      ...ValidResult(),
      artifacts: [{ kind: "log", path: "log.txt", sha256: "0".repeat(64), unexpected: true }]
    })).toBe(false)
  })

  test("permits only string toolchain values and canonical identifiers, hashes, and timestamps", async () => {
    const ajv = new Ajv2020({ strict: true })
    const validate = ajv.compile(await ReadSchema())
    const invalidResults = [
      ValidResult({ toolchain: { bun: 1 } }),
      ValidResult({ gate: "Unit" }),
      ValidResult({ runId: "bad run" }),
      ValidResult({ inputsSha256: "not-a-hash" }),
      ValidResult({ startedAt: "2026-07-17T00:00:00Z" }),
      ValidResult({ completedAt: "2026-07-17 00:00:00.001Z" })
    ]

    for (const result of invalidResults) {
      expect(validate(result)).toBe(false)
    }
  })
})

describe("SnapshotInputs", () => {
  test("sorts canonical paths and hashes the exact immutable bytes", async () => {
    const root = await Fixture()
    await mkdir(join(root, "nested"))
    await Bun.write(join(root, "nested", "second.txt"), "second\n")
    const { SnapshotInputs } = await LoadResult()

    const result = await SnapshotInputs(root, ["nested/second.txt", "input.txt"])

    expect(result.Checks).toEqual([])
    expect(result.Snapshot?.Files.map((file) => file.Path)).toEqual([
      "input.txt",
      "nested/second.txt"
    ])
    expect(result.Snapshot?.Files.map((file) => new TextDecoder().decode(file.Bytes))).toEqual([
      "input\n",
      "second\n"
    ])
    const firstSha = Sha256("input\n")
    const secondSha = Sha256("second\n")
    expect(result.Snapshot?.Files.map((file) => file.Sha256)).toEqual([firstSha, secondSha])
    expect(result.Snapshot?.Sha256).toBe(Sha256(
      `input.txt\0${firstSha}\n` + `nested/second.txt\0${secondSha}\n`
    ))
    expect(result.Snapshot?.Files.map((file) => file.RealPath)).toEqual([
      await realpath(join(root, "input.txt")),
      await realpath(join(root, "nested", "second.txt"))
    ])
  })

  test("fails closed for missing, directory, absolute, and lexical escape inputs", async () => {
    const root = await Fixture()
    await mkdir(join(root, "directory"))
    const { SnapshotInputs } = await LoadResult()

    for (const path of ["missing.txt", "directory", join(root, "input.txt"), "../outside.txt"]) {
      const result = await SnapshotInputs(root, [path])
      expect(result.Snapshot).toBeNull()
      expect(result.Checks).toHaveLength(1)
      expect(result.Checks[0]?.id).toBe("GATE_INPUT_ERROR")
      expect(result.Checks[0]?.status).toBe("fail")
    }

    const fileRoot = await SnapshotInputs(join(root, "input.txt"), ["child.txt"])
    expect(fileRoot.Snapshot).toBeNull()
    expect(fileRoot.Checks.map((check) => check.id)).toEqual(["GATE_INPUT_ERROR"])
  })

  test("rejects symlink escapes and duplicate lexical or real paths", async () => {
    const root = await Fixture()
    const outside = await Fixture()
    await symlink(join(outside, "input.txt"), join(root, "escape.txt"))
    await symlink(join(root, "input.txt"), join(root, "alias.txt"))
    const { SnapshotInputs } = await LoadResult()

    for (const paths of [
      ["escape.txt"],
      ["input.txt", "./input.txt"],
      ["input.txt", "alias.txt"]
    ]) {
      const result = await SnapshotInputs(root, paths)
      expect(result.Snapshot).toBeNull()
      expect(result.Checks.map((check) => check.id)).toEqual(["GATE_INPUT_ERROR"])
    }
  })

  test("sorts paths by deterministic code units rather than host locale", async () => {
    const root = await Fixture()
    await Bun.write(join(root, "Z.txt"), "upper\n")
    await Bun.write(join(root, "a.txt"), "lower\n")
    const { SnapshotInputs } = await LoadResult()

    const result = await SnapshotInputs(root, ["a.txt", "Z.txt"])

    expect(result.Snapshot?.Files.map((file) => file.Path)).toEqual(["Z.txt", "a.txt"])
  })
})

describe("RunGate", () => {
  test("derives fixture and repository PASS readiness from evaluation only", async () => {
    const root = await Fixture()
    const { RunGate } = await LoadResult()

    const fixture = await RunGate(Options(root), async () => PassingEvaluation())
    const repository = await RunGate(Options(root, {
      gate: "repository-gate",
      mode: "repository",
      readinessPolicy: "package-admission"
    }), async () => PassingEvaluation())
    const repositoryEvaluation = await RunGate(Options(root, {
      gate: "repository-evaluation",
      mode: "repository",
      readinessPolicy: "evaluation-only"
    }), async () => PassingEvaluation())

    expect({ status: fixture.status, readiness: fixture.releaseReadiness }).toEqual({
      status: "pass",
      readiness: "not-evaluated"
    })
    expect({ status: repository.status, readiness: repository.releaseReadiness }).toEqual({
      status: "pass",
      readiness: "ready"
    })
    expect(repositoryEvaluation.releaseReadiness).toBe("not-evaluated")
  })

  test("adds stable failed checks for zero subjects, no pass check, and count mismatch", async () => {
    const root = await Fixture()
    const { RunGate } = await LoadResult()
    const cases = [
      {
        options: Options(root, { expectedSubjects: 0 }),
        evaluation: PassingEvaluation({ SubjectsChecked: 0 }),
        codes: ["GATE_SUBJECTS_ZERO"]
      },
      {
        options: Options(root),
        evaluation: PassingEvaluation({ Checks: [] }),
        codes: ["GATE_NO_PASS_CHECK"]
      },
      {
        options: Options(root),
        evaluation: PassingEvaluation({ Checks: [{ id: "NOT_APPLICABLE", status: "skip" }] }),
        codes: ["GATE_NO_PASS_CHECK"]
      },
      {
        options: Options(root, { expectedSubjects: 2 }),
        evaluation: PassingEvaluation(),
        codes: ["GATE_SUBJECT_COUNT_MISMATCH"]
      }
    ]

    for (const item of cases) {
      const result = await RunGate(item.options, async () => item.evaluation)
      expect(result.status).toBe("fail")
      expect(result.releaseReadiness).toBe("not-evaluated")
      expect(result.checks.filter((check) => check.status === "fail").map((check) => check.id)).toEqual(item.codes)
    }
  })

  test("preserves evaluator failures and derives package admission not-ready", async () => {
    const root = await Fixture()
    const { RunGate } = await LoadResult()
    const result = await RunGate(Options(root, {
      gate: "repository-gate",
      mode: "repository",
      readinessPolicy: "package-admission"
    }), async () => PassingEvaluation({
      Checks: [
        { id: "ONE_PASS", status: "pass" },
        { id: "ONE_FAIL", status: "fail" }
      ]
    }))

    expect(result.status).toBe("fail")
    expect(result.releaseReadiness).toBe("not-ready")
    expect(result.checks.map((check) => check.id)).toContain("ONE_FAIL")
  })

  test("converts snapshot and evaluator exceptions into independent persisted-stage checks", async () => {
    const root = await Fixture()
    const { RunGate } = await LoadResult()
    let inputEvaluatorCalled = false
    const inputFailure = await RunGate(Options(root, { inputPaths: ["missing.txt"] }), async () => {
      inputEvaluatorCalled = true
      return PassingEvaluation()
    })
    const internalFailure = await RunGate(Options(root), async () => {
      throw new Error("evaluator exploded")
    })

    expect(inputEvaluatorCalled).toBe(false)
    expect(inputFailure.inputsSha256).toBeNull()
    expect(inputFailure.subjects.checked).toBe(0)
    expect(inputFailure.checks.map((check) => check.id)).toEqual(["GATE_INPUT_ERROR"])
    expect(internalFailure.inputsSha256).not.toBeNull()
    expect(internalFailure.checks.map((check) => check.id)).toEqual(["GATE_INTERNAL_ERROR"])
  })

  test("rejects invalid identifiers and every illegal mode/readiness combination before evaluation", async () => {
    const root = await Fixture()
    const { RunGate } = await LoadResult()
    const invalidOptions = [
      Options(root, { gate: "Invalid" }),
      Options(root, { runId: "invalid run" }),
      Options(root, { expectedSubjects: -1 }),
      Options(root, { mode: "unknown" }),
      Options(root, { readinessPolicy: "unknown" }),
      Options(root, { root: 1 }),
      Options(root, { inputPaths: "input.txt" }),
      Options(root, { inputPaths: [1] }),
      Options(root, { toolchain: { bun: 1 } }),
      Options(root, { toolchain: null }),
      Options(root, { gate: "fixture-without-suffix".replace("-fixtures", "") }),
      Options(root, { readinessPolicy: "package-admission" }),
      Options(root, {
        gate: "runtime-probe",
        mode: "runtime-probe",
        readinessPolicy: "package-admission"
      })
    ]

    for (const options of invalidOptions) {
      let evaluated = false
      const result = await RunGate(options, async () => {
        evaluated = true
        return PassingEvaluation()
      })
      expect(evaluated).toBe(false)
      expect(result.status).toBe("fail")
      expect(result.releaseReadiness).not.toBe("ready")
      expect(result.inputsSha256).toBeNull()
      expect(result.checks.map((check) => check.id)).toEqual(["GATE_PROTOCOL_ERROR"])
      const ajv = new Ajv2020({ strict: true })
      expect(ajv.compile(await ReadSchema())(result)).toBe(true)
    }
  })

  test("turns every invalid protocol combination into one fixed emittable failure contract", async () => {
    const root = await Fixture()
    const { EmitGateResultWithDependencies, NodeAtomicWriterOperations, RunGate } = await LoadResult()
    const invalidOptions = [
      Options(root, { readinessPolicy: "package-admission" }),
      Options(root, {
        gate: "runtime-probe",
        mode: "runtime-probe",
        readinessPolicy: "package-admission"
      }),
      Options(root, { gate: "fixture-without-required-suffix" })
    ]

    for (const options of invalidOptions) {
      const stdout: string[] = []
      const result = await RunGate(options, async () => PassingEvaluation())

      expect({
        gate: result.gate,
        mode: result.mode,
        releaseReadiness: result.releaseReadiness,
        inputsSha256: result.inputsSha256,
        checked: result.subjects.checked,
        artifacts: result.artifacts,
        checks: result.checks.map((check) => check.id)
      }).toEqual({
        gate: "gate-protocol-error",
        mode: "repository",
        releaseReadiness: "not-evaluated",
        inputsSha256: null,
        checked: 0,
        artifacts: [],
        checks: ["GATE_PROTOCOL_ERROR"]
      })
      const canonicalPath = await EmitGateResultWithDependencies(root, result, {
        AtomicWriterOperations: NodeAtomicWriterOperations(),
        WriteStdout: (value: string) => { stdout.push(value) }
      })
      expect(JSON.parse(await readFile(canonicalPath, "utf8"))).toEqual(result)
      expect(stdout).toHaveLength(1)
    }
  })

  test("validates unknown options before access and treats explicit null runId as invalid", async () => {
    const root = await Fixture()
    const { EmitGateResultWithDependencies, NodeAtomicWriterOperations, RunGate } = await LoadResult()
    let evaluated = false

    for (const options of [null, Options(root, { runId: null })]) {
      const result = await RunGate(options as never, async () => {
        evaluated = true
        return PassingEvaluation()
      })
      expect(result.runId).toMatch(/^[a-z0-9][a-z0-9_-]{0,95}$/)
      expect(result.checks.map((check) => check.id)).toEqual(["GATE_PROTOCOL_ERROR"])
      await expect(EmitGateResultWithDependencies(root, result, {
        AtomicWriterOperations: NodeAtomicWriterOperations(),
        WriteStdout: (_value: string) => {}
      })).resolves.toEndWith("gate-protocol-error.json")
    }
    expect(evaluated).toBe(false)
  })

  test("snapshots the complete options graph once before validation and construction", async () => {
    const root = await Fixture()
    const { EmitGateResultWithDependencies, NodeAtomicWriterOperations, RunGate } = await LoadResult()
    const inputPaths: string[] = []
    const toolchain: Record<string, unknown> = {}
    const options = Options(root, {
      gate: "repository-gate",
      mode: "repository",
      inputPaths,
      toolchain
    })
    let gateReads = 0
    let inputReads = 0
    let toolchainReads = 0
    Object.defineProperty(options, "gate", {
      enumerable: true,
      get: () => ++gateReads === 1 ? "repository-gate" : "Invalid"
    })
    Object.defineProperty(inputPaths, "0", {
      enumerable: true,
      get: () => ++inputReads === 1 ? "input.txt" : "../outside.txt"
    })
    inputPaths.length = 1
    Object.defineProperty(toolchain, "bun", {
      enumerable: true,
      get: () => ++toolchainReads === 1 ? "1.3.14" : 1
    })
    let evaluated = false

    const result = await RunGate(options, async () => {
      evaluated = true
      return PassingEvaluation()
    })

    expect(evaluated).toBe(true)
    expect({ gate: result.gate, status: result.status, toolchain: result.toolchain }).toEqual({
      gate: "repository-gate",
      status: "pass",
      toolchain: { bun: "1.3.14" }
    })
    expect({ gateReads, inputReads, toolchainReads }).toEqual({
      gateReads: 1,
      inputReads: 1,
      toolchainReads: 1
    })
    await expect(EmitGateResultWithDependencies(root, result, {
      AtomicWriterOperations: NodeAtomicWriterOperations(),
      WriteStdout: (_value: string) => {}
    })).resolves.toEndWith("repository-gate.json")
  })

  test("does not coerce hostile invalid option values while building a protocol failure", async () => {
    const root = await Fixture()
    const { EmitGateResultWithDependencies, NodeAtomicWriterOperations, RunGate } = await LoadResult()
    const result = await RunGate(Options(root, {
      runId: { toString: () => { throw new Error("hostile toString invoked") } }
    }), async () => PassingEvaluation())

    expect(result.checks.map((check) => check.id)).toEqual(["GATE_PROTOCOL_ERROR"])
    await expect(EmitGateResultWithDependencies(root, result, {
      AtomicWriterOperations: NodeAtomicWriterOperations(),
      WriteStdout: (_value: string) => {}
    })).resolves.toEndWith("gate-protocol-error.json")
  })

  test("catches hostile option getters as a fixed emittable protocol failure", async () => {
    const root = await Fixture()
    const { EmitGateResultWithDependencies, NodeAtomicWriterOperations, RunGate } = await LoadResult()
    const options = { ...Options(root) }
    Object.defineProperty(options, "runId", {
      enumerable: true,
      get: () => { throw new Error("hostile runId getter invoked") }
    })
    const result = await RunGate(options, async () => PassingEvaluation())

    expect(result.checks.map((check) => check.id)).toEqual(["GATE_PROTOCOL_ERROR"])
    await expect(EmitGateResultWithDependencies(root, result, {
      AtomicWriterOperations: NodeAtomicWriterOperations(),
      WriteStdout: (_value: string) => {}
    })).resolves.toEndWith("gate-protocol-error.json")
  })

  test("returns a fresh protocol failure contract that prior callers cannot poison", async () => {
    const root = await Fixture()
    const { EmitGateResultWithDependencies, NodeAtomicWriterOperations, RunGate } = await LoadResult()
    const first = await RunGate(null, async () => PassingEvaluation())
    ;(first.toolchain as Record<string, unknown>).poison = 42
    const second = await RunGate(null, async () => PassingEvaluation())

    expect(second.toolchain).toEqual({})
    expect(second.toolchain).not.toBe(first.toolchain)
    await expect(EmitGateResultWithDependencies(root, second, {
      AtomicWriterOperations: NodeAtomicWriterOperations(),
      WriteStdout: (_value: string) => {}
    })).resolves.toEndWith("gate-protocol-error.json")
  })

  test("keeps stage-reserved checks internal and returns an emittable internal failure for forgeries", async () => {
    const root = await Fixture()
    const { EmitGateResultWithDependencies, NodeAtomicWriterOperations, RunGate } = await LoadResult()
    const result = await RunGate(Options(root), async () => PassingEvaluation({
      Checks: [{ id: "GATE_PROTOCOL_ERROR", status: "fail" }]
    }))

    expect(result.inputsSha256).not.toBeNull()
    expect(result.subjects.checked).toBe(0)
    expect(result.checks.map((check) => check.id)).toEqual(["GATE_INTERNAL_ERROR"])
    await expect(EmitGateResultWithDependencies(root, result, {
      AtomicWriterOperations: NodeAtomicWriterOperations(),
      WriteStdout: (_value: string) => {}
    })).resolves.toEndWith("unit-fixtures.json")
  })

  test("snapshots the complete evaluator graph once before reserved-id and artifact admission", async () => {
    const root = await Fixture()
    await Bun.write(join(root, "artifact.log"), "artifact\n")
    const { EmitGateResultWithDependencies, NodeAtomicWriterOperations, RunGate } = await LoadResult()
    const check: Record<string, unknown> = { status: "pass" }
    const artifact: Record<string, unknown> = { kind: "log" }
    const evaluation: Record<string, unknown> = {
      Checks: [check],
      ArtifactPaths: [artifact]
    }
    let subjectReads = 0
    let checkIdReads = 0
    let artifactPathReads = 0
    Object.defineProperty(evaluation, "SubjectsChecked", {
      enumerable: true,
      get: () => ++subjectReads === 1 ? 1 : 0
    })
    Object.defineProperty(check, "id", {
      enumerable: true,
      get: () => ++checkIdReads === 1 ? "USER_PASS" : "GATE_PROTOCOL_ERROR"
    })
    Object.defineProperty(artifact, "path", {
      enumerable: true,
      get: () => ++artifactPathReads === 1 ? "artifact.log" : "../outside.log"
    })

    const result = await RunGate(Options(root), async () => evaluation as never)

    expect(result.status).toBe("pass")
    expect(result.subjects.checked).toBe(1)
    expect(result.checks).toEqual([{ id: "USER_PASS", status: "pass" }])
    expect(result.artifacts).toEqual([
      { kind: "log", path: "artifact.log", sha256: Sha256("artifact\n") }
    ])
    expect({ subjectReads, checkIdReads, artifactPathReads }).toEqual({
      subjectReads: 1,
      checkIdReads: 1,
      artifactPathReads: 1
    })
    await expect(EmitGateResultWithDependencies(root, result, {
      AtomicWriterOperations: NodeAtomicWriterOperations(),
      WriteStdout: (_value: string) => {}
    })).resolves.toEndWith("unit-fixtures.json")
  })

  test("persists evaluator exceptions even when the thrown value cannot be coerced", async () => {
    const root = await Fixture()
    const { EmitGateResultWithDependencies, NodeAtomicWriterOperations, RunGate } = await LoadResult()
    const result = await RunGate(Options(root), async () => {
      throw { toString: () => { throw new Error("hostile evaluator error coercion") } }
    })

    expect(result.inputsSha256).not.toBeNull()
    expect(result.subjects.checked).toBe(0)
    expect(result.checks.map((check) => check.id)).toEqual(["GATE_INTERNAL_ERROR"])
    await expect(EmitGateResultWithDependencies(root, result, {
      AtomicWriterOperations: NodeAtomicWriterOperations(),
      WriteStdout: (_value: string) => {}
    })).resolves.toEndWith("unit-fixtures.json")
  })

  test("converts every malformed evaluator shape into one schema-valid internal error", async () => {
    const root = await Fixture()
    const { RunGate } = await LoadResult()
    const malformed = [
      null,
      { SubjectsChecked: 1, Checks: null },
      { SubjectsChecked: 1, Checks: [{ id: "", status: "pass" }] },
      { SubjectsChecked: 1, Checks: [{ id: "PASS", status: "pass", extra: true }] },
      { SubjectsChecked: 1, Checks: [{ id: "PASS", status: "unknown" }] },
      { SubjectsChecked: 1, Checks: [{ id: "PASS", status: "pass", path: 1 }] },
      { SubjectsChecked: 1, Checks: [{ id: "PASS", status: "pass", expected: {} }] },
      { SubjectsChecked: 1, Checks: [{ id: "PASS", status: "pass", actual: Number.NaN }] },
      { SubjectsChecked: 1, Checks: [{ id: "PASS", status: "pass", detail: false }] },
      { SubjectsChecked: -1, Checks: [{ id: "PASS", status: "pass" }] },
      { SubjectsChecked: 1, Checks: [{ id: "PASS", status: "pass" }], ArtifactPaths: {} },
      { SubjectsChecked: 1, Checks: [{ id: "PASS", status: "pass" }], ArtifactPaths: [null] },
      { SubjectsChecked: 1, Checks: [{ id: "PASS", status: "pass" }], ArtifactPaths: [{ kind: 1, path: "input.txt" }] },
      { SubjectsChecked: 1, Checks: [{ id: "PASS", status: "pass" }], ArtifactPaths: [{ kind: "log", path: "" }] }
    ]
    const ajv = new Ajv2020({ strict: true })
    const validate = ajv.compile(await ReadSchema())

    for (const evaluation of malformed) {
      const result = await RunGate(Options(root), async () => evaluation as never)
      expect(result.status).toBe("fail")
      expect(result.subjects.checked).toBe(0)
      expect(result.checks.map((check) => check.id)).toEqual(["GATE_INTERNAL_ERROR"])
      expect(validate(result)).toBe(true)
    }
  })

  test("gives the evaluator only snapshotted bytes when an original changes", async () => {
    const root = await Fixture()
    const { RunGate } = await LoadResult()
    const originalSha = Sha256("input\n")
    const expectedInventorySha = Sha256(`input.txt\0${originalSha}\n`)
    const result = await RunGate(Options(root), async (snapshot) => {
      await Bun.write(join(root, "input.txt"), "changed\n")
      expect(new TextDecoder().decode(snapshot.Files[0]?.Bytes)).toBe("input\n")
      expect(snapshot.Files[0]?.Sha256).toBe(originalSha)
      return PassingEvaluation()
    })

    expect(result.inputsSha256).toBe(expectedInventorySha)
    expect(await readFile(join(root, "input.txt"), "utf8")).toBe("changed\n")
  })

  test("generates a valid runId and canonical millisecond timestamps when omitted", async () => {
    const root = await Fixture()
    const { RunGate } = await LoadResult()
    const result = await RunGate(Options(root, { runId: undefined }), async () => PassingEvaluation())

    expect(result.runId).toMatch(/^[a-z0-9][a-z0-9_-]{0,95}$/)
    expect(result.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(result.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  test("confines, sorts, hashes, and records artifact files", async () => {
    const root = await Fixture()
    await mkdir(join(root, "artifacts"))
    await Bun.write(join(root, "artifacts", "z.log"), "z\n")
    await Bun.write(join(root, "artifacts", "a.log"), "a\n")
    const { RunGate } = await LoadResult()
    const result = await RunGate(Options(root), async () => PassingEvaluation({
      ArtifactPaths: [
        { kind: "stderr", path: "artifacts/z.log" },
        { kind: "stdout", path: "artifacts/a.log" }
      ]
    }))

    expect(result.status).toBe("pass")
    expect(result.artifacts).toEqual([
      { kind: "stdout", path: "artifacts/a.log", sha256: Sha256("a\n") },
      { kind: "stderr", path: "artifacts/z.log", sha256: Sha256("z\n") }
    ])
  })

  test("binds artifact hashing to the root realpath captured before evaluator admission", async () => {
    const container = await mkdtemp(join(tmpdir(), "likego-gate-root-swap-"))
    Roots.push(container)
    const first = join(container, "first")
    const second = join(container, "second")
    const rootLink = join(container, "root")
    await mkdir(first)
    await mkdir(second)
    await Bun.write(join(first, "input.txt"), "input\n")
    await Bun.write(join(first, "artifact.log"), "first\n")
    await Bun.write(join(second, "artifact.log"), "second\n")
    await symlink(first, rootLink)
    const { RunGate } = await LoadResult()

    const result = await RunGate(Options(rootLink), async () => {
      await rm(rootLink)
      await symlink(second, rootLink)
      return PassingEvaluation({
        ArtifactPaths: [{ kind: "log", path: "artifact.log" }]
      })
    })

    expect(result.status).toBe("pass")
    expect(result.artifacts).toEqual([
      { kind: "log", path: "artifact.log", sha256: Sha256("first\n") }
    ])
  })

  test("turns missing, escaped, duplicate, and unreadable artifacts into GATE_ARTIFACT_ERROR", async () => {
    const root = await Fixture()
    const outside = await Fixture()
    await Bun.write(join(root, "unreadable.log"), "secret\n")
    await chmod(join(root, "unreadable.log"), 0)
    await symlink(join(outside, "input.txt"), join(root, "escape.log"))
    await symlink(join(root, "input.txt"), join(root, "alias.log"))
    const { RunGate } = await LoadResult()
    const cases = [
      [{ kind: "log", path: "missing.log" }],
      [{ kind: "log", path: "escape.log" }],
      [{ kind: "one", path: "input.txt" }, { kind: "two", path: "./input.txt" }],
      [{ kind: "one", path: "input.txt" }, { kind: "two", path: "alias.log" }],
      [{ kind: "log", path: "unreadable.log" }]
    ]

    for (const ArtifactPaths of cases) {
      const result = await RunGate(Options(root), async () => PassingEvaluation({ ArtifactPaths }))
      expect(result.status).toBe("fail")
      expect(result.artifacts).toEqual([])
      expect(result.checks.at(-1)?.id).toBe("GATE_ARTIFACT_ERROR")
    }
  })
})

describe("canonical atomic result emission", () => {
  test("the public emitter uses the production atomic writer", async () => {
    const root = await Fixture()
    const { EmitGateResult } = await LoadResult()
    const chunks: string[] = []
    const originalWrite = process.stdout.write
    process.stdout.write = ((value: string | Uint8Array) => {
      chunks.push(String(value))
      return true
    }) as typeof process.stdout.write

    try {
      const canonicalPath = await EmitGateResult(root, ValidResult())
      expect(await readFile(canonicalPath, "utf8")).toBe(`${JSON.stringify(ValidResult())}\n`)
    } finally {
      process.stdout.write = originalWrite
    }
    expect(chunks).toEqual([`LIKEGO_GATE_RESULT=${JSON.stringify(ValidResult())}\n`])
  })

  test("validates then persists compact JSON before writing the one machine line", async () => {
    const root = await Fixture()
    const { EmitGateResultWithDependencies, NodeAtomicWriterOperations } = await LoadResult()
    const stdout: string[] = []
    const canonicalPath = await EmitGateResultWithDependencies(root, ValidResult(), {
      AtomicWriterOperations: NodeAtomicWriterOperations(),
      WriteStdout: (value: string) => { stdout.push(value) }
    })
    const persistedText = await readFile(canonicalPath, "utf8")

    expect(canonicalPath).toBe(join(await realpath(root), ".artifacts", "gates", "unit-fixtures.json"))
    expect(persistedText).toBe(`${JSON.stringify(ValidResult())}\n`)
    expect(stdout).toEqual([`LIKEGO_GATE_RESULT=${JSON.stringify(ValidResult())}\n`])
    expect(JSON.parse(stdout[0]!.slice("LIKEGO_GATE_RESULT=".length))).toEqual(JSON.parse(persistedText))
  })

  test("rejects schema-invalid results without touching a prior canonical file or stdout", async () => {
    const root = await Fixture()
    const canonicalPath = join(root, ".artifacts", "gates", "unit-fixtures.json")
    await mkdir(dirname(canonicalPath), { recursive: true })
    await Bun.write(canonicalPath, "prior\n")
    const { EmitGateResultWithDependencies, NodeAtomicWriterOperations } = await LoadResult()
    const stdout: string[] = []

    await expect(EmitGateResultWithDependencies(root, {
      ...ValidResult(),
      toolchain: { bun: 1 }
    } as never, {
      AtomicWriterOperations: NodeAtomicWriterOperations(),
      WriteStdout: (value: string) => { stdout.push(value) }
    })).rejects.toThrow("GATE_RESULT_SCHEMA_ERROR")
    expect(await readFile(canonicalPath, "utf8")).toBe("prior\n")
    expect(stdout).toEqual([])
  })

  test("rejects invalid calendar timestamps and semantic status/readiness contradictions before writing", async () => {
    const root = await Fixture()
    const { EmitGateResultWithDependencies, NodeAtomicWriterOperations } = await LoadResult()
    const stdout: string[] = []
    const invalidResults = [
      ValidResult({ startedAt: "2026-02-31T00:00:00.000Z" }),
      ValidResult({
        status: "pass",
        checks: [{ id: "FAILED", status: "fail" }]
      }),
      ValidResult({ releaseReadiness: "ready" }),
      ValidResult({ gate: "unit", mode: "fixture" }),
      ValidResult({ gate: "repository-gate", mode: "repository", releaseReadiness: "not-ready" }),
      ValidResult({ subjects: { expected: 0, checked: 0 } }),
      ValidResult({
        startedAt: "2026-07-17T00:00:00.002Z",
        completedAt: "2026-07-17T00:00:00.001Z"
      })
    ]

    for (const result of invalidResults) {
      await expect(EmitGateResultWithDependencies(root, result as never, {
        AtomicWriterOperations: NodeAtomicWriterOperations(),
        WriteStdout: (value: string) => { stdout.push(value) }
      })).rejects.toThrow("GATE_RESULT_SEMANTIC_ERROR")
    }
    expect(stdout).toEqual([])
    expect(await Bun.file(join(root, ".artifacts", "gates", "unit-fixtures.json")).exists()).toBe(false)
  })

  test("binds null input hashes bidirectionally to protocol or input-stage failures", async () => {
    const root = await Fixture()
    const { EmitGateResultWithDependencies, NodeAtomicWriterOperations } = await LoadResult()
    const dependencies = {
      AtomicWriterOperations: NodeAtomicWriterOperations(),
      WriteStdout: (_value: string) => {}
    }
    const invalidResults = [
      ValidResult({ inputsSha256: null }),
      ValidResult({
        status: "fail",
        inputsSha256: null,
        subjects: { expected: 1, checked: 0 },
        checks: [{ id: "UNIT_FAIL", status: "fail" }]
      }),
      ValidResult({
        status: "fail",
        subjects: { expected: 1, checked: 0 },
        checks: [{ id: "GATE_PROTOCOL_ERROR", status: "fail" }]
      }),
      ValidResult({
        status: "fail",
        inputsSha256: null,
        subjects: { expected: 1, checked: 1 },
        checks: [{ id: "GATE_INPUT_ERROR", status: "fail" }]
      }),
      ValidResult({
        status: "fail",
        inputsSha256: null,
        subjects: { expected: 1, checked: 0 },
        checks: [{ id: "GATE_INPUT_ERROR", status: "fail" }],
        artifacts: [{ kind: "log", path: "input.txt", sha256: "0".repeat(64) }]
      }),
      ValidResult({
        status: "fail",
        inputsSha256: null,
        subjects: { expected: 1, checked: 0 },
        checks: [{ id: "GATE_INTERNAL_ERROR", status: "fail" }]
      }),
      ValidResult({
        checks: [{ id: "GATE_PROTOCOL_ERROR", status: "pass" }]
      })
    ]

    for (const result of invalidResults) {
      await expect(EmitGateResultWithDependencies(root, result as never, dependencies))
        .rejects.toThrow("GATE_RESULT_SEMANTIC_ERROR")
    }
  })

  test("rejects symlinked result parents and targets without writing outside the real root", async () => {
    const { EmitGateResultWithDependencies, NodeAtomicWriterOperations } = await LoadResult()

    const parentRoot = await Fixture()
    const parentOutside = await Fixture()
    await symlink(parentOutside, join(parentRoot, ".artifacts"))
    const parentStdout: string[] = []
    await expect(EmitGateResultWithDependencies(parentRoot, ValidResult(), {
      AtomicWriterOperations: NodeAtomicWriterOperations(),
      WriteStdout: (value: string) => { parentStdout.push(value) }
    })).rejects.toThrow("GATE_RESULT_PATH_ERROR")
    expect(parentStdout).toEqual([])
    expect(await Bun.file(join(parentOutside, "gates", "unit-fixtures.json")).exists()).toBe(false)

    const targetRoot = await Fixture()
    const targetOutside = await Fixture()
    await mkdir(join(targetRoot, ".artifacts", "gates"), { recursive: true })
    const outsideTarget = join(targetOutside, "outside-result.json")
    await Bun.write(outsideTarget, "outside-prior\n")
    await symlink(outsideTarget, join(targetRoot, ".artifacts", "gates", "unit-fixtures.json"))
    const targetStdout: string[] = []
    await expect(EmitGateResultWithDependencies(targetRoot, ValidResult(), {
      AtomicWriterOperations: NodeAtomicWriterOperations(),
      WriteStdout: (value: string) => { targetStdout.push(value) }
    })).rejects.toThrow("GATE_RESULT_PATH_ERROR")
    expect(targetStdout).toEqual([])
    expect(await readFile(outsideTarget, "utf8")).toBe("outside-prior\n")
  })

  test("rejects a non-file canonical target introduced after prepare", async () => {
    const root = await Fixture()
    const canonicalPath = join(root, ".artifacts", "gates", "unit-fixtures.json")
    await mkdir(dirname(canonicalPath), { recursive: true })
    const { EmitGateResultWithDependencies, NodeAtomicWriterOperations } = await LoadResult()
    const base = NodeAtomicWriterOperations()
    const stdout: string[] = []

    await expect(EmitGateResultWithDependencies(root, ValidResult(), {
      AtomicWriterOperations: {
        ...base,
        MakeDirectory: async (path: string, identity: Parameters<typeof base.MakeDirectory>[1]) => {
          await base.MakeDirectory(path, identity)
          await mkdir(canonicalPath)
        }
      },
      WriteStdout: (value: string) => { stdout.push(value) }
    })).rejects.toThrow("GATE_RESULT_PATH_ERROR")
    expect(stdout).toEqual([])
    expect((await stat(canonicalPath)).isDirectory()).toBe(true)
  })

  test("revalidates the prepared gates directory across every injected atomic boundary", async () => {
    const { EmitGateResultWithDependencies, NodeAtomicWriterOperations } = await LoadResult()

    for (const stage of ["make-directory", "open", "rename-before", "rename-after"] as const) {
      const root = await Fixture()
      const outside = await Fixture()
      await mkdir(join(outside, "gates"))
      const artifacts = join(root, ".artifacts")
      const preservedArtifacts = join(root, `.artifacts-preserved-${stage}`)
      const outsideCanonical = join(outside, "gates", "unit-fixtures.json")
      const stdout: string[] = []
      const base = NodeAtomicWriterOperations()
      let swapped = false
      const swapParent = async () => {
        if (swapped) return
        await rename(artifacts, preservedArtifacts)
        await symlink(outside, artifacts)
        swapped = true
      }
      const operations = {
        ...base,
        MakeDirectory: async (path: string, identity: Parameters<typeof base.MakeDirectory>[1]) => {
          await base.MakeDirectory(path, identity)
          if (stage === "make-directory") await swapParent()
        },
        Open: async (path: string, identity: Parameters<typeof base.Open>[1]) => {
          if (stage === "open") await swapParent()
          return base.Open(path, identity)
        },
        Rename: async (from: string, to: string, identity: Parameters<typeof base.Rename>[2]) => {
          if (stage === "rename-before") await swapParent()
          await base.Rename(from, to, identity)
          if (stage === "rename-after") await swapParent()
        }
      }
      let error: unknown = null

      try {
        await EmitGateResultWithDependencies(root, ValidResult(), {
          AtomicWriterOperations: operations,
          WriteStdout: (value: string) => { stdout.push(value) }
        })
      } catch (caught) {
        error = caught
      } finally {
        if (swapped) {
          await rm(artifacts, { force: true })
          await rename(preservedArtifacts, artifacts)
        }
      }

      expect(String(error)).toContain("GATE_RESULT_PATH_ERROR")
      expect(stdout).toEqual([])
      expect(await Bun.file(outsideCanonical).exists()).toBe(false)
    }
  })

  test("cleans owned temps through a real-directory replacement after open and before rename", async () => {
    const { EmitGateResultWithDependencies, NodeAtomicWriterOperations } = await LoadResult()

    const results = await Promise.all((["after-open", "before-rename"] as const).map(async (stage) => {
      const root = await Fixture()
      const artifacts = join(root, ".artifacts")
      const gates = join(artifacts, "gates")
      const preservedArtifacts = join(root, `.artifacts-preserved-${stage}`)
      const canonicalPath = join(gates, "unit-fixtures.json")
      await mkdir(gates, { recursive: true })
      await Bun.write(canonicalPath, "prior-pass\n")
      const base = NodeAtomicWriterOperations()
      const stdout: string[] = []
      let swapped = false
      const swapParent = async () => {
        if (swapped) return
        await rename(artifacts, preservedArtifacts)
        await mkdir(gates, { recursive: true })
        swapped = true
      }
      const operations = {
        ...base,
        Open: async (path: string, identity: Parameters<typeof base.Open>[1]) => {
          const handle = await base.Open(path, identity)
          if (stage === "after-open") await swapParent()
          return handle
        },
        Rename: async (from: string, to: string, identity: Parameters<typeof base.Rename>[2]) => {
          if (stage === "before-rename") await swapParent()
          await base.Rename(from, to, identity)
        }
      }
      let error: unknown = null

      try {
        await EmitGateResultWithDependencies(root, ValidResult(), {
          AtomicWriterOperations: operations,
          WriteStdout: (value: string) => { stdout.push(value) }
        })
      } catch (caught) {
        error = caught
      }
      const replacementHasCanonical = await Bun.file(canonicalPath).exists()
      await rm(artifacts, { recursive: true, force: true })
      await rename(preservedArtifacts, artifacts)
      return {
        stage,
        error: String(error),
        stdout,
        replacementHasCanonical,
        prior: await readFile(canonicalPath, "utf8"),
        temps: (await readdir(gates)).filter((name) => name.endsWith(".tmp"))
      }
    }))

    for (const result of results) {
      expect(result.error).toContain("GATE_RESULT_PATH_ERROR")
      expect(result.stdout).toEqual([])
      expect(result.replacementHasCanonical).toBe(false)
      expect(result.prior).toBe("prior-pass\n")
      expect(result.temps).toEqual([])
    }
  })

  test("rolls back seeded and absent canonicals when the real directory changes after rename", async () => {
    const { EmitGateResultWithDependencies, NodeAtomicWriterOperations } = await LoadResult()

    for (const seededPrior of [true, false]) {
      const root = await Fixture()
      const artifacts = join(root, ".artifacts")
      const gates = join(artifacts, "gates")
      const preservedArtifacts = join(root, `.artifacts-preserved-${seededPrior ? "prior" : "empty"}`)
      const canonicalPath = join(gates, "unit-fixtures.json")
      await mkdir(gates, { recursive: true })
      if (seededPrior) await Bun.write(canonicalPath, "prior-pass\n")
      const base = NodeAtomicWriterOperations()
      const stdout: string[] = []
      const operations = {
        ...base,
        Rename: async (from: string, to: string, identity: Parameters<typeof base.Rename>[2]) => {
          await base.Rename(from, to, identity)
          await rename(artifacts, preservedArtifacts)
          await mkdir(gates, { recursive: true })
        }
      }
      let error: unknown = null

      try {
        await EmitGateResultWithDependencies(root, ValidResult(), {
          AtomicWriterOperations: operations,
          WriteStdout: (value: string) => { stdout.push(value) }
        })
      } catch (caught) {
        error = caught
      }
      const replacementHasCanonical = await Bun.file(canonicalPath).exists()
      await rm(artifacts, { recursive: true, force: true })
      await rename(preservedArtifacts, artifacts)

      expect(String(error)).toContain("GATE_RESULT_PATH_ERROR")
      expect(stdout).toEqual([])
      expect(replacementHasCanonical).toBe(false)
      if (seededPrior) {
        expect(await readFile(canonicalPath, "utf8")).toBe("prior-pass\n")
      } else {
        expect(await Bun.file(canonicalPath).exists()).toBe(false)
      }
      expect((await readdir(gates)).filter((name) => name.endsWith(".tmp"))).toEqual([])
    }
  })

  test("rolls back the prior canonical before reporting a directory lease close failure", async () => {
    const root = await Fixture()
    const artifacts = join(root, ".artifacts")
    const gates = join(artifacts, "gates")
    const preservedArtifacts = join(root, ".artifacts-preserved-close")
    const canonicalPath = join(gates, "unit-fixtures.json")
    await mkdir(dirname(canonicalPath), { recursive: true })
    await Bun.write(canonicalPath, "prior-pass\n")
    const { EmitGateResultWithDependencies, NodeAtomicWriterOperations } = await LoadResult()
    const base = NodeAtomicWriterOperations()
    const stdout: string[] = []
    let resolveCalls = 0

    await expect(EmitGateResultWithDependencies(root, ValidResult(), {
      AtomicWriterOperations: {
        ...base,
        LeaseDirectory: async (identity: Parameters<typeof base.LeaseDirectory>[0]) => {
          const lease = await base.LeaseDirectory(identity)
          return {
            Resolve: async () => {
              resolveCalls += 1
              await rename(artifacts, preservedArtifacts)
              await mkdir(gates, { recursive: true })
              return lease.Resolve()
            },
            Close: async () => {
              await lease.Close()
              throw new Error("injected directory lease close failure")
            }
          }
        }
      },
      WriteStdout: (value: string) => { stdout.push(value) }
    })).rejects.toThrow("injected directory lease close failure")
    expect(resolveCalls).toBe(1)
    expect(await Bun.file(canonicalPath).exists()).toBe(false)
    await rm(artifacts, { recursive: true, force: true })
    await rename(preservedArtifacts, artifacts)
    expect(await readFile(canonicalPath, "utf8")).toBe("prior-pass\n")
    expect(stdout).toEqual([])
    expect((await readdir(dirname(canonicalPath))).filter((name) => name.endsWith(".tmp"))).toEqual([])
  })

  test("rolls back the prior canonical and closes the lease when pre-close resolution fails", async () => {
    const root = await Fixture()
    const canonicalPath = join(root, ".artifacts", "gates", "unit-fixtures.json")
    await mkdir(dirname(canonicalPath), { recursive: true })
    await Bun.write(canonicalPath, "prior-pass\n")
    const { EmitGateResultWithDependencies, NodeAtomicWriterOperations } = await LoadResult()
    const base = NodeAtomicWriterOperations()
    const stdout: string[] = []
    let closed = false

    await expect(EmitGateResultWithDependencies(root, ValidResult(), {
      AtomicWriterOperations: {
        ...base,
        LeaseDirectory: async (identity: Parameters<typeof base.LeaseDirectory>[0]) => {
          const lease = await base.LeaseDirectory(identity)
          return {
            Resolve: async () => { throw new Error("injected directory lease resolution failure") },
            Close: async () => {
              await lease.Close()
              closed = true
            }
          }
        }
      },
      WriteStdout: (value: string) => { stdout.push(value) }
    })).rejects.toThrow("injected directory lease resolution failure")
    expect(closed).toBe(true)
    expect(await readFile(canonicalPath, "utf8")).toBe("prior-pass\n")
    expect(stdout).toEqual([])
    expect((await readdir(dirname(canonicalPath))).filter((name) => name.endsWith(".tmp"))).toEqual([])
  })

  test("reports both lease close and rollback failures when recovery becomes unwritable", async () => {
    const root = await Fixture()
    const gates = join(root, ".artifacts", "gates")
    const canonicalPath = join(gates, "unit-fixtures.json")
    await mkdir(gates, { recursive: true })
    await Bun.write(canonicalPath, "prior-pass\n")
    const { EmitGateResultWithDependencies, NodeAtomicWriterOperations } = await LoadResult()
    const base = NodeAtomicWriterOperations()
    const stdout: string[] = []
    let error: unknown = null

    try {
      await EmitGateResultWithDependencies(root, ValidResult(), {
        AtomicWriterOperations: {
          ...base,
          LeaseDirectory: async (identity: Parameters<typeof base.LeaseDirectory>[0]) => {
            const lease = await base.LeaseDirectory(identity)
            return {
              Resolve: lease.Resolve,
              Close: async () => {
                await lease.Close()
                await chmod(gates, 0o500)
                throw new Error("injected directory lease close failure")
              }
            }
          }
        },
        WriteStdout: (value: string) => { stdout.push(value) }
      })
    } catch (caught) {
      error = caught
    } finally {
      await chmod(gates, 0o700)
    }

    expect(error).toBeInstanceOf(AggregateError)
    const errors = (error as AggregateError).errors
    expect((errors[0] as Error).message).toBe("injected directory lease close failure")
    expect((errors[1] as NodeJS.ErrnoException).code).toBe("EACCES")
    expect(stdout).toEqual([])
    expect(await readFile(canonicalPath, "utf8")).not.toBe("prior-pass\n")
  })

  test("reports a lease close failure after a primary write failure without touching the prior", async () => {
    const root = await Fixture()
    const canonicalPath = join(root, ".artifacts", "gates", "unit-fixtures.json")
    await mkdir(dirname(canonicalPath), { recursive: true })
    await Bun.write(canonicalPath, "prior-pass\n")
    const { EmitGateResultWithDependencies, NodeAtomicWriterOperations } = await LoadResult()
    const base = NodeAtomicWriterOperations()
    const stdout: string[] = []
    let error: unknown = null

    try {
      await EmitGateResultWithDependencies(root, ValidResult(), {
        AtomicWriterOperations: {
          ...base,
          LeaseDirectory: async (identity: Parameters<typeof base.LeaseDirectory>[0]) => {
            const lease = await base.LeaseDirectory(identity)
            return {
              Resolve: lease.Resolve,
              Close: async () => {
                await lease.Close()
                throw new Error("injected directory lease close failure")
              }
            }
          },
          Open: async () => { throw new Error("injected primary open failure") }
        },
        WriteStdout: (value: string) => { stdout.push(value) }
      })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors.map((item) => (item as Error).message)).toEqual([
      "injected primary open failure",
      "injected directory lease close failure"
    ])
    expect(await readFile(canonicalPath, "utf8")).toBe("prior-pass\n")
    expect(stdout).toEqual([])
    expect((await readdir(dirname(canonicalPath))).filter((name) => name.endsWith(".tmp"))).toEqual([])
  })

  test("reports identity and rollback errors together when the relocated directory becomes unwritable", async () => {
    const root = await Fixture()
    const artifacts = join(root, ".artifacts")
    const gates = join(artifacts, "gates")
    const preservedArtifacts = join(root, ".artifacts-preserved-unwritable")
    const canonicalPath = join(gates, "unit-fixtures.json")
    await mkdir(gates, { recursive: true })
    await Bun.write(canonicalPath, "prior-pass\n")
    const { EmitGateResultWithDependencies, NodeAtomicWriterOperations } = await LoadResult()
    const base = NodeAtomicWriterOperations()
    const stdout: string[] = []
    let error: unknown = null

    try {
      await EmitGateResultWithDependencies(root, ValidResult(), {
        AtomicWriterOperations: {
          ...base,
          Rename: async (from: string, to: string, identity: Parameters<typeof base.Rename>[2]) => {
            await base.Rename(from, to, identity)
            await rename(artifacts, preservedArtifacts)
            await mkdir(gates, { recursive: true })
            await chmod(join(preservedArtifacts, "gates"), 0o500)
          }
        },
        WriteStdout: (value: string) => { stdout.push(value) }
      })
    } catch (caught) {
      error = caught
    } finally {
      await chmod(join(preservedArtifacts, "gates"), 0o700)
    }
    expect(error).toBeInstanceOf(AggregateError)
    const errors = (error as AggregateError).errors
    expect(String(errors[0])).toContain("GATE_RESULT_PATH_ERROR")
    expect((errors[1] as NodeJS.ErrnoException).code).toBe("EACCES")
    expect(stdout).toEqual([])
    expect(await Bun.file(canonicalPath).exists()).toBe(false)
    await rm(artifacts, { recursive: true, force: true })
    await rename(preservedArtifacts, artifacts)
    expect(await readFile(canonicalPath, "utf8")).not.toBe("prior-pass\n")
  })

  test("rejects non-directory roots and parent permission failures as confined path errors", async () => {
    const { EmitGateResultWithDependencies, NodeAtomicWriterOperations } = await LoadResult()
    const fileRoot = await Fixture()
    const dependencies = {
      AtomicWriterOperations: NodeAtomicWriterOperations(),
      WriteStdout: (_value: string) => {}
    }
    await expect(EmitGateResultWithDependencies(join(fileRoot, "input.txt"), ValidResult(), dependencies))
      .rejects.toThrow("GATE_RESULT_PATH_ERROR")

    for (const mode of [0o000, 0o500]) {
      const root = await Fixture()
      const artifacts = join(root, ".artifacts")
      await mkdir(artifacts)
      await chmod(artifacts, mode)
      try {
        await expect(EmitGateResultWithDependencies(root, ValidResult(), dependencies))
          .rejects.toThrow("GATE_RESULT_PATH_ERROR")
      } finally {
        await chmod(artifacts, 0o700)
      }
    }
  })

  test("preserves prior PASS, removes temps, and emits no line for each atomic stage failure", async () => {
    const stages = ["open", "write", "sync", "close", "rename"] as const

    for (const stage of stages) {
      const root = await Fixture()
      const canonicalPath = join(root, ".artifacts", "gates", "unit-fixtures.json")
      await mkdir(dirname(canonicalPath), { recursive: true })
      await Bun.write(canonicalPath, "prior-pass\n")
      const { EmitGateResultWithDependencies, NodeAtomicWriterOperations } = await LoadResult()
      const base = NodeAtomicWriterOperations()
      const stdout: string[] = []
      const operations = {
        ...base,
        Open: async (path: string, identity: Parameters<typeof base.Open>[1]) => {
          if (stage === "open") {
            throw new Error("injected open failure")
          }
          const handle = await base.Open(path, identity)
          return {
            Write: async (value: string) => {
              if (stage === "write") {
                throw new Error("injected write failure")
              }
              await handle.Write(value)
            },
            Sync: async () => {
              if (stage === "sync") {
                throw new Error("injected sync failure")
              }
              await handle.Sync()
            },
            Close: async () => {
              await handle.Close()
              if (stage === "close") {
                throw new Error("injected close failure")
              }
            }
          }
        },
        Rename: async (from: string, to: string, identity: Parameters<typeof base.Rename>[2]) => {
          if (stage === "rename") {
            throw new Error("injected rename failure")
          }
          await base.Rename(from, to, identity)
        }
      }

      await expect(EmitGateResultWithDependencies(root, ValidResult(), {
        AtomicWriterOperations: operations,
        WriteStdout: (value: string) => { stdout.push(value) }
      })).rejects.toThrow(`injected ${stage} failure`)
      expect(await readFile(canonicalPath, "utf8")).toBe("prior-pass\n")
      expect(stdout).toEqual([])
      expect((await readdir(dirname(canonicalPath))).filter((name) => name.endsWith(".tmp"))).toEqual([])
    }
  })

  test("uses exclusive unique temp names for concurrent writers and cleans both", async () => {
    const root = await Fixture()
    const { EmitGateResultWithDependencies, NodeAtomicWriterOperations } = await LoadResult()
    const base = NodeAtomicWriterOperations()
    const opened: string[] = []
    const operations = {
      ...base,
      Open: async (path: string, identity: Parameters<typeof base.Open>[1]) => {
        opened.push(path)
        return base.Open(path, identity)
      }
    }
    const dependencies = {
      AtomicWriterOperations: operations,
      WriteStdout: (_value: string) => {}
    }

    await Promise.all([
      EmitGateResultWithDependencies(root, ValidResult(), dependencies),
      EmitGateResultWithDependencies(root, ValidResult(), dependencies)
    ])

    expect(new Set(opened).size).toBe(2)
    for (const path of opened) {
      expect(path).toContain("unit-fixtures.unit-run")
      expect(path).toContain(`.${process.pid}.`)
      expect(path.endsWith(".tmp")).toBe(true)
    }
    expect((await readdir(join(root, ".artifacts", "gates"))).filter((name) => name.endsWith(".tmp"))).toEqual([])
  })

  test("does not remove a preexisting colliding temp when exclusive open fails", async () => {
    const root = await Fixture()
    const canonicalPath = join(root, ".artifacts", "gates", "unit-fixtures.json")
    await mkdir(dirname(canonicalPath), { recursive: true })
    const tempPath = `${canonicalPath}.unit-fixtures.unit-run.4242.collision.tmp`
    await Bun.write(tempPath, "belongs-to-another-writer\n")
    const { EmitGateResultWithDependencies, NodeAtomicWriterOperations } = await LoadResult()
    const base = NodeAtomicWriterOperations()

    await expect(EmitGateResultWithDependencies(root, ValidResult(), {
      AtomicWriterOperations: {
        ...base,
        Pid: 4242,
        RandomSuffix: () => "collision"
      },
      WriteStdout: (_value: string) => {}
    })).rejects.toThrow()
    expect(await readFile(tempPath, "utf8")).toBe("belongs-to-another-writer\n")
    expect(await Bun.file(canonicalPath).exists()).toBe(false)
  })

  test("aggregates a primary write failure with an independently attempted temp-cleanup failure", async () => {
    const root = await Fixture()
    const canonicalPath = join(root, ".artifacts", "gates", "unit-fixtures.json")
    await mkdir(dirname(canonicalPath), { recursive: true })
    await Bun.write(canonicalPath, "prior-pass\n")
    const { EmitGateResultWithDependencies, NodeAtomicWriterOperations } = await LoadResult()
    const base = NodeAtomicWriterOperations()
    const stdout: string[] = []
    const operations = {
      ...base,
      Open: async (path: string, identity: Parameters<typeof base.Open>[1]) => {
        const handle = await base.Open(path, identity)
        return {
          ...handle,
          Write: async (_value: string) => { throw new Error("injected write failure") }
        }
      },
      Remove: async (path: string, identity: Parameters<typeof base.Remove>[1]) => {
        await base.Remove(path, identity)
        throw new Error("injected cleanup failure")
      }
    }

    try {
      await EmitGateResultWithDependencies(root, ValidResult(), {
        AtomicWriterOperations: operations,
        WriteStdout: (value: string) => { stdout.push(value) }
      })
      throw new Error("expected emission failure")
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError)
      expect((error as AggregateError).errors.map((item) => (item as Error).message)).toEqual([
        "injected write failure",
        "injected cleanup failure"
      ])
    }
    expect(await readFile(canonicalPath, "utf8")).toBe("prior-pass\n")
    expect(stdout).toEqual([])
    expect((await readdir(dirname(canonicalPath))).filter((name) => name.endsWith(".tmp"))).toEqual([])
  })

  test("does not run fallible temp cleanup after a successful atomic rename", async () => {
    const root = await Fixture()
    const { EmitGateResultWithDependencies, NodeAtomicWriterOperations } = await LoadResult()
    const base = NodeAtomicWriterOperations()
    let removeCalled = false
    const stdout: string[] = []

    const canonicalPath = await EmitGateResultWithDependencies(root, ValidResult(), {
      AtomicWriterOperations: {
        ...base,
        Remove: async (path: string, identity: Parameters<typeof base.Remove>[1]) => {
          removeCalled = true
          await base.Remove(path, identity)
          throw new Error("cleanup must not run after rename")
        }
      },
      WriteStdout: (value: string) => { stdout.push(value) }
    })

    expect(removeCalled).toBe(false)
    expect(await readFile(canonicalPath, "utf8")).toBe(`${JSON.stringify(ValidResult())}\n`)
    expect(stdout).toHaveLength(1)
  })

  test("the production atomic directory recheck rejects a non-directory", async () => {
    const root = await Fixture()
    const { NodeAtomicWriterOperations } = await LoadResult()

    const path = join(root, "input.txt")
    await expect(NodeAtomicWriterOperations().MakeDirectory(path, {
      Path: path,
      RealPath: path,
      Device: 0,
      Inode: 0
    }))
      .rejects.toThrow("GATE_RESULT_PATH_ERROR")
  })

  test("the production atomic operations reject mismatched identities and escaped child paths", async () => {
    const root = await Fixture()
    const gates = join(root, ".artifacts", "gates")
    await mkdir(gates, { recursive: true })
    const gatesInformation = await stat(gates)
    const { NodeAtomicWriterOperations } = await LoadResult()
    const operations = NodeAtomicWriterOperations()
    const identity = {
      Path: gates,
      RealPath: await realpath(gates),
      Device: gatesInformation.dev,
      Inode: gatesInformation.ino
    }

    await expect(operations.MakeDirectory(gates, {
      ...identity,
      Path: join(root, "different-gates")
    })).rejects.toThrow("GATE_RESULT_PATH_ERROR")
    await expect(operations.Open(join(root, "escaped.tmp"), identity))
      .rejects.toThrow("GATE_RESULT_PATH_ERROR")
    expect(await Bun.file(join(root, "escaped.tmp")).exists()).toBe(false)
  })

  test("a directory lease rejects identity mutation after acquisition", async () => {
    const root = await Fixture()
    const gates = join(root, ".artifacts", "gates")
    await mkdir(gates, { recursive: true })
    const gatesInformation = await stat(gates)
    const { NodeAtomicWriterOperations } = await LoadResult()
    const operations = NodeAtomicWriterOperations()
    const identity = {
      Path: gates,
      RealPath: await realpath(gates),
      Device: gatesInformation.dev,
      Inode: gatesInformation.ino
    }
    const lease = await operations.LeaseDirectory(identity)
    identity.Inode += 1

    await expect(lease.Resolve()).rejects.toThrow("GATE_RESULT_PATH_ERROR")
    await lease.Close()
  })

  test("uses an original-path logical lease when directory descriptors are disabled", async () => {
    const root = await Fixture()
    const artifacts = join(root, ".artifacts")
    const gates = join(artifacts, "gates")
    const preservedArtifacts = join(root, ".artifacts-preserved-logical-lease")
    await mkdir(gates, { recursive: true })
    const gatesInformation = await stat(gates)
    const { NodeAtomicWriterOperations } = await LoadResult()
    const operations = NodeAtomicWriterOperations(null)
    const identity = {
      Path: gates,
      RealPath: await realpath(gates),
      Device: gatesInformation.dev,
      Inode: gatesInformation.ino
    }
    const lease = await operations.LeaseDirectory(identity)

    expect(await lease.Resolve()).toEqual(identity)
    await rename(artifacts, preservedArtifacts)
    await mkdir(gates, { recursive: true })
    let relocatedError: unknown = null
    try {
      await lease.Resolve()
    } catch (error) {
      relocatedError = error
    }
    await rm(artifacts, { recursive: true, force: true })
    await rename(preservedArtifacts, artifacts)
    await lease.Close()
    await lease.Close()

    expect(String(relocatedError)).toContain("GATE_RESULT_PATH_ERROR")
    await expect(lease.Resolve()).rejects.toThrow("GATE_RESULT_PATH_ERROR")
  })
})

describe("protocol probe CLI", () => {
  test("Main emits current-run canonical results for pass, evaluator, and input scenarios", async () => {
    const root = await Fixture()
    const { Main } = await LoadCli()

    for (const [scenario, expectedStatus, expectedCode] of [
      ["pass", "pass", "PROTOCOL_PROBE_PASS"],
      ["evaluator-throw", "fail", "GATE_INTERNAL_ERROR"],
      ["input-error", "fail", "GATE_INPUT_ERROR"]
    ] as const) {
      const stdout: string[] = []
      const stderr: string[] = []
      const runId = `cli-${scenario.replaceAll("-", "_")}`
      const exitCode = await Main([
        "--scenario", scenario,
        "--root", root,
        "--run-id", runId
      ], {
        WriteStdout: (value: string) => { stdout.push(value) },
        WriteStderr: (value: string) => { stderr.push(value) }
      })
      const persisted = JSON.parse(await readFile(join(root, ".artifacts", "gates", "protocol-probe.json"), "utf8")) as {
        readonly runId: string
        readonly status: string
        readonly checks: readonly { readonly id: string }[]
      }

      expect(exitCode).toBe(expectedStatus === "pass" ? 0 : 1)
      expect(stderr).toEqual([])
      expect(stdout).toHaveLength(1)
      expect(persisted.runId).toBe(runId)
      expect(persisted.status).toBe(expectedStatus)
      expect(persisted.checks.map((check) => check.id)).toContain(expectedCode)
      expect(JSON.parse(stdout[0]!.slice("LIKEGO_GATE_RESULT=".length))).toEqual(persisted)
    }
  })

  test("injected emission failure preserves prior JSON, prints stderr only, and rejects invalid arguments", async () => {
    const root = await Fixture()
    const canonicalPath = join(root, ".artifacts", "gates", "protocol-probe.json")
    await mkdir(dirname(canonicalPath), { recursive: true })
    await Bun.write(canonicalPath, "prior-result\n")
    const { Main } = await LoadCli()
    const stdout: string[] = []
    const stderr: string[] = []

    expect(await Main([
      "--scenario", "emission-error",
      "--root", root,
      "--run-id", "cli-emission"
    ], {
      WriteStdout: (value: string) => { stdout.push(value) },
      WriteStderr: (value: string) => { stderr.push(value) }
    })).toBe(1)
    expect(await readFile(canonicalPath, "utf8")).toBe("prior-result\n")
    expect(stdout).toEqual([])
    expect(stderr).toEqual(["GATE_EMIT_ERROR injected emission failure\n"])

    expect(await Main(["--scenario", "unknown"], {
      WriteStdout: (value: string) => { stdout.push(value) },
      WriteStderr: (value: string) => { stderr.push(value) }
    })).toBe(1)
    expect(stderr.at(-1)).toBe("GATE_CLI_USAGE invalid protocol probe arguments\n")
  })

  test("uses default process IO and rejects missing scenario names or values", async () => {
    const root = await Fixture()
    const { Main } = await LoadCli()
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
      expect(await Main(["--scenario", "pass", "--root", root])).toBe(0)
      expect(await Main([])).toBe(1)
      expect(await Main(["--scenario"])).toBe(1)
    } finally {
      process.stdout.write = originalStdout
      process.stderr.write = originalStderr
    }
    expect(stdout).toHaveLength(1)
    expect(stderr).toEqual([
      "GATE_CLI_USAGE invalid protocol probe arguments\n",
      "GATE_CLI_USAGE invalid protocol probe arguments\n"
    ])
  })
})
