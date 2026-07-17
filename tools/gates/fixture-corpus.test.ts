import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"
import type { InputSnapshot, SnapshotFile } from "./result.ts"

interface TestIssue {
  readonly Code: string
  readonly Path: string
  readonly Message: string
}

const RepositoryRoot = join(import.meta.dir, "../..")
const FamilyRoot = "tools/manifests/fixtures"
const CasesPath = `${FamilyRoot}/cases.json`
const StructuralServerRoot = `${FamilyRoot}/application-owned/structural-server/examples/custom-server`
const TemporaryRoots: string[] = []
const Utf8 = new TextDecoder()

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

function Issue(Code: string): TestIssue {
  return { Code, Path: "payload.json", Message: Code }
}

function PayloadText(files: readonly SnapshotFile[]): string {
  const payload = files.find((file) => file.Path === "payload.json")
  if (payload === undefined) throw new Error("missing rebased payload.json")
  return Utf8.decode(payload.Bytes)
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
    expect(payloads).toContain(
      "application-owned/structural-server/examples/custom-server/contract-consumer.ts"
    )
  })

  test("binds the application-owned Server fixture to the frozen structural contract with TypeScript 7", async () => {
    const compiler = join(RepositoryRoot, "node_modules/.bin/tsc")
    const version = Bun.spawn([compiler, "--version"], { stdout: "pipe", stderr: "pipe" })
    const [versionExit, versionStdout, versionStderr] = await Promise.all([
      version.exited,
      new Response(version.stdout).text(),
      new Response(version.stderr).text()
    ])
    expect({ exitCode: versionExit, stdout: versionStdout.trim(), stderr: versionStderr }).toEqual({
      exitCode: 0,
      stdout: "Version 7.0.2",
      stderr: ""
    })

    const root = await mkdtemp(join(tmpdir(), "likego-structural-server-tsc-"))
    TemporaryRoots.push(root)
    const consumer = join(RepositoryRoot, StructuralServerRoot, "contract-consumer.ts")
    const config = join(root, "tsconfig.json")
    await Bun.write(config, `${JSON.stringify({
      compilerOptions: {
        target: "ES2023",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        lib: ["ES2023", "DOM", "DOM.Iterable"],
        types: [],
        strict: true,
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
        noImplicitOverride: true,
        noFallthroughCasesInSwitch: true,
        useUnknownInCatchVariables: true,
        verbatimModuleSyntax: true,
        isolatedModules: true,
        forceConsistentCasingInFileNames: true,
        skipLibCheck: false,
        allowImportingTsExtensions: true,
        noEmit: true
      },
      files: [consumer]
    }, null, 2)}\n`)

    const compilation = Bun.spawn([compiler, "-p", config, "--pretty", "false"], {
      stdout: "pipe",
      stderr: "pipe"
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      compilation.exited,
      new Response(compilation.stdout).text(),
      new Response(compilation.stderr).text()
    ])
    expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: "", stderr: "" })
  })

  test("runs the application-owned ServerHandle lifecycle through its Context-first methods", async () => {
    const module = await import(pathToFileURL(join(RepositoryRoot, StructuralServerRoot, "server.ts")).href)
    const context = {
      Deadline: (): readonly [Date, boolean] => [new Date(0), false],
      Done: (): AbortSignal | null => null,
      Err: (): Error | null => null,
      Value: (_key: unknown): unknown => undefined
    }
    const handle = await module.Server.Start(context)
    const done = handle.Done()
    let settled = false
    void done.then(() => { settled = true })

    expect(handle.Done()).toBe(done)
    await Promise.resolve()
    expect(settled).toBe(false)
    await handle.Stop(context)
    await done
    expect(settled).toBe(true)
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

  test("fails closed when an async validator is passed to the synchronous API", async () => {
    const { EvaluateFixtureCorpus } = await LoadCorpus()
    const evaluation = EvaluateFixtureCorpus(Snapshot({
      [CasesPath]: Cases([Case("sync-only", "valid/sync-only")]),
      [`${FamilyRoot}/valid/sync-only/payload.json`]: "sync-only"
    }), FamilyRoot, (async () => []) as unknown as () => readonly TestIssue[])

    expect(evaluation.SubjectsChecked).toBe(1)
    expect(evaluation.Checks).toEqual([
      expect.objectContaining({
        id: "FIXTURE_INVENTORY_MISMATCH",
        status: "fail",
        path: "valid/sync-only",
        actual: "[\"FIXTURE_VALIDATOR_INVALID\"]"
      })
    ])
  })

  test("observes a rejected async validator so an isolated Bun process exits naturally", async () => {
    const moduleUrl = pathToFileURL(join(RepositoryRoot, "tools/gates/fixture-corpus.ts")).href
    const source = `
const { EvaluateFixtureCorpus } = await import(${JSON.stringify(moduleUrl)})
const encoder = new TextEncoder()
const familyRoot = ${JSON.stringify(FamilyRoot)}
const casesPath = familyRoot + "/cases.json"
const makeFile = (Path, text) => {
  const Bytes = encoder.encode(text)
  return { Path, RealPath: "/virtual/" + Path, Sha256: "0".repeat(64), Bytes }
}
const snapshot = {
  Sha256: "1".repeat(64),
  Files: [
    makeFile(casesPath, ${JSON.stringify(Cases([Case("rejecting", "valid/rejecting")]))}),
    makeFile(familyRoot + "/valid/rejecting/payload.json", "rejecting")
  ]
}
const evaluation = EvaluateFixtureCorpus(snapshot, familyRoot, async () => {
  throw new Error("late validator rejection")
})
if (
  evaluation.SubjectsChecked !== 1
  || evaluation.Checks[0]?.id !== "FIXTURE_INVENTORY_MISMATCH"
  || evaluation.Checks[0]?.actual !== "[\\\"FIXTURE_VALIDATOR_INVALID\\\"]"
) {
  throw new Error("sync evaluation contract changed")
}
await Bun.sleep(20)
process.stdout.write("SYNC_VALIDATOR_REJECTION_OBSERVED\\n")
`
    const child = Bun.spawn([process.execPath, "--eval", source], {
      cwd: RepositoryRoot,
      stdout: "pipe",
      stderr: "pipe"
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text()
    ])

    expect({ exitCode, stdout, stderr }).toEqual({
      exitCode: 0,
      stdout: "SYNC_VALIDATOR_REJECTION_OBSERVED\n",
      stderr: ""
    })
  })

  test("keeps hostile thenables invalid while observing getter and call failures", async () => {
    const { EvaluateFixtureCorpus } = await LoadCorpus()
    const snapshot = Snapshot({
      [CasesPath]: Cases([Case("thenable", "valid/thenable")]),
      [`${FamilyRoot}/valid/thenable/payload.json`]: "thenable"
    })
    let getterReads = 0
    const hostileGetter = Object.defineProperty({}, "then", {
      get(): never {
        getterReads += 1
        throw new Error("hostile then getter")
      }
    })
    let thenCalls = 0
    const hostileCall = {
      then(): never {
        thenCalls += 1
        throw new Error("hostile then call")
      }
    }
    const evaluations = [hostileGetter, hostileCall].map((value) => EvaluateFixtureCorpus(
      snapshot,
      FamilyRoot,
      (() => value) as unknown as () => readonly TestIssue[]
    ))

    expect(evaluations.map((evaluation) => evaluation.Checks[0])).toEqual([
      expect.objectContaining({
        id: "FIXTURE_INVENTORY_MISMATCH",
        actual: "[\"FIXTURE_VALIDATOR_INVALID\"]"
      }),
      expect.objectContaining({
        id: "FIXTURE_INVENTORY_MISMATCH",
        actual: "[\"FIXTURE_VALIDATOR_INVALID\"]"
      })
    ])
    await Bun.sleep(0)
    expect({ getterReads, thenCalls }).toEqual({ getterReads: 1, thenCalls: 1 })
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

describe("EvaluateAsyncFixtureCorpus", () => {
  test("awaits delayed validators strictly in listed case order", async () => {
    const { EvaluateAsyncFixtureCorpus } = await LoadCorpus()
    const events: string[] = []
    const evaluation = await EvaluateAsyncFixtureCorpus(Snapshot({
      [CasesPath]: Cases([
        Case("first", "z-first"),
        Case("second", "a-second")
      ]),
      [`${FamilyRoot}/z-first/payload.json`]: "first",
      [`${FamilyRoot}/a-second/payload.json`]: "second"
    }), FamilyRoot, async (files: readonly SnapshotFile[]) => {
      const label = PayloadText(files)
      events.push(`start-${label}`)
      if (label === "first") await Bun.sleep(20)
      events.push(`end-${label}`)
      return []
    })

    expect(events).toEqual(["start-first", "end-first", "start-second", "end-second"])
    expect(evaluation.SubjectsChecked).toBe(2)
    expect(evaluation.Checks.map((check) => [check.path, check.status])).toEqual([
      ["z-first", "pass"],
      ["a-second", "pass"]
    ])
  })

  test("continues after a rejected validator and cannot whitelist its fatal sentinel", async () => {
    const { EvaluateAsyncFixtureCorpus } = await LoadCorpus()
    const calls: string[] = []
    const evaluation = await EvaluateAsyncFixtureCorpus(Snapshot({
      [CasesPath]: Cases([
        Case("throwing", "z-throwing", ["FIXTURE_VALIDATOR_THROW"]),
        Case("later", "a-later")
      ]),
      [`${FamilyRoot}/z-throwing/payload.json`]: "throwing",
      [`${FamilyRoot}/a-later/payload.json`]: "later"
    }), FamilyRoot, async (files: readonly SnapshotFile[]) => {
      const label = PayloadText(files)
      calls.push(label)
      if (label === "throwing") throw new Error("validator rejected")
      return []
    })

    expect(calls).toEqual(["throwing", "later"])
    expect(evaluation.SubjectsChecked).toBe(2)
    expect(evaluation.Checks).toEqual([
      expect.objectContaining({
        id: "FIXTURE_INVENTORY_MISMATCH",
        path: "z-throwing",
        expected: "[\"FIXTURE_VALIDATOR_THROW\"]",
        actual: "[\"FIXTURE_VALIDATOR_THROW\"]"
      }),
      expect.objectContaining({ id: "FIXTURE_CASE_MATCH", path: "a-later" })
    ])
  })

  test("continues after non-array and malformed results and cannot whitelist the invalid sentinel", async () => {
    const { EvaluateAsyncFixtureCorpus } = await LoadCorpus()
    const calls: string[] = []
    const validate = async (files: readonly SnapshotFile[]): Promise<readonly TestIssue[] | null | readonly unknown[]> => {
      const label = PayloadText(files)
      calls.push(label)
      if (label === "non-array") return null
      if (label === "malformed") return [{}]
      return []
    }
    const evaluation = await EvaluateAsyncFixtureCorpus(Snapshot({
      [CasesPath]: Cases([
        Case("non-array", "z-non-array", ["FIXTURE_VALIDATOR_INVALID"]),
        Case("malformed", "m-malformed", ["FIXTURE_VALIDATOR_INVALID"]),
        Case("later", "a-later")
      ]),
      [`${FamilyRoot}/z-non-array/payload.json`]: "non-array",
      [`${FamilyRoot}/m-malformed/payload.json`]: "malformed",
      [`${FamilyRoot}/a-later/payload.json`]: "later"
    }), FamilyRoot, validate as unknown as (
      files: readonly SnapshotFile[]
    ) => Promise<readonly TestIssue[]>)

    expect(calls).toEqual(["non-array", "malformed", "later"])
    expect(evaluation.SubjectsChecked).toBe(3)
    expect(evaluation.Checks).toEqual([
      expect.objectContaining({
        id: "FIXTURE_INVENTORY_MISMATCH",
        path: "z-non-array",
        actual: "[\"FIXTURE_VALIDATOR_INVALID\"]"
      }),
      expect.objectContaining({
        id: "FIXTURE_INVENTORY_MISMATCH",
        path: "m-malformed",
        actual: "[\"FIXTURE_VALIDATOR_INVALID\"]"
      }),
      expect.objectContaining({ id: "FIXTURE_CASE_MATCH", path: "a-later" })
    ])
  })

  test("classifies a throwing issue getter from a resolved async validator as invalid", async () => {
    const { EvaluateAsyncFixtureCorpus } = await LoadCorpus()
    let getterReads = 0
    const malformed = Object.defineProperty({}, "Code", {
      get(): never {
        getterReads += 1
        throw new Error("resolved issue Code getter failed")
      }
    })
    const evaluation = await EvaluateAsyncFixtureCorpus(Snapshot({
      [CasesPath]: Cases([Case("malformed-getter", "valid/malformed-getter")]),
      [`${FamilyRoot}/valid/malformed-getter/payload.json`]: "malformed-getter"
    }), FamilyRoot, async () => [malformed] as unknown as readonly TestIssue[])

    expect(getterReads).toBe(1)
    expect(evaluation).toEqual({
      SubjectsExpected: 1,
      SubjectsChecked: 1,
      Checks: [expect.objectContaining({
        id: "FIXTURE_INVENTORY_MISMATCH",
        status: "fail",
        path: "valid/malformed-getter",
        expected: "[]",
        actual: "[\"FIXTURE_VALIDATOR_INVALID\"]"
      })]
    })
  })

  test("compares duplicate async issue codes as an exact sorted multiset", async () => {
    const { EvaluateAsyncFixtureCorpus } = await LoadCorpus()
    const evaluation = await EvaluateAsyncFixtureCorpus(Snapshot({
      [CasesPath]: Cases([
        Case("exact", "z-exact", ["Z_CODE", "A_CODE", "A_CODE"]),
        Case("missing", "a-missing", ["Z_CODE", "A_CODE", "A_CODE"])
      ]),
      [`${FamilyRoot}/z-exact/payload.json`]: "exact",
      [`${FamilyRoot}/a-missing/payload.json`]: "missing"
    }), FamilyRoot, async (files: readonly SnapshotFile[]) => (
      PayloadText(files) === "exact"
        ? [Issue("Z_CODE"), Issue("A_CODE"), Issue("A_CODE")]
        : [Issue("Z_CODE"), Issue("A_CODE")]
    ))

    expect(evaluation.SubjectsChecked).toBe(2)
    expect(evaluation.Checks).toEqual([
      expect.objectContaining({
        id: "FIXTURE_CASE_MATCH",
        path: "z-exact",
        actual: "[\"A_CODE\",\"A_CODE\",\"Z_CODE\"]"
      }),
      expect.objectContaining({
        id: "FIXTURE_INVENTORY_MISMATCH",
        path: "a-missing",
        actual: "[\"A_CODE\",\"Z_CODE\"]"
      })
    ])
  })

  test("keeps every global admission failure at checked zero without invoking a validator", async () => {
    const { EvaluateAsyncFixtureCorpus } = await LoadCorpus()
    const valid = Snapshot({
      [CasesPath]: Cases([Case("valid", "valid/one")]),
      [`${FamilyRoot}/valid/one/payload.json`]: "valid"
    })
    const admissions = [
      { snapshot: valid, root: "" },
      { snapshot: Snapshot({ [CasesPath]: "{\n" }), root: FamilyRoot },
      {
        snapshot: Snapshot({
          [CasesPath]: Cases([Case("same", "valid/one"), Case("same", "valid/two")]),
          [`${FamilyRoot}/valid/one/payload.json`]: "one",
          [`${FamilyRoot}/valid/two/payload.json`]: "two"
        }),
        root: FamilyRoot
      },
      {
        snapshot: Snapshot({
          [CasesPath]: Cases([Case("one", "valid/same"), Case("two", "valid/same")]),
          [`${FamilyRoot}/valid/same/payload.json`]: "same"
        }),
        root: FamilyRoot
      },
      {
        snapshot: Snapshot({
          [CasesPath]: Cases([Case("one", "valid/one")]),
          [`${FamilyRoot}/valid/one/payload.json`]: "one",
          [`${FamilyRoot}/unlisted/payload.json`]: "extra"
        }),
        root: FamilyRoot
      },
      {
        snapshot: Snapshot({ [CasesPath]: Cases([Case("missing", "valid/missing")]) }),
        root: FamilyRoot
      }
    ]
    let calls = 0

    for (const admission of admissions) {
      const evaluation = await EvaluateAsyncFixtureCorpus(admission.snapshot, admission.root, async () => {
        calls += 1
        return []
      })
      expect(evaluation.SubjectsChecked).toBe(0)
      expect(FailureIds(evaluation.Checks)).toEqual(["FIXTURE_INVENTORY_MISMATCH"])
    }
    expect(calls).toBe(0)
  })

  test("keeps rebased collisions case-local and continues both sync and async evaluation", async () => {
    const { EvaluateAsyncFixtureCorpus, EvaluateFixtureCorpus } = await LoadCorpus()
    const snapshot = Snapshot({
      [CasesPath]: Cases([
        Case("collision", "z-collision"),
        Case("later", "a-later")
      ]),
      [`${FamilyRoot}/z-collision/shared.json`]: "case shared",
      [`${FamilyRoot}/a-later/payload.json`]: "later",
      "shared.json": "global shared"
    })
    const syncCalls: string[] = []
    const asyncCalls: string[] = []
    const syncEvaluation = EvaluateFixtureCorpus(snapshot, FamilyRoot, (files: readonly SnapshotFile[]) => {
      syncCalls.push(PayloadText(files))
      return []
    })
    const asyncEvaluation = await EvaluateAsyncFixtureCorpus(
      snapshot,
      FamilyRoot,
      async (files: readonly SnapshotFile[]) => {
        asyncCalls.push(PayloadText(files))
        return []
      }
    )

    expect(syncCalls).toEqual(["later"])
    expect(asyncCalls).toEqual(["later"])
    expect(syncEvaluation.SubjectsChecked).toBe(2)
    expect(asyncEvaluation).toEqual(syncEvaluation)
    expect(syncEvaluation.Checks.map((check) => ({ id: check.id, status: check.status, path: check.path }))).toEqual([
      { id: "FIXTURE_INVENTORY_MISMATCH", status: "fail", path: "z-collision" },
      { id: "FIXTURE_CASE_MATCH", status: "pass", path: "a-later" }
    ])
  })
})
