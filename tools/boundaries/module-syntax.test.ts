import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative } from "node:path"
import type { SourceFile } from "typescript/unstable/ast"
import type { AtomicWriterOperations } from "../gates/atomic-writer"
import type { CorpusEvaluation } from "../gates/fixture-corpus"
import {
  nodeAtomicWriterOperations,
  snapshotInputs,
  type InputSnapshot,
  type SnapshotFile
} from "../gates/result"
import { nodeProjectSessionOperations, withProjectSessionWithOperations } from "./project-session"
import {
  discoverModuleSyntaxFixtureInputs,
  evaluateModuleSyntaxFixtureCorpus,
  evaluateModuleSyntaxFixtureCorpusWithChecker,
  main,
  mainWithDependencies,
  type ModuleSyntaxFixtureDependencies
} from "./module-syntax.fixture.cli"
import { checkModuleSyntax, type BoundaryIssue } from "./module-syntax"

const RepositoryRoot = join(import.meta.dir, "../..")
const FamilyRoot = "tools/boundaries/fixtures/module-syntax"
const CasesPath = `${FamilyRoot}/cases.json`
const Encoder = new TextEncoder()
const TemporaryRoots: string[] = []

const ExpectedCases = [
  { id: "valid-static-internal", path: "valid/static-internal", expectedCodes: [] },
  { id: "valid-export-from-internal", path: "valid/export-from-internal", expectedCodes: [] },
  {
    id: "valid-dynamic-literal-internal",
    path: "valid/dynamic-literal-internal",
    expectedCodes: []
  },
  { id: "valid-allowed-workspace-exact", path: "valid/allowed-workspace-exact", expectedCodes: [] },
  {
    id: "invalid-dynamic-nonliteral",
    path: "invalid/dynamic-nonliteral",
    expectedCodes: ["MODULE_DYNAMIC_IMPORT_NON_LITERAL"]
  },
  {
    id: "invalid-import-equals",
    path: "invalid/import-equals",
    expectedCodes: ["MODULE_IMPORT_EQUALS_FORBIDDEN"]
  },
  {
    id: "invalid-direct-require",
    path: "invalid/direct-require",
    expectedCodes: ["MODULE_REQUIRE_FORBIDDEN"]
  },
  {
    id: "invalid-parenthesized-require",
    path: "invalid/parenthesized-require",
    expectedCodes: ["MODULE_REQUIRE_FORBIDDEN"]
  },
  {
    id: "invalid-module-require",
    path: "invalid/module-require",
    expectedCodes: ["MODULE_MODULE_REQUIRE_FORBIDDEN"]
  },
  {
    id: "invalid-schemes",
    path: "invalid/schemes",
    expectedCodes: Array.from({ length: 8 }, () => "MODULE_SPECIFIER_SCHEME_FORBIDDEN")
  },
  {
    id: "invalid-absolute-and-hash",
    path: "invalid/absolute-and-hash",
    expectedCodes: [
      "MODULE_SPECIFIER_ABSOLUTE_FORBIDDEN",
      "MODULE_SPECIFIER_ABSOLUTE_FORBIDDEN",
      "MODULE_SPECIFIER_ABSOLUTE_FORBIDDEN",
      "MODULE_SPECIFIER_HASH_FORBIDDEN"
    ]
  },
  {
    id: "invalid-relative-extension-present",
    path: "invalid/relative-extension-present",
    expectedCodes: ["MODULE_RELATIVE_EXTENSION_FORBIDDEN"]
  },
  {
    id: "invalid-relative-package-escape",
    path: "invalid/relative-package-escape",
    expectedCodes: ["MODULE_RELATIVE_PACKAGE_ESCAPE"]
  },
  {
    id: "invalid-relative-target-missing",
    path: "invalid/relative-target-missing",
    expectedCodes: ["MODULE_RELATIVE_TARGET_MISSING"]
  },
  {
    id: "invalid-disallowed-workspace",
    path: "invalid/disallowed-workspace",
    expectedCodes: ["MODULE_BARE_DEPENDENCY_DISALLOWED"]
  },
  {
    id: "invalid-disallowed-vendor",
    path: "invalid/disallowed-vendor",
    expectedCodes: ["MODULE_BARE_DEPENDENCY_DISALLOWED"]
  },
  {
    id: "invalid-disallowed-framework",
    path: "invalid/disallowed-framework",
    expectedCodes: ["MODULE_BARE_DEPENDENCY_DISALLOWED"]
  },
  {
    id: "invalid-policy-subpath-not-exact",
    path: "invalid/policy-subpath-not-exact",
    expectedCodes: ["MODULE_BARE_DEPENDENCY_DISALLOWED"]
  },
  {
    id: "invalid-type-only-policy",
    path: "invalid/type-only-policy",
    expectedCodes: ["MODULE_BARE_DEPENDENCY_DISALLOWED", "MODULE_BARE_DEPENDENCY_DISALLOWED"]
  },
  {
    id: "invalid-import-type-policy",
    path: "invalid/import-type-policy",
    expectedCodes: ["MODULE_BARE_DEPENDENCY_DISALLOWED"]
  }
] as const

const TargetCases = new Set([
  "valid/static-internal",
  "valid/export-from-internal",
  "valid/dynamic-literal-internal"
])

afterEach(async () => {
  await Promise.all(
    TemporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

function Sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

function CompareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function FileBytes(Path: string, Bytes: Uint8Array): SnapshotFile {
  return { Path, RealPath: `/snapshotted/${Path}`, Sha256: Sha256(Bytes), Bytes }
}

function File(Path: string, text: string): SnapshotFile {
  return FileBytes(Path, Encoder.encode(text))
}

function SnapshotFiles(files: readonly SnapshotFile[]): InputSnapshot {
  const Files = [...files].sort((left, right) => CompareCodeUnits(left.Path, right.Path))
  return {
    Sha256: Sha256(Files.map((file) => `${file.Path}\0${file.Sha256}\n`).join("")),
    Files
  }
}

function IsRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function RepositoryFixture(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  TemporaryRoots.push(root)
  return root
}

async function FilesBelow(root: string): Promise<readonly string[]> {
  const paths: string[] = []
  async function Visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) await Visit(absolute)
      else if (entry.isFile()) paths.push(relative(root, absolute).split("\\").join("/"))
      else throw new Error("inventory entry must be a regular file or directory")
    }
  }
  await Visit(root)
  return paths.sort(CompareCodeUnits)
}

async function CopyCorpus(root: string): Promise<void> {
  for (const path of await FilesBelow(join(RepositoryRoot, FamilyRoot))) {
    await Bun.write(
      join(root, FamilyRoot, path),
      new Uint8Array(await readFile(join(RepositoryRoot, FamilyRoot, path)))
    )
  }
}

function OneCaseSnapshot(
  policy: Uint8Array | null,
  extras: readonly SnapshotFile[] = []
): InputSnapshot {
  const path = "valid/snapshot-only"
  return SnapshotFiles([
    File(
      CasesPath,
      `${JSON.stringify({
        schemaVersion: 1,
        cases: [{ id: "snapshot-only", path, expectedCodes: [] }]
      })}\n`
    ),
    ...(policy === null ? [] : [FileBytes(`${FamilyRoot}/${path}/policy.json`, policy)]),
    File(
      `${FamilyRoot}/${path}/project/tsconfig.json`,
      '{\n  "compilerOptions": { "strict": true, "noEmit": true, "target": "ES2022", "module": "ESNext" },\n  "include": ["src/**/*.ts"]\n}\n'
    ),
    File(`${FamilyRoot}/${path}/project/src/index.ts`, "export const value = 1\n"),
    ...extras
  ])
}

async function CheckProject(
  source: string,
  allowed: readonly string[],
  extraSources: Readonly<Record<string, string>> = {}
): Promise<readonly BoundaryIssue[]> {
  const root = await RepositoryFixture("likego-module-syntax-project-")
  const files = [
    File(
      "project/tsconfig.json",
      '{\n  "compilerOptions": { "strict": true, "noEmit": true, "target": "ES2022", "module": "ESNext" },\n  "include": ["src/**/*.ts"]\n}\n'
    ),
    File("project/src/index.ts", source),
    ...Object.entries(extraSources).map(([path, text]) => File(`project/src/${path}`, text))
  ]
  return withProjectSessionWithOperations(
    SnapshotFiles(files),
    "project",
    async (session) =>
      checkModuleSyntax(session.SourceFiles, {
        PackageRoot: join(session.StagedRoot, "project"),
        AllowedWorkspaceDependencies: allowed
      }),
    nodeProjectSessionOperations(root)
  )
}

async function SpawnCli(
  root: string,
  runId: string
): Promise<{
  readonly exitCode: number
  readonly signalCode: unknown
  readonly stdout: string
  readonly stderr: string
}> {
  const child = Bun.spawn(
    [
      process.execPath,
      join(RepositoryRoot, "tools/boundaries/module-syntax.fixture.cli.ts"),
      "--root",
      root,
      "--run-id",
      runId
    ],
    {
      cwd: RepositoryRoot,
      stdout: "pipe",
      stderr: "pipe"
    }
  )
  const stdoutPromise = new Response(child.stdout).text()
  const stderrPromise = new Response(child.stderr).text()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<"timeout">((resolveTimeout) => {
    timer = setTimeout(() => {
      resolveTimeout("timeout")
    }, 30_000)
  })
  const completed = await Promise.race([child.exited.then((exitCode) => ({ exitCode })), timeout])
  if (completed === "timeout") {
    child.kill("SIGKILL")
    const exitCode = await child.exited
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])
    throw new Error(`module-syntax fixture timed out with ${exitCode}: ${stdout}${stderr}`)
  }
  if (timer !== undefined) clearTimeout(timer)
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])
  return { exitCode: completed.exitCode, signalCode: child.signalCode, stdout, stderr }
}

async function SpawnWithClosedStdout(
  root: string,
  runId: string
): Promise<{
  readonly exitCode: number
  readonly signalCode: unknown
  readonly stdout: string
  readonly stderr: string
}> {
  const child = Bun.spawn(
    [
      "bash",
      "-c",
      'set -o pipefail; "$@" | true',
      "likego-module-syntax-closed-stdout",
      process.execPath,
      join(RepositoryRoot, "tools/boundaries/module-syntax.fixture.cli.ts"),
      "--root",
      root,
      "--run-id",
      runId
    ],
    {
      cwd: RepositoryRoot,
      stdout: "pipe",
      stderr: "pipe"
    }
  )
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ])
  return { exitCode, signalCode: child.signalCode, stdout, stderr }
}

function PassingEvaluation(): CorpusEvaluation {
  return {
    SubjectsExpected: 20,
    SubjectsChecked: 20,
    Checks: [{ id: "INJECTED_PASS", status: "pass" }]
  }
}

function QuickDependencies(
  inputPath: string,
  atomic: AtomicWriterOperations = nodeAtomicWriterOperations()
): ModuleSyntaxFixtureDependencies {
  return {
    DiscoverInputPaths: async () => [inputPath],
    Evaluate: async () => PassingEvaluation(),
    AtomicWriterOperations: atomic
  }
}

describe("Task5 portable module-syntax boundary", () => {
  test("locks the exact ordered twenty-case corpus, policies and complete file inventory", async () => {
    const document: unknown = JSON.parse(await readFile(join(RepositoryRoot, CasesPath), "utf8"))
    expect(IsRecord(document) && Object.keys(document)).toEqual(["schemaVersion", "cases"])
    expect(document).toEqual({ schemaVersion: 1, cases: ExpectedCases })

    const expectedFiles = [
      "cases.json",
      ...ExpectedCases.flatMap((fixtureCase) => [
        `${fixtureCase.path}/policy.json`,
        fixtureCase.path === "invalid/relative-extension-present"
          ? `${fixtureCase.path}/project/src/index.source`
          : `${fixtureCase.path}/project/src/index.ts`,
        ...(TargetCases.has(fixtureCase.path) ? [`${fixtureCase.path}/project/src/value.ts`] : []),
        `${fixtureCase.path}/project/tsconfig.json`
      ])
    ].sort(CompareCodeUnits)
    const files = await FilesBelow(join(RepositoryRoot, FamilyRoot))
    expect(files).toEqual(expectedFiles)
    expect(
      files.some((path) =>
        [".test.", "_test_", ".spec.", "_spec_"].some((part) => path.includes(part))
      )
    ).toBe(false)

    for (const fixtureCase of ExpectedCases) {
      const policy: unknown = JSON.parse(
        await readFile(join(RepositoryRoot, FamilyRoot, fixtureCase.path, "policy.json"), "utf8")
      )
      expect(IsRecord(policy) && Object.keys(policy)).toEqual([
        "schemaVersion",
        "allowedWorkspaceDependencies"
      ])
      const allowsContext =
        fixtureCase.path === "valid/allowed-workspace-exact" ||
        fixtureCase.path === "invalid/policy-subpath-not-exact"
      expect(policy).toEqual({
        schemaVersion: 1,
        allowedWorkspaceDependencies: allowsContext ? ["@likego/context"] : []
      })
    }
  })

  test("evaluates all twenty exact code multisets with real TS7 from immutable snapshot bytes", async () => {
    const root = await RepositoryFixture("likego-module-syntax-corpus-")
    await CopyCorpus(root)
    const discovered = await discoverModuleSyntaxFixtureInputs(root)
    expect(discovered).toEqual(
      (await FilesBelow(join(root, FamilyRoot)))
        .map((path) => `${FamilyRoot}/${path}`)
        .sort(CompareCodeUnits)
    )
    const snapshotted = await snapshotInputs(root, discovered)
    expect(snapshotted.Checks).toEqual([])
    if (snapshotted.Snapshot === null) throw new Error("module-syntax corpus must snapshot")
    const before = snapshotted.Snapshot.Files.map((file) => ({
      file,
      bytes: new Uint8Array(file.Bytes),
      sha256: file.Sha256
    }))

    await Bun.write(
      join(root, FamilyRoot, "valid/static-internal/project/src/index.ts"),
      'import "node:fs"\n'
    )
    await Bun.write(
      join(root, FamilyRoot, "valid/static-internal/policy.json"),
      "not the snapshotted policy\n"
    )
    const evaluation = await evaluateModuleSyntaxFixtureCorpus(snapshotted.Snapshot, root)
    expect(evaluation.SubjectsExpected).toBe(20)
    expect(evaluation.SubjectsChecked).toBe(20)
    expect(evaluation.Checks.map((check) => [check.id, check.status, check.path])).toEqual(
      ExpectedCases.map((fixtureCase) => ["FIXTURE_CASE_MATCH", "pass", fixtureCase.path])
    )
    for (const item of before) {
      expect(item.file.Bytes).toBe(
        snapshotted.Snapshot.Files.find((file) => file.Path === item.file.Path)!.Bytes
      )
      expect(item.file.Sha256).toBe(item.sha256)
      expect(Array.from(item.file.Bytes)).toEqual(Array.from(item.bytes))
    }
    expect(await readdir(join(root, ".artifacts/gates/work"))).toEqual([])

    const singleRoot = await RepositoryFixture("likego-module-syntax-real-ast-")
    const single = OneCaseSnapshot(
      Encoder.encode(
        JSON.stringify({
          schemaVersion: 1,
          allowedWorkspaceDependencies: []
        })
      )
    )
    let observed: readonly SourceFile[] | null = null
    const singleEvaluation = await evaluateModuleSyntaxFixtureCorpusWithChecker(
      single,
      singleRoot,
      (sourceFiles, policy) => {
        observed = sourceFiles
        expect(isAbsolute(policy.PackageRoot)).toBe(true)
        expect(policy.PackageRoot.endsWith("/project")).toBe(true)
        expect(policy.AllowedWorkspaceDependencies).toEqual([])
        return checkModuleSyntax(sourceFiles, policy)
      }
    )
    expect(singleEvaluation.Checks).toEqual([
      expect.objectContaining({
        id: "FIXTURE_CASE_MATCH",
        status: "pass",
        path: "valid/snapshot-only"
      })
    ])
    const sourceFiles = observed as readonly SourceFile[] | null
    if (sourceFiles === null) throw new Error("real TS7 callback must run")
    expect(sourceFiles).toHaveLength(1)
    expect(typeof sourceFiles[0]!.forEachChild).toBe("function")
    expect(sourceFiles[0]!.fileName.endsWith("/project/src/index.ts")).toBe(true)
  }, 60_000)

  test("uses AST nodes for exact dynamic arity, templates, backslash relatives and stable issue ordering", async () => {
    const source = [
      'import type { Context } from "@likego/context"',
      'import { value } from "./value"',
      'export { value } from "./value"',
      "export {}",
      'type Internal = import("./value").Value',
      'const literal = import("./value")',
      'const specifier = "./value"',
      "const variable = import(specifier)",
      "const template = import(`./value`)",
      'const options = import("./value", {})',
      "const ordinary = Math.max(1, 2)",
      'const element = module["require"]("vendor-package")',
      'const receiver = (module).require("vendor-package")',
      'import Legacy = require("node:fs")',
      'import ".\\\\value.js"',
      "export { Context, Internal, literal, variable, template, options, ordinary, element, receiver, Legacy }",
      ""
    ].join("\n")
    const issues = await CheckProject(source, ["@likego/context"], {
      "value.ts": "export interface Value {}\nexport const value = 1\n"
    })
    expect(issues.map((issue) => issue.Code)).toEqual([
      "MODULE_DYNAMIC_IMPORT_NON_LITERAL",
      "MODULE_DYNAMIC_IMPORT_NON_LITERAL",
      "MODULE_DYNAMIC_IMPORT_NON_LITERAL",
      "MODULE_IMPORT_EQUALS_FORBIDDEN",
      "MODULE_MODULE_REQUIRE_FORBIDDEN",
      "MODULE_RELATIVE_EXTENSION_FORBIDDEN"
    ])
    expect(issues.every((issue) => issue.Path === "src/index.ts")).toBe(true)
    expect(issues).toEqual(
      [...issues].sort(
        (left, right) =>
          CompareCodeUnits(left.Code, right.Code) ||
          CompareCodeUnits(left.Path, right.Path) ||
          CompareCodeUnits(left.Message, right.Message)
      )
    )
  })

  test("accepts only extensionless internal TypeScript specifiers", async () => {
    const sources = { "value.ts": "export const value = 1\n" }
    expect(
      await CheckProject('import { value } from "./value"; void value\n', [], sources)
    ).toEqual([])
    expect(
      (await CheckProject('import { value } from "./value.js"; void value\n', [], sources)).map(
        (issue) => issue.Code
      )
    ).toEqual(["MODULE_RELATIVE_EXTENSION_FORBIDDEN"])
    expect(
      (await CheckProject('import type { value } from "./value.ts"\n', [], sources)).map(
        (issue) => issue.Code
      )
    ).toEqual(["MODULE_RELATIVE_EXTENSION_FORBIDDEN"])
  })

  test("fails closed before traversal when package or source paths violate canonical src admission", async () => {
    const root = await RepositoryFixture("likego-module-syntax-path-admission-")
    const snapshot = SnapshotFiles([
      File(
        "project/tsconfig.json",
        '{\n  "compilerOptions": { "strict": true, "noEmit": true, "target": "ES2022", "module": "ESNext" },\n  "include": ["src/**/*.ts"]\n}\n'
      ),
      File("project/src/index.ts", "export const value = 1\n")
    ])
    await withProjectSessionWithOperations(
      snapshot,
      "project",
      async (session) => {
        const packageRoot = join(session.StagedRoot, "project")
        expect(
          checkModuleSyntax(session.SourceFiles, {
            PackageRoot: packageRoot,
            AllowedWorkspaceDependencies: []
          })
        ).toEqual([])

        const messages: string[] = []
        function Capture(run: () => unknown): void {
          try {
            run()
            throw new Error("invalid module-syntax path admission unexpectedly passed")
          } catch (error) {
            if (!(error instanceof Error)) throw error
            messages.push(error.message)
          }
        }
        Capture(() =>
          checkModuleSyntax(session.SourceFiles, {
            PackageRoot: "project",
            AllowedWorkspaceDependencies: []
          })
        )
        Capture(() =>
          checkModuleSyntax(session.SourceFiles, {
            PackageRoot: `${packageRoot}/.`,
            AllowedWorkspaceDependencies: []
          })
        )

        const realSource = session.SourceFiles[0]!
        for (const fileName of [
          "project/src/index.ts",
          `${packageRoot}/src/../src/index.ts`,
          join(session.StagedRoot, "outside.ts")
        ]) {
          const hostile = Object.create(realSource) as SourceFile
          Object.defineProperty(hostile, "fileName", { value: fileName })
          Capture(() =>
            checkModuleSyntax([hostile], {
              PackageRoot: packageRoot,
              AllowedWorkspaceDependencies: []
            })
          )
        }
        expect(messages).toEqual([
          "module syntax package root must be an absolute canonical lexical path",
          "module syntax package root must be an absolute canonical lexical path",
          "module syntax source file must be an absolute canonical lexical child of package src",
          "module syntax source file must be an absolute canonical lexical child of package src",
          "module syntax source file must be an absolute canonical lexical child of package src"
        ])
        expect(messages.some((message) => message.includes(session.StagedRoot))).toBe(false)
      },
      nodeProjectSessionOperations(root)
    )
  })

  test("fails closed on malformed policy bytes, duplicate inputs and unlisted inventory", async () => {
    const root = await RepositoryFixture("likego-module-syntax-policy-")
    const malformed = [
      new Uint8Array([0xff]),
      Encoder.encode("null\n"),
      Encoder.encode('{"schemaVersion":1,"allowedWorkspaceDependencies":[],"extra":true}\n'),
      Encoder.encode('{"schemaVersion":2,"allowedWorkspaceDependencies":[]}\n'),
      Encoder.encode('{"schemaVersion":1,"allowedWorkspaceDependencies":"@likego/context"}\n'),
      Encoder.encode('{"schemaVersion":1,"allowedWorkspaceDependencies":[""]}\n'),
      Encoder.encode(
        '{"schemaVersion":1,"allowedWorkspaceDependencies":["@likego/context","@likego/context"]}\n'
      )
    ]
    for (const policy of [null, ...malformed]) {
      const evaluation = await evaluateModuleSyntaxFixtureCorpus(OneCaseSnapshot(policy), root)
      expect(evaluation.SubjectsExpected).toBe(1)
      expect(evaluation.SubjectsChecked).toBe(1)
      expect(evaluation.Checks).toEqual([
        expect.objectContaining({
          id: "FIXTURE_INVENTORY_MISMATCH",
          status: "fail",
          actual: '["FIXTURE_VALIDATOR_THROW"]'
        })
      ])
    }

    const extra = File(`${FamilyRoot}/unlisted/extra.ts`, "export const extra = true\n")
    const inventory = await evaluateModuleSyntaxFixtureCorpus(
      SnapshotFiles([
        ...OneCaseSnapshot(
          Encoder.encode('{"schemaVersion":1,"allowedWorkspaceDependencies":[]}\n')
        ).Files,
        extra
      ]),
      root
    )
    expect(inventory.SubjectsChecked).toBe(0)
    expect(inventory.Checks).toEqual([
      expect.objectContaining({ id: "FIXTURE_INVENTORY_MISMATCH" })
    ])

    const ordinary = OneCaseSnapshot(
      Encoder.encode('{"schemaVersion":1,"allowedWorkspaceDependencies":[]}\n')
    )
    const duplicated = await evaluateModuleSyntaxFixtureCorpus(
      { Sha256: ordinary.Sha256, Files: [...ordinary.Files, ordinary.Files[0]!] },
      root
    )
    expect(duplicated.SubjectsChecked).toBe(0)
    expect(duplicated.Checks).toEqual([
      expect.objectContaining({ id: "FIXTURE_INVENTORY_MISMATCH" })
    ])
  })

  test("discovers only real sorted files and turns missing or hostile inventories into input failures", async () => {
    const symlinkRoot = await RepositoryFixture("likego-module-syntax-family-link-")
    const outside = await RepositoryFixture("likego-module-syntax-family-outside-")
    await mkdir(dirname(join(symlinkRoot, FamilyRoot)), { recursive: true })
    await symlink(outside, join(symlinkRoot, FamilyRoot))
    await expect(discoverModuleSyntaxFixtureInputs(symlinkRoot)).rejects.toThrow(
      "module-syntax fixture family must be a real directory"
    )

    const nonRegularRoot = await RepositoryFixture("likego-module-syntax-nonregular-")
    await Bun.write(join(nonRegularRoot, CasesPath), '{"schemaVersion":1,"cases":[]}\n')
    await symlink("missing-target", join(nonRegularRoot, FamilyRoot, "linked-payload.ts"))
    await expect(discoverModuleSyntaxFixtureInputs(nonRegularRoot)).rejects.toThrow(
      "module-syntax fixture inventory entries must be regular files or directories"
    )

    const missingCasesRoot = await RepositoryFixture("likego-module-syntax-missing-cases-")
    await Bun.write(join(missingCasesRoot, FamilyRoot, "payload.ts"), "export const value = 1\n")
    expect(await discoverModuleSyntaxFixtureInputs(missingCasesRoot)).toEqual([
      CasesPath,
      `${FamilyRoot}/payload.ts`
    ])

    const stdout: string[] = []
    expect(
      await main(["--root", symlinkRoot, "--run-id", "task5-discovery-failure"], {
        WriteStdout: (value) => {
          stdout.push(value)
        },
        WriteStderr: () => {
          throw new Error("discovery failures emit a gate result")
        }
      })
    ).toBe(1)
    expect(JSON.parse(stdout[0]!.slice("LIKEGO_GATE_RESULT=".length))).toEqual(
      expect.objectContaining({
        runId: "task5-discovery-failure",
        status: "fail",
        inputsSha256: null,
        checks: [expect.objectContaining({ id: "GATE_INPUT_ERROR" })]
      })
    )
  })

  test("rejects malformed CLI usage and safely rolls back every hostile emission", async () => {
    const usageRoot = await RepositoryFixture("likego-module-syntax-usage-")
    const canonicalPath = join(usageRoot, ".artifacts/gates/boundary-module-syntax-fixtures.json")
    await mkdir(dirname(canonicalPath), { recursive: true })
    await Bun.write(canonicalPath, "prior-result\n")
    const invalid = [
      [],
      ["--root"],
      ["--run-id"],
      ["--root", usageRoot],
      ["--run-id", "valid-run"],
      ["--root", "", "--run-id", "valid-run"],
      ["--root", usageRoot, "--run-id", ""],
      ["--root", usageRoot, "--root", usageRoot, "--run-id", "valid-run"],
      ["--root", usageRoot, "--run-id", "valid-run", "--run-id", "valid-run"],
      ["--unknown", "value", "--root", usageRoot, "--run-id", "valid-run"],
      ["--root", usageRoot, "--run-id", "Uppercase"],
      ["--root", usageRoot, "--run-id", "invalid.dot"],
      ["--root", usageRoot, "--run-id", `a${"b".repeat(96)}`]
    ] as const
    for (const args of invalid) {
      const stdout: string[] = []
      const stderr: string[] = []
      expect(
        await main(args, {
          WriteStdout: (value) => {
            stdout.push(value)
          },
          WriteStderr: (value) => {
            stderr.push(value)
          }
        })
      ).toBe(1)
      expect(stdout).toEqual([])
      expect(stderr).toEqual(["MODULE_SYNTAX_FIXTURE_USAGE invalid arguments\n"])
      expect(await readFile(canonicalPath, "utf8")).toBe("prior-result\n")
    }

    const root = await RepositoryFixture("likego-module-syntax-output-")
    const inputPath = "input.txt"
    await Bun.write(join(root, inputPath), "snapshotted input\n")
    const resultPath = join(root, ".artifacts/gates/boundary-module-syntax-fixtures.json")
    await mkdir(dirname(resultPath), { recursive: true })
    await Bun.write(resultPath, "prior-result\n")

    const successStdout: string[] = []
    expect(
      await mainWithDependencies(
        ["--root", root, "--run-id", "task5-injected-pass"],
        {
          WriteStdout: (value) => {
            successStdout.push(value)
          },
          WriteStderr: () => {
            throw new Error("passing injected gate must not use stderr")
          }
        },
        QuickDependencies(inputPath)
      )
    ).toBe(0)
    expect(successStdout).toHaveLength(1)
    expect(JSON.parse(successStdout[0]!.slice("LIKEGO_GATE_RESULT=".length))).toEqual(
      expect.objectContaining({
        runId: "task5-injected-pass",
        status: "pass"
      })
    )

    const base = nodeAtomicWriterOperations()
    const failures: readonly {
      readonly id: string
      readonly thrown: unknown
      readonly expected: string
      readonly operations?: AtomicWriterOperations
    }[] = [
      {
        id: "atomic",
        thrown: null,
        expected: "injected atomic failure",
        operations: {
          ...base,
          Open: async () => {
            throw new Error("injected atomic failure")
          }
        }
      },
      { id: "literal", thrown: "literal output failure", expected: "literal output failure" },
      {
        id: "nonstring-message",
        thrown: Object.defineProperty(new Error("ignored"), "message", { value: 7 }),
        expected: "unprintable error"
      },
      {
        id: "hostile",
        thrown: Object.assign(Object.create(null) as object, {
          [Symbol.toPrimitive]: () => {
            throw new Error("cannot stringify output")
          }
        }),
        expected: "unprintable error"
      }
    ]
    for (const failure of failures) {
      await Bun.write(resultPath, "prior-result\n")
      const stdout: string[] = []
      const stderr: string[] = []
      const io = {
        WriteStdout:
          failure.operations === undefined
            ? () => {
                throw failure.thrown
              }
            : (value: string) => {
                stdout.push(value)
              },
        WriteStderr: (value: string) => {
          stderr.push(value)
        }
      }
      expect(
        await mainWithDependencies(
          ["--root", root, "--run-id", `task5-output-${failure.id}`],
          io,
          QuickDependencies(inputPath, failure.operations ?? base)
        )
      ).toBe(1)
      expect(stdout).toEqual([])
      expect(stderr).toEqual([`MODULE_SYNTAX_FIXTURE_EMIT_ERROR ${failure.expected}\n`])
      expect(await readFile(resultPath, "utf8")).toBe("prior-result\n")
      expect(
        (await readdir(dirname(resultPath))).filter(
          (name) => name.endsWith(".tmp") || name.endsWith(".lock")
        )
      ).toEqual([])
    }
  })

  test("routes default process IO through the same importable main", async () => {
    const root = await RepositoryFixture("likego-module-syntax-default-io-")
    const stdout: string[] = []
    const stderr: string[] = []
    const originalStdoutWrite = process.stdout.write
    const originalStderrWrite = process.stderr.write
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
      expect(await main([])).toBe(1)
      expect(await main(["--root", root, "--run-id", "task5-default-io"])).toBe(1)
    } finally {
      process.stdout.write = originalStdoutWrite
      process.stderr.write = originalStderrWrite
    }
    expect(stderr).toEqual(["MODULE_SYNTAX_FIXTURE_USAGE invalid arguments\n"])
    expect(stdout).toHaveLength(1)
    expect(stdout[0]!.startsWith("LIKEGO_GATE_RESULT=")).toBe(true)
  })

  test("exits naturally with exact current-run canonical evidence and rolls back a real EPIPE", async () => {
    const root = await RepositoryFixture("likego-module-syntax-child-")
    await CopyCorpus(root)
    const discovered = await discoverModuleSyntaxFixtureInputs(root)
    const expectedSnapshot = await snapshotInputs(root, discovered)
    if (expectedSnapshot.Snapshot === null) throw new Error("child corpus must snapshot")
    const child = await SpawnCli(root, "task5-real-ts7-child")
    expect(child.signalCode).toBeNull()
    expect(child.exitCode).toBe(0)
    expect(child.stderr).toBe("")
    const lines = child.stdout.split("\n")
    expect(lines).toHaveLength(2)
    expect(lines[1]).toBe("")
    expect(lines[0]!.startsWith("LIKEGO_GATE_RESULT=")).toBe(true)
    const result = JSON.parse(lines[0]!.slice("LIKEGO_GATE_RESULT=".length)) as {
      readonly schemaVersion: number
      readonly runId: string
      readonly gate: string
      readonly mode: string
      readonly status: string
      readonly releaseReadiness: string
      readonly inputsSha256: string
      readonly subjects: { readonly expected: number; readonly checked: number }
      readonly checks: readonly {
        readonly id: string
        readonly status: string
        readonly path: string
      }[]
    }
    expect(result).toEqual(
      expect.objectContaining({
        schemaVersion: 1,
        runId: "task5-real-ts7-child",
        gate: "boundary-module-syntax-fixtures",
        mode: "fixture",
        status: "pass",
        releaseReadiness: "not-evaluated",
        inputsSha256: expectedSnapshot.Snapshot.Sha256,
        subjects: { expected: 20, checked: 20 }
      })
    )
    expect(result.checks.map((check) => [check.id, check.status, check.path])).toEqual(
      ExpectedCases.map((fixtureCase) => ["FIXTURE_CASE_MATCH", "pass", fixtureCase.path])
    )
    expect(
      JSON.parse(
        await readFile(join(root, ".artifacts/gates/boundary-module-syntax-fixtures.json"), "utf8")
      )
    ).toEqual(result)
    expect(await readdir(join(root, ".artifacts/gates/work"))).toEqual([])

    const pipeRoot = await RepositoryFixture("likego-module-syntax-epipe-")
    await CopyCorpus(pipeRoot)
    const canonicalPath = join(pipeRoot, ".artifacts/gates/boundary-module-syntax-fixtures.json")
    await mkdir(dirname(canonicalPath), { recursive: true })
    await Bun.write(canonicalPath, "prior-result\n")
    const piped = await SpawnWithClosedStdout(pipeRoot, "task5-real-epipe")
    expect(piped.signalCode).toBeNull()
    expect(piped.exitCode).toBe(1)
    expect(piped.stdout).toBe("")
    expect(piped.stderr).toContain("MODULE_SYNTAX_FIXTURE_EMIT_ERROR")
    expect(piped.stderr).toContain("EPIPE")
    expect(await readFile(canonicalPath, "utf8")).toBe("prior-result\n")
    expect(
      (await readdir(dirname(canonicalPath))).filter(
        (name) => name.endsWith(".tmp") || name.endsWith(".lock")
      )
    ).toEqual([])
    expect(await readdir(join(pipeRoot, ".artifacts/gates/work"))).toEqual([])
  }, 120_000)
})
