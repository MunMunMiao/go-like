import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import { tmpdir } from "node:os"
import type { InputSnapshot, SnapshotFile } from "./result.ts"

interface TestIssue {
  readonly Code: string
  readonly Path: string
  readonly Message: string
}

const RepositoryRoot = join(import.meta.dir, "../..")
const FamilyRoot = "tools/manifests/fixtures"
const CasesPath = `${FamilyRoot}/cases.json`
const TemporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(TemporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function LoadCorpus() {
  return import("./fixture-corpus.ts")
}

async function LoadManifestValidator() {
  return import("../manifests/validate.ts")
}

function Sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

function Snapshot(files: Readonly<Record<string, string>>): InputSnapshot {
  const encoder = new TextEncoder()
  const Files: SnapshotFile[] = Object.entries(files).map(([Path, value]) => {
    const Bytes = encoder.encode(value)
    return { Path, RealPath: join("/virtual/fixture-corpus", Path), Sha256: Sha256(Bytes), Bytes }
  }).sort((left, right) => left.Path < right.Path ? -1 : left.Path > right.Path ? 1 : 0)
  return {
    Sha256: Sha256(Files.map((file) => `${file.Path}\0${file.Sha256}\n`).join("")),
    Files
  }
}

function Cases(value: unknown): string {
  return `${JSON.stringify({ schemaVersion: 1, cases: value }, null, 2)}\n`
}

function Case(id: string, path: string, expectedCodes: readonly string[] = []) {
  return { id, path, expectedCodes }
}

function FailureIds(checks: readonly { readonly id: string; readonly status: string }[]): string[] {
  return checks.filter((check) => check.status === "fail").map((check) => check.id)
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

describe("committed fixture assets", () => {
  test("loads the common case list and accounts for every committed manifest payload", async () => {
    const document = JSON.parse(await readFile(join(RepositoryRoot, CasesPath), "utf8")) as {
      schemaVersion: number
      cases: Array<{ id: string; path: string; expectedCodes: string[] }>
    }
    const cases = document.cases
    expect(document.schemaVersion).toBe(1)
    expect(cases.length).toBeGreaterThan(0)
    expect(new Set(cases.map((item) => item.id)).size).toBe(cases.length)
    expect(new Set(cases.map((item) => item.path)).size).toBe(cases.length)

    const payloads = (await FilesBelow(join(RepositoryRoot, FamilyRoot)))
      .filter((path) => path !== "cases.json")
    for (const payload of payloads) {
      expect(cases.filter((item) => payload.startsWith(`${item.path}/`))).toHaveLength(1)
    }
    for (const item of cases) {
      expect(payloads.some((payload) => payload.startsWith(`${item.path}/`))).toBe(true)
    }
  })
})

describe("FindBunDiscoveredFixturePaths", () => {
  test("recursively rejects all Bun discovery substrings across current and future fixture trees", async () => {
    const { FindBunDiscoveredFixturePaths } = await LoadCorpus()
    expect(await FindBunDiscoveredFixturePaths(RepositoryRoot)).toEqual([])

    const root = await mkdtemp(join(tmpdir(), "likego-bun-fixture-scan-"))
    TemporaryRoots.push(root)
    const staged = [
      "tools/one/fixtures/a/payload.test.json",
      "tools/two/fixtures/b/payload_test_case.json",
      "tools/three/fixtures/c/payload.spec.json",
      "test/runtime/probes/d/payload_spec_case.json",
      "tools/four/fixtures/e/link.test.json"
    ]
    for (const path of [...staged.slice(0, -1), "tools/one/fixtures/a/safe.virtual.json"]) {
      await mkdir(dirname(join(root, path)), { recursive: true })
      await Bun.write(join(root, path), "{}\n")
    }
    await mkdir(dirname(join(root, staged.at(-1)!)), { recursive: true })
    await symlink("missing-target", join(root, staged.at(-1)!))
    expect(await FindBunDiscoveredFixturePaths(root)).toEqual(staged.sort())
  })

  test("keeps a committed descriptor safe while naming an explicit virtual dist test target", async () => {
    const { FindBunDiscoveredFixturePaths } = await LoadCorpus()
    const casesBefore = await readFile(join(RepositoryRoot, CasesPath), "utf8")
    const descriptorPath = join(
      RepositoryRoot,
      FamilyRoot,
      "application-owned/structural-server/examples/custom-server/dist-test.virtual.json"
    )
    const descriptor = JSON.parse(await readFile(descriptorPath, "utf8")) as {
      schemaVersion: number
      target: string
      utf8: string
    }

    expect(descriptor).toEqual({
      schemaVersion: 1,
      target: "dist/application-owned-server.test.js",
      utf8: "export const stagedApplicationServer = true\n"
    })
    expect(await FindBunDiscoveredFixturePaths(RepositoryRoot)).not.toContain(
      relative(RepositoryRoot, descriptorPath).split("\\").join("/")
    )
    expect(await readFile(join(RepositoryRoot, CasesPath), "utf8")).toBe(casesBefore)
  })
})

describe("EvaluateFixtureCorpus", () => {
  test("fails closed for an empty case list or empty family root", async () => {
    const { EvaluateFixtureCorpus } = await LoadCorpus()
    const validate = (): readonly TestIssue[] => []
    const emptyList = EvaluateFixtureCorpus(Snapshot({ [CasesPath]: Cases([]) }), FamilyRoot, validate)
    const emptyRoot = EvaluateFixtureCorpus(
      Snapshot({ [CasesPath]: Cases([Case("one", "valid/one")]), [`${FamilyRoot}/valid/one/a.json`]: "{}\n" }),
      "",
      validate
    )

    expect(emptyList.SubjectsExpected).toBe(0)
    expect(emptyList.SubjectsChecked).toBe(0)
    expect(FailureIds(emptyList.Checks)).toEqual(["FIXTURE_INVENTORY_MISMATCH"])
    expect(emptyRoot.SubjectsChecked).toBe(0)
    expect(FailureIds(emptyRoot.Checks)).toEqual(["FIXTURE_INVENTORY_MISMATCH"])
  })

  test("rejects duplicate ids, duplicate paths, missing paths, and extra unlisted payloads", async () => {
    const { EvaluateFixtureCorpus } = await LoadCorpus()
    const validate = (): readonly TestIssue[] => []
    const inventories: InputSnapshot[] = [
      Snapshot({
        [CasesPath]: Cases([Case("same", "valid/one"), Case("same", "valid/two")]),
        [`${FamilyRoot}/valid/one/a.json`]: "{}\n",
        [`${FamilyRoot}/valid/two/a.json`]: "{}\n"
      }),
      Snapshot({
        [CasesPath]: Cases([Case("one", "valid/same"), Case("two", "valid/same")]),
        [`${FamilyRoot}/valid/same/a.json`]: "{}\n"
      }),
      Snapshot({ [CasesPath]: Cases([Case("missing", "valid/missing")]) }),
      Snapshot({
        [CasesPath]: Cases([Case("one", "valid/one")]),
        [`${FamilyRoot}/valid/one/a.json`]: "{}\n",
        [`${FamilyRoot}/unlisted/a.json`]: "{}\n"
      })
    ]

    for (const inventory of inventories) {
      const evaluation = EvaluateFixtureCorpus(inventory, FamilyRoot, validate)
      expect(evaluation.SubjectsChecked).toBe(0)
      expect(FailureIds(evaluation.Checks)).toEqual(["FIXTURE_INVENTORY_MISMATCH"])
    }
  })

  test("rejects malformed common documents, absent cases, and duplicate snapshot paths", async () => {
    const { EvaluateFixtureCorpus } = await LoadCorpus()
    const validate = (): readonly TestIssue[] => []
    const duplicateBase = Snapshot({
      [CasesPath]: Cases([Case("one", "valid/one")]),
      [`${FamilyRoot}/valid/one/a.json`]: "{}\n"
    })
    const duplicateSnapshot: InputSnapshot = {
      Sha256: duplicateBase.Sha256,
      Files: [...duplicateBase.Files, duplicateBase.Files[0]!]
    }
    const malformed: InputSnapshot[] = [
      Snapshot({ [CasesPath]: "{\n" }),
      Snapshot({ [CasesPath]: `${JSON.stringify({ schemaVersion: 2, cases: [] })}\n` }),
      Snapshot({ [CasesPath]: Cases([{ ...Case("one", "valid/one"), extra: true }]) }),
      Snapshot({ [`${FamilyRoot}/valid/one/a.json`]: "{}\n" }),
      duplicateSnapshot
    ]

    for (const snapshot of malformed) {
      const evaluation = EvaluateFixtureCorpus(snapshot, FamilyRoot, validate)
      expect(evaluation.SubjectsChecked).toBe(0)
      expect(FailureIds(evaluation.Checks)).toEqual(["FIXTURE_INVENTORY_MISMATCH"])
    }
  })

  test("compares sorted negative codes as an exact multiset and preserves duplicates", async () => {
    const { EvaluateFixtureCorpus } = await LoadCorpus()
    const snapshot = Snapshot({
      [CasesPath]: Cases([Case("negative", "invalid/negative", ["Z_CODE", "A_CODE", "A_CODE"])]),
      [`${FamilyRoot}/invalid/negative/payload.json`]: "{}\n"
    })
    const issue = (Code: string): TestIssue => ({ Code, Path: "payload.json", Message: Code })
    const exact = EvaluateFixtureCorpus(snapshot, FamilyRoot, () => [issue("A_CODE"), issue("Z_CODE"), issue("A_CODE")])
    const wrongCode = EvaluateFixtureCorpus(snapshot, FamilyRoot, () => [issue("A_CODE"), issue("B_CODE"), issue("A_CODE")])
    const wrongCount = EvaluateFixtureCorpus(snapshot, FamilyRoot, () => [issue("A_CODE"), issue("Z_CODE")])

    expect(exact.SubjectsExpected).toBe(1)
    expect(exact.SubjectsChecked).toBe(1)
    expect(exact.Checks).toEqual([expect.objectContaining({ id: "FIXTURE_CASE_MATCH", status: "pass" })])
    expect(FailureIds(wrongCode.Checks)).toEqual(["FIXTURE_INVENTORY_MISMATCH"])
    expect(FailureIds(wrongCount.Checks)).toEqual(["FIXTURE_INVENTORY_MISMATCH"])

    const invalidIssue = EvaluateFixtureCorpus(snapshot, FamilyRoot, () => [
      {} as unknown as TestIssue
    ])
    const thrown = EvaluateFixtureCorpus(snapshot, FamilyRoot, () => {
      throw new Error("validator failed")
    })
    const expectedThrowSentinel = EvaluateFixtureCorpus(Snapshot({
      [CasesPath]: Cases([Case("throw", "invalid/throw", ["FIXTURE_VALIDATOR_THROW"])]),
      [`${FamilyRoot}/invalid/throw/payload.json`]: "{}\n"
    }), FamilyRoot, () => {
      throw new Error("validator failed")
    })
    const expectedInvalidSentinel = EvaluateFixtureCorpus(Snapshot({
      [CasesPath]: Cases([Case("invalid", "invalid/result", ["FIXTURE_VALIDATOR_INVALID"])]),
      [`${FamilyRoot}/invalid/result/payload.json`]: "{}\n"
    }), FamilyRoot, (() => null) as unknown as () => readonly TestIssue[])
    expect(FailureIds(invalidIssue.Checks)).toEqual(["FIXTURE_INVENTORY_MISMATCH"])
    expect(FailureIds(thrown.Checks)).toEqual(["FIXTURE_INVENTORY_MISMATCH"])
    expect(FailureIds(expectedThrowSentinel.Checks)).toEqual(["FIXTURE_INVENTORY_MISMATCH"])
    expect(FailureIds(expectedInvalidSentinel.Checks)).toEqual(["FIXTURE_INVENTORY_MISMATCH"])
  })

  test("supports a listed file root and rejects shared-path collisions after rebasing", async () => {
    const { EvaluateFixtureCorpus } = await LoadCorpus()
    let observedPaths: readonly string[] = []
    const fileRoot = EvaluateFixtureCorpus(Snapshot({
      [CasesPath]: Cases([Case("single", "valid/single.json")]),
      [`${FamilyRoot}/valid/single.json`]: "{}\n"
    }), FamilyRoot, (files) => {
      observedPaths = files.map((file) => file.Path)
      return []
    })
    const collision = EvaluateFixtureCorpus(Snapshot({
      [CasesPath]: Cases([Case("collision", "valid/collision")]),
      [`${FamilyRoot}/valid/collision/shared.json`]: "{}\n",
      "shared.json": "{}\n"
    }), FamilyRoot, () => [])

    expect(observedPaths).toEqual(["single.json"])
    expect(fileRoot.Checks).toEqual([expect.objectContaining({ id: "FIXTURE_CASE_MATCH", status: "pass" })])
    expect(FailureIds(collision.Checks)).toEqual(["FIXTURE_INVENTORY_MISMATCH"])
  })

  test("traverses the exact committed positive and negative corpus from listed snapshot bytes only", async () => {
    const { EvaluateFixtureCorpus } = await LoadCorpus()
    const { ValidateOfficialPackage } = await LoadManifestValidator()
    const paths = [
      "schemas/capability-manifest.schema.json",
      "schemas/owner-manifest.schema.json",
      "config/runtime-matrix.json",
      ...await FilesBelow(join(RepositoryRoot, FamilyRoot)).then((items) => items.map((path) => `${FamilyRoot}/${path}`))
    ]
    const entries = await Promise.all(paths.map(async (path) => [path, await readFile(join(RepositoryRoot, path), "utf8")] as const))
    const evaluation = EvaluateFixtureCorpus(Snapshot(Object.fromEntries(entries)), FamilyRoot, ValidateOfficialPackage)
    const expected = (JSON.parse(await readFile(join(RepositoryRoot, CasesPath), "utf8")) as { cases: unknown[] }).cases.length

    expect(evaluation.SubjectsExpected).toBe(expected)
    expect(evaluation.SubjectsChecked).toBe(expected)
    expect(expected).toBeGreaterThan(0)
    expect(evaluation.Checks).toHaveLength(expected)
    expect(evaluation.Checks.every((check) => check.id === "FIXTURE_CASE_MATCH" && check.status === "pass")).toBe(true)
  })
})
