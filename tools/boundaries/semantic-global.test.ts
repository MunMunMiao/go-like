import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import type { Project } from "typescript/unstable/async"
import type { SourceFile } from "typescript/unstable/ast"
import type { AtomicWriterOperations } from "../gates/atomic-writer.ts"
import type { CorpusEvaluation } from "../gates/fixture-corpus.ts"
import {
  NodeAtomicWriterOperations,
  SnapshotInputs,
  type InputSnapshot,
  type SnapshotFile
} from "../gates/result.ts"
import {
  NodeProjectSessionOperations,
  WithProjectSessionWithOperations
} from "./project-session.ts"
import { CheckSemanticGlobals } from "./semantic-global.ts"
import type { BoundaryIssue } from "./module-syntax.ts"

interface SemanticGlobalFixtureIO {
  readonly WriteStdout: (value: string) => void | Promise<void>
  readonly WriteStderr: (value: string) => void | Promise<void>
}

interface SemanticGlobalFixtureDependencies {
  readonly DiscoverInputPaths: (root: string) => Promise<readonly string[]>
  readonly Evaluate: (snapshot: InputSnapshot, root: string) => Promise<CorpusEvaluation>
  readonly AtomicWriterOperations: AtomicWriterOperations
}

type SemanticGlobalChecker = (
  project: Project,
  sourceFiles: readonly SourceFile[],
  policy: { readonly AllowedFreeGlobals: readonly string[] }
) => Promise<readonly BoundaryIssue[]>

interface SemanticGlobalFixtureModule extends Readonly<Record<string, unknown>> {
  readonly DiscoverSemanticGlobalFixtureInputs: (root: string) => Promise<readonly string[]>
  readonly EvaluateSemanticGlobalFixtureCorpus: (
    snapshot: InputSnapshot,
    repositoryRoot: string
  ) => Promise<CorpusEvaluation>
  readonly EvaluateSemanticGlobalFixtureCorpusWithChecker: (
    snapshot: InputSnapshot,
    repositoryRoot: string,
    check: SemanticGlobalChecker
  ) => Promise<CorpusEvaluation>
  readonly Main: (
    args: readonly string[],
    io?: SemanticGlobalFixtureIO
  ) => Promise<number>
  readonly MainWithDependencies: (
    args: readonly string[],
    io: SemanticGlobalFixtureIO,
    dependencies: SemanticGlobalFixtureDependencies
  ) => Promise<number>
}

const RepositoryRoot = join(import.meta.dir, "../..")
const FamilyRoot = "tools/boundaries/fixtures/semantic-global"
const CasesPath = FamilyRoot + "/cases.json"
const TemporaryRoots: string[] = []

const ExpectedCases = [
  { id: "valid-property-keys", path: "valid/property-keys", expectedCodes: [] },
  { id: "valid-labels", path: "valid/labels", expectedCodes: [] },
  { id: "valid-type-positions", path: "valid/type-positions", expectedCodes: [] },
  { id: "valid-local-declarations", path: "valid/local-declarations", expectedCodes: [] },
  { id: "valid-imported-declarations", path: "valid/imported-declarations", expectedCodes: [] },
  { id: "valid-allowlisted-console", path: "valid/allowlisted-console", expectedCodes: [] },
  { id: "valid-global-this-console-dot", path: "valid/global-this-console-dot", expectedCodes: [] },
  { id: "valid-global-this-console-element", path: "valid/global-this-console-element", expectedCodes: [] },
  { id: "invalid-free-bun", path: "invalid/free-bun", expectedCodes: ["GLOBAL_FREE_IDENTIFIER_FORBIDDEN"] },
  { id: "invalid-free-deno", path: "invalid/free-deno", expectedCodes: ["GLOBAL_FREE_IDENTIFIER_FORBIDDEN"] },
  { id: "invalid-free-process", path: "invalid/free-process", expectedCodes: ["GLOBAL_FREE_IDENTIFIER_FORBIDDEN"] },
  { id: "invalid-free-buffer", path: "invalid/free-buffer", expectedCodes: ["GLOBAL_FREE_IDENTIFIER_FORBIDDEN"] },
  { id: "invalid-free-global", path: "invalid/free-global", expectedCodes: ["GLOBAL_FREE_IDENTIFIER_FORBIDDEN"] },
  { id: "invalid-free-require", path: "invalid/free-require", expectedCodes: ["GLOBAL_FREE_IDENTIFIER_FORBIDDEN"] },
  { id: "invalid-free-module", path: "invalid/free-module", expectedCodes: ["GLOBAL_FREE_IDENTIFIER_FORBIDDEN"] },
  { id: "invalid-free-exports", path: "invalid/free-exports", expectedCodes: ["GLOBAL_FREE_IDENTIFIER_FORBIDDEN"] },
  { id: "invalid-free-filename", path: "invalid/free-filename", expectedCodes: ["GLOBAL_FREE_IDENTIFIER_FORBIDDEN"] },
  { id: "invalid-free-dirname", path: "invalid/free-dirname", expectedCodes: ["GLOBAL_FREE_IDENTIFIER_FORBIDDEN"] },
  { id: "invalid-unknown-global", path: "invalid/unknown-global", expectedCodes: ["GLOBAL_FREE_IDENTIFIER_FORBIDDEN"] },
  { id: "invalid-allowlisted-unresolved", path: "invalid/allowlisted-unresolved", expectedCodes: ["GLOBAL_FREE_IDENTIFIER_FORBIDDEN"] },
  { id: "invalid-unallowlisted-math", path: "invalid/unallowlisted-math", expectedCodes: ["GLOBAL_FREE_IDENTIFIER_FORBIDDEN"] },
  { id: "invalid-global-this-property", path: "invalid/global-this-property", expectedCodes: ["GLOBAL_THIS_PROPERTY_FORBIDDEN"] },
  { id: "invalid-global-this-computed", path: "invalid/global-this-computed", expectedCodes: ["GLOBAL_THIS_COMPUTED_ACCESS_FORBIDDEN"] },
  { id: "invalid-global-this-direct-alias", path: "invalid/global-this-direct-alias", expectedCodes: ["GLOBAL_THIS_ESCAPE_FORBIDDEN"] },
  { id: "invalid-global-this-chained-alias", path: "invalid/global-this-chained-alias", expectedCodes: ["GLOBAL_THIS_ESCAPE_FORBIDDEN"] },
  { id: "invalid-global-this-destructure", path: "invalid/global-this-destructure", expectedCodes: ["GLOBAL_THIS_ESCAPE_FORBIDDEN"] },
  { id: "invalid-global-this-reassignment", path: "invalid/global-this-reassignment", expectedCodes: ["GLOBAL_THIS_ESCAPE_FORBIDDEN"] },
  { id: "invalid-global-this-call-escape", path: "invalid/global-this-call-escape", expectedCodes: ["GLOBAL_THIS_ESCAPE_FORBIDDEN"] },
  { id: "invalid-global-this-return-escape", path: "invalid/global-this-return-escape", expectedCodes: ["GLOBAL_THIS_ESCAPE_FORBIDDEN"] },
  { id: "invalid-eval", path: "invalid/eval", expectedCodes: ["GLOBAL_DYNAMIC_CODE_FORBIDDEN"] },
  { id: "invalid-function-constructor", path: "invalid/function-constructor", expectedCodes: ["GLOBAL_DYNAMIC_CODE_FORBIDDEN"] },
  { id: "invalid-ambient-declaration", path: "invalid/ambient-declaration", expectedCodes: ["GLOBAL_AMBIENT_DECLARATION_FORBIDDEN"] },
  { id: "invalid-triple-slash-types", path: "invalid/triple-slash-types", expectedCodes: ["GLOBAL_TYPE_REFERENCE_DIRECTIVE_FORBIDDEN"] },
  { id: "invalid-ts-ignore", path: "invalid/ts-ignore", expectedCodes: ["GLOBAL_TYPESCRIPT_DIRECTIVE_FORBIDDEN"] },
  { id: "invalid-ts-nocheck", path: "invalid/ts-nocheck", expectedCodes: ["GLOBAL_TYPESCRIPT_DIRECTIVE_FORBIDDEN"] }
] as const

afterEach(async () => {
  await Promise.all(TemporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function CompareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function Sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

function File(Path: string, text: string): SnapshotFile {
  const Bytes = new TextEncoder().encode(text)
  return { Path, RealPath: "/snapshotted/" + Path, Sha256: Sha256(Bytes), Bytes }
}

function FileBytes(Path: string, Bytes: Uint8Array): SnapshotFile {
  return { Path, RealPath: "/snapshotted/" + Path, Sha256: Sha256(Bytes), Bytes }
}

function SnapshotFiles(files: readonly SnapshotFile[]): InputSnapshot {
  const Files = [...files].sort((left, right) => CompareCodeUnits(left.Path, right.Path))
  return {
    Sha256: Sha256(Files.map((file) => file.Path + "\0" + file.Sha256 + "\n").join("")),
    Files
  }
}

function IsRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function LoadFixtureModule(): Promise<SemanticGlobalFixtureModule> {
  const value: unknown = await import("./semantic-global." + "fixture" + ".cli.ts")
  if (!IsRecord(value)) throw new Error("semantic-global fixture module must be an object")
  return value as SemanticGlobalFixtureModule
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

function ProjectConfig(extra: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      types: [],
      lib: ["ES2022", "DOM"],
      ...extra
    },
    include: ["src/**/*"]
  }, null, 2) + "\n"
}

async function CheckProjectFiles(
  sources: Readonly<Record<string, string>>,
  allowed: readonly string[] = [],
  compilerOptions: Readonly<Record<string, unknown>> = {}
): Promise<readonly BoundaryIssue[]> {
  const root = await RepositoryFixture("likego-semantic-global-project-")
  const snapshot = SnapshotFiles([
    File("project/tsconfig.json", ProjectConfig(compilerOptions)),
    ...Object.entries(sources).map(([path, text]) => File("project/src/" + path, text))
  ])
  return WithProjectSessionWithOperations(
    snapshot,
    "project",
    async (session) => CheckSemanticGlobals(
      session.Project,
      session.SourceFiles,
      { AllowedFreeGlobals: allowed }
    ),
    NodeProjectSessionOperations(root)
  )
}

async function CheckProject(
  source: string,
  allowed: readonly string[] = []
): Promise<readonly BoundaryIssue[]> {
  return CheckProjectFiles({ "index.ts": source }, allowed)
}

function OneCaseSnapshot(policy: Uint8Array | null, extras: readonly SnapshotFile[] = []): InputSnapshot {
  const path = "valid/snapshot-only"
  return SnapshotFiles([
    File(CasesPath, JSON.stringify({
      schemaVersion: 1,
      cases: [{ id: "snapshot-only", path, expectedCodes: [] }]
    }) + "\n"),
    ...(policy === null
      ? []
      : [FileBytes(FamilyRoot + "/" + path + "/policy.json", policy)]),
    File(FamilyRoot + "/" + path + "/project/tsconfig.json", ProjectConfig()),
    File(FamilyRoot + "/" + path + "/project/src/index.ts", "export const value = 1\n"),
    ...extras
  ])
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
  const child = Bun.spawn([
    process.execPath,
    join(RepositoryRoot, "tools/boundaries/semantic-global.fixture.cli.ts"),
    "--root",
    root,
    "--run-id",
    runId
  ], {
    cwd: RepositoryRoot,
    stdout: "pipe",
    stderr: "pipe"
  })
  const stdoutPromise = new Response(child.stdout).text()
  const stderrPromise = new Response(child.stderr).text()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<"timeout">((resolveTimeout) => {
    timer = setTimeout(() => { resolveTimeout("timeout") }, 30_000)
  })
  const completed = await Promise.race([
    child.exited.then((exitCode) => ({ exitCode })),
    timeout
  ])
  if (completed === "timeout") {
    child.kill("SIGKILL")
    const exitCode = await child.exited
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])
    throw new Error(
      "semantic-global fixture timed out with "
      + String(exitCode)
      + ": "
      + stdout
      + stderr
    )
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
  const child = Bun.spawn([
    "bash",
    "-c",
    "set -o pipefail; \"$@\" | true",
    "likego-semantic-global-closed-stdout",
    process.execPath,
    join(RepositoryRoot, "tools/boundaries/semantic-global.fixture.cli.ts"),
    "--root",
    root,
    "--run-id",
    runId
  ], {
    cwd: RepositoryRoot,
    stdout: "pipe",
    stderr: "pipe"
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ])
  return { exitCode, signalCode: child.signalCode, stdout, stderr }
}

function PassingEvaluation(): CorpusEvaluation {
  return {
    SubjectsExpected: 35,
    SubjectsChecked: 35,
    Checks: [{ id: "INJECTED_PASS", status: "pass" }]
  }
}

function QuickDependencies(
  inputPath: string,
  atomic: AtomicWriterOperations = NodeAtomicWriterOperations()
): SemanticGlobalFixtureDependencies {
  return {
    DiscoverInputPaths: async () => [inputPath],
    Evaluate: async () => PassingEvaluation(),
    AtomicWriterOperations: atomic
  }
}

describe("Task6 semantic free-global and globalThis boundary", () => {
  test("locks the exact ordered thirty-five-case corpus and complete strict inventory", async () => {
    const document = JSON.parse(await readFile(join(RepositoryRoot, CasesPath), "utf8"))
    expect(document).toEqual({ schemaVersion: 1, cases: ExpectedCases })
    expect(document.cases).toHaveLength(35)

    const expectedFiles = [
      "cases.json",
      ...ExpectedCases.flatMap((fixtureCase) => [
        fixtureCase.path + "/policy.json",
        fixtureCase.path + "/project/src/index.ts",
        ...(fixtureCase.path === "valid/imported-declarations"
          ? [fixtureCase.path + "/project/src/value.ts"]
          : []),
        fixtureCase.path + "/project/tsconfig.json"
      ])
    ].sort(CompareCodeUnits)
    const actualFiles = await FilesBelow(join(RepositoryRoot, FamilyRoot))
    expect(actualFiles).toEqual(expectedFiles)
    expect(actualFiles).toHaveLength(107)
    expect(actualFiles.some((path) => (
      [".test.", "_test_", ".spec.", "_spec_"].some((part) => path.includes(part))
    ))).toBe(false)

    for (const fixtureCase of ExpectedCases) {
      const policy = JSON.parse(await readFile(
        join(RepositoryRoot, FamilyRoot, fixtureCase.path, "policy.json"),
        "utf8"
      ))
      const allowed = [
        "valid/allowlisted-console",
        "valid/global-this-console-dot",
        "valid/global-this-console-element"
      ].includes(fixtureCase.path)
        ? ["console"]
        : fixtureCase.path === "invalid/allowlisted-unresolved"
          ? ["MissingAllowed"]
          : []
      expect(policy).toEqual({ schemaVersion: 1, allowedFreeGlobals: allowed })
      expect(JSON.parse(await readFile(
        join(RepositoryRoot, FamilyRoot, fixtureCase.path, "project/tsconfig.json"),
        "utf8"
      ))).toEqual({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          types: [],
          lib: ["ES2022", "DOM"]
        },
        include: ["src/**/*.ts"]
      })
    }
  })

  test("declares the real async checker contract inside the live Task4 callback", async () => {
    const root = await mkdtemp(join(tmpdir(), "likego-semantic-global-red-"))
    TemporaryRoots.push(root)
    const Files = [
      File("project/tsconfig.json", JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: "ES2022",
          module: "ESNext",
          types: [],
          lib: ["ES2022", "DOM"]
        },
        include: ["src/**/*.ts"]
      })),
      File("project/src/index.ts", "export const value = Bun\n")
    ]
    await WithProjectSessionWithOperations(
      { Sha256: Sha256(Files.map((file) => file.Path + "\0" + file.Sha256 + "\n").join("")), Files },
      "project",
      async (session) => {
        expect(await CheckSemanticGlobals(
          session.Project,
          session.SourceFiles,
          { AllowedFreeGlobals: [] }
        )).toEqual([{
          Code: "GLOBAL_FREE_IDENTIFIER_FORBIDDEN",
          Path: "src/index.ts",
          Message: expect.stringContaining("Bun")
        }])
      },
      NodeProjectSessionOperations(root)
    )
  })

  test("excludes non-runtime names and text lookalikes while accepting proven local symbols", async () => {
    const issues = await CheckProject([
      "const text = \"@ts-ignore @ts-nocheck globalThis eval Function Bun\"",
      "const object = { eval() { return text }, globalThis: 1, Bun: 2 }",
      "object.eval()",
      "function run(eval: (value: string) => string): string {",
      "  return eval(text)",
      "}",
      "function count(): number { return arguments.length }",
      "label: for (let index = 0; index < 1; index += 1) { break label }",
      "type globalThis = eval | Function | Bun",
      "export const value = run((input) => input) + count() + object.globalThis + object.Bun",
      ""
    ].join("\n"))
    expect(issues).toEqual([])
  })

  test("retains duplicate runtime origins, class extends, shorthand values, decorators, typeof and TSX", async () => {
    const ordinary = await CheckProject([
      "class Derived extends MissingBase<MissingType> {}",
      "const shorthand = { Bun }",
      "const first = UnknownPortableGlobal",
      "const second = UnknownPortableGlobal",
      "export const runtimeType = typeof Deno",
      "@Decorator",
      "export class Decorated {}",
      "export { Derived, shorthand, first, second }",
      ""
    ].join("\n"))
    expect(ordinary.map((issue) => issue.Code)).toEqual(
      Array.from({ length: 6 }, () => "GLOBAL_FREE_IDENTIFIER_FORBIDDEN")
    )
    expect(ordinary.every((issue) => issue.Path === "src/index.ts")).toBe(true)
    const messages = ordinary.map((issue) => issue.Message)
    expect(messages.filter((message) => message.includes("UnknownPortableGlobal"))).toHaveLength(2)
    for (const name of ["Bun", "Decorator", "Deno", "MissingBase"]) {
      expect(messages.some((message) => message.includes(name))).toBe(true)
    }
    expect(messages.some((message) => message.includes("MissingType"))).toBe(false)

    const tsx = await CheckProjectFiles({
      "view.tsx": "export const view = <section>{Bun}</section>\n"
    }, [], { jsx: "preserve" })
    expect(tsx).toEqual([{
      Code: "GLOBAL_FREE_IDENTIFIER_FORBIDDEN",
      Path: "src/view.tsx",
      Message: expect.stringContaining("Bun")
    }])
  })

  test("uses the exact TypeScript JSX intrinsic spelling rule", async () => {
    const issues = await CheckProjectFiles({
      "view.tsx": [
        "export const view = (",
        "  <section><portable-widget /><_Capability /><$Capability /></section>",
        ")",
        ""
      ].join("\n")
    }, [], { jsx: "preserve" })
    expect(issues.map((issue) => issue.Code)).toEqual([
      "GLOBAL_FREE_IDENTIFIER_FORBIDDEN",
      "GLOBAL_FREE_IDENTIFIER_FORBIDDEN"
    ])
    expect(issues.map((issue) => issue.Message)).toEqual([
      expect.stringContaining("$Capability"),
      expect.stringContaining("_Capability")
    ])
  })

  test("classifies standard intrinsics and enforces exact globalThis wrappers, properties and escapes", async () => {
    expect(await CheckProject(
      "export const values = [Date, undefined]\n",
      ["Date", "undefined"]
    )).toEqual([])
    expect((await CheckProject(
      "export const values = [Date, undefined]\n"
    )).map((issue) => issue.Code)).toEqual([
      "GLOBAL_FREE_IDENTIFIER_FORBIDDEN",
      "GLOBAL_FREE_IDENTIFIER_FORBIDDEN"
    ])

    expect(await CheckProject([
      "export const dot = (((globalThis as typeof globalThis)!).console)",
      "export const element = ((globalThis satisfies typeof globalThis))[\"console\"]",
      ""
    ].join("\n"), ["console"])).toEqual([])

    expect(await CheckProject([
      "const globalThis = { console: 1, eval() { return 1 } }",
      "export const values = [globalThis.console, globalThis.eval()]",
      ""
    ].join("\n"))).toEqual([])

    expect((await CheckProject([
      "export const evaluate = globalThis.eval",
      "export const construct = globalThis[\"Function\"]",
      ""
    ].join("\n"), ["eval", "Function"])).map((issue) => issue.Code)).toEqual([
      "GLOBAL_DYNAMIC_CODE_FORBIDDEN",
      "GLOBAL_DYNAMIC_CODE_FORBIDDEN"
    ])

    expect(await CheckProject(
      "export const missing = globalThis[\"MissingAllowed\"]\n",
      ["MissingAllowed"]
    )).toEqual([{
      Code: "GLOBAL_THIS_PROPERTY_FORBIDDEN",
      Path: "src/index.ts",
      Message: expect.stringContaining("MissingAllowed")
    }])
  })

  test("peels every supported globalThis element selector wrapper", async () => {
    expect(await CheckProject([
      "export const parenthesized = globalThis[((\"console\"))]",
      "export const asSelector = globalThis[(\"console\" as const)]",
      "export const asserted = globalThis[(<\"console\">\"console\")]",
      "export const satisfied = globalThis[(\"console\" satisfies string)]",
      "export const nonNull = globalThis[(\"console\"!)]",
      ""
    ].join("\n"), ["console"])).toEqual([])

    expect((await CheckProject([
      "export const evaluate = globalThis[((\"eval\" as const)!)]",
      "export const construct = globalThis[((<\"Function\">\"Function\") satisfies string)]",
      ""
    ].join("\n"), ["eval", "Function"])).map((issue) => issue.Code)).toEqual([
      "GLOBAL_DYNAMIC_CODE_FORBIDDEN",
      "GLOBAL_DYNAMIC_CODE_FORBIDDEN"
    ])
  })

  test("permits downstream use of one proven globalThis capability", async () => {
    expect(await CheckProject([
      "export const call = globalThis.console.log(\"portable\")",
      "export const property = (globalThis.console).log",
      ""
    ].join("\n"), ["console"])).toEqual([])
  })

  test("uses checker identity for well-known symbols and standard selector proof", async () => {
    expect(await CheckProject([
      "export function count(): number { return arguments.length }",
      "export const intrinsic = undefined",
      ""
    ].join("\n"), ["undefined"])).toEqual([])

    expect(await CheckProject(
      "export const intrinsic = globalThis.undefined\n",
      ["undefined"]
    )).toEqual([])

    expect((await CheckProject(
      "export const invalid = arguments\n"
    )).map((issue) => issue.Code)).toEqual([
      "GLOBAL_FREE_IDENTIFIER_FORBIDDEN"
    ])
  })

  test("reports declaration files, outermost ambient subtrees, references and real comment directives", async () => {
    expect(await CheckProjectFiles({
      "types.d.ts": "export declare const capability: unknown\n"
    })).toEqual([{
      Code: "GLOBAL_AMBIENT_DECLARATION_FORBIDDEN",
      Path: "src/types.d.ts",
      Message: expect.any(String)
    }])

    const ambient = await CheckProject([
      "declare namespace Outer {",
      "  const Bun: unknown",
      "  namespace Inner { const Deno: unknown }",
      "}",
      "declare const Separate: unknown",
      "export {}",
      ""
    ].join("\n"))
    expect(ambient.map((issue) => issue.Code)).toEqual([
      "GLOBAL_AMBIENT_DECLARATION_FORBIDDEN",
      "GLOBAL_AMBIENT_DECLARATION_FORBIDDEN"
    ])

    const references = await CheckProject([
      "/// <reference types=\"first-missing-types\" />",
      "/// <reference types=\"second-missing-types\" />",
      "export const value = 1",
      ""
    ].join("\n"))
    expect(references.map((issue) => issue.Code)).toEqual([
      "GLOBAL_TYPE_REFERENCE_DIRECTIVE_FORBIDDEN",
      "GLOBAL_TYPE_REFERENCE_DIRECTIVE_FORBIDDEN"
    ])

    for (const comment of [
      "// @ts-expect-error",
      "/* @ts-ignore */",
      "/* @ts-nocheck */",
      "/** @ts-nocheck */",
      "//\t@ts-nocheck"
    ]) {
      const directives = await CheckProject(comment + "\nexport const value: string = 1\n")
      expect(directives).toEqual([{
        Code: "GLOBAL_TYPESCRIPT_DIRECTIVE_FORBIDDEN",
        Path: "src/index.ts",
        Message: expect.any(String)
      }])
    }

    expect(await CheckProject([
      "const first = \"// @ts-ignore\"",
      "const second = \"/* @ts-nocheck */\"",
      "const third = \"globalThis.eval\"",
      "export { first, second, third }",
      ""
    ].join("\n"))).toEqual([])
  })

  test("derives paths only from project identity, preserves sorted multisets and throws on drift", async () => {
    const root = await RepositoryFixture("likego-semantic-global-paths-")
    const snapshot = SnapshotFiles([
      File("project/tsconfig.json", ProjectConfig()),
      File("project/src/index.ts", [
        "// @ts-ignore",
        "declare const ambientValue: unknown",
        "export const dynamic = eval(\"1\")",
        "export const first = Bun",
        "export const second = Bun",
        ""
      ].join("\n"))
    ])
    await WithProjectSessionWithOperations(
      snapshot,
      "project",
      async (session) => {
        const issues = await CheckSemanticGlobals(
          session.Project,
          session.SourceFiles,
          { AllowedFreeGlobals: [] }
        )
        expect(issues.map((issue) => issue.Code)).toEqual([
          "GLOBAL_AMBIENT_DECLARATION_FORBIDDEN",
          "GLOBAL_DYNAMIC_CODE_FORBIDDEN",
          "GLOBAL_FREE_IDENTIFIER_FORBIDDEN",
          "GLOBAL_FREE_IDENTIFIER_FORBIDDEN",
          "GLOBAL_TYPESCRIPT_DIRECTIVE_FORBIDDEN"
        ])
        expect(issues.every((issue) => issue.Path === "src/index.ts")).toBe(true)
        expect(issues).toEqual([...issues].sort((left, right) => (
          CompareCodeUnits(left.Code, right.Code)
          || CompareCodeUnits(left.Path, right.Path)
          || CompareCodeUnits(left.Message, right.Message)
        )))

        const source = session.SourceFiles[0]!
        for (const fileName of [
          session.Project.configFileName,
          dirname(session.Project.configFileName) + "/src/../src/index.ts",
          join(session.StagedRoot, "outside.ts")
        ]) {
          const hostile = Object.create(source) as SourceFile
          Object.defineProperty(hostile, "fileName", { value: fileName })
          await expect(CheckSemanticGlobals(
            session.Project,
            [hostile],
            { AllowedFreeGlobals: [] }
          )).rejects.toThrow("semantic global source")
        }

        const hostileProject = Object.create(session.Project) as Project
        Object.defineProperty(hostileProject, "configFileName", {
          value: "project/tsconfig.json"
        })
        await expect(CheckSemanticGlobals(
          hostileProject,
          session.SourceFiles,
          { AllowedFreeGlobals: [] }
        )).rejects.toThrow("semantic global project config")
      },
      NodeProjectSessionOperations(root)
    )
    expect(await readdir(join(root, ".artifacts/gates/work"))).toEqual([])
  })

  test("evaluates all thirty-five exact multisets with real TS7 from immutable snapshot bytes", async () => {
    const fixture = await LoadFixtureModule()
    const root = await RepositoryFixture("likego-semantic-global-corpus-")
    await CopyCorpus(root)
    const discovered = await fixture.DiscoverSemanticGlobalFixtureInputs(root)
    expect(discovered).toEqual((await FilesBelow(join(root, FamilyRoot)))
      .map((path) => FamilyRoot + "/" + path)
      .sort(CompareCodeUnits))
    const snapshotted = await SnapshotInputs(root, discovered)
    expect(snapshotted.Checks).toEqual([])
    if (snapshotted.Snapshot === null) throw new Error("semantic-global corpus must snapshot")
    const before = snapshotted.Snapshot.Files.map((file) => ({
      file,
      bytes: new Uint8Array(file.Bytes),
      sha256: file.Sha256
    }))

    await Bun.write(
      join(root, FamilyRoot, "valid/property-keys/project/src/index.ts"),
      "export const value = Bun\n"
    )
    await Bun.write(
      join(root, FamilyRoot, "valid/property-keys/policy.json"),
      "not the snapshotted policy\n"
    )
    const evaluation = await fixture.EvaluateSemanticGlobalFixtureCorpus(
      snapshotted.Snapshot,
      root
    )
    expect(evaluation.SubjectsExpected).toBe(35)
    expect(evaluation.SubjectsChecked).toBe(35)
    expect(evaluation.Checks.map((check) => [check.id, check.status, check.path])).toEqual(
      ExpectedCases.map((fixtureCase) => ["FIXTURE_CASE_MATCH", "pass", fixtureCase.path])
    )
    for (const item of before) {
      expect(item.file.Bytes).toBe(snapshotted.Snapshot.Files.find((file) => (
        file.Path === item.file.Path
      ))!.Bytes)
      expect(item.file.Sha256).toBe(item.sha256)
      expect(Array.from(item.file.Bytes)).toEqual(Array.from(item.bytes))
    }
    expect(await readdir(join(root, ".artifacts/gates/work"))).toEqual([])

    const singleRoot = await RepositoryFixture("likego-semantic-global-real-checker-")
    const single = OneCaseSnapshot(new TextEncoder().encode(JSON.stringify({
      schemaVersion: 1,
      allowedFreeGlobals: []
    })))
    let observedProject: Project | null = null
    let observedSources: readonly SourceFile[] | null = null
    const singleEvaluation = await fixture.EvaluateSemanticGlobalFixtureCorpusWithChecker(
      single,
      singleRoot,
      async (project, sourceFiles, policy) => {
        observedProject = project
        observedSources = sourceFiles
        expect(policy).toEqual({ AllowedFreeGlobals: [] })
        return CheckSemanticGlobals(project, sourceFiles, policy)
      }
    )
    expect(singleEvaluation.Checks).toEqual([expect.objectContaining({
      id: "FIXTURE_CASE_MATCH",
      status: "pass",
      path: "valid/snapshot-only"
    })])
    const project = observedProject as Project | null
    const sources = observedSources as readonly SourceFile[] | null
    if (project === null || sources === null) {
      throw new Error("real TS7 callback must run")
    }
    expect(typeof project.checker.getSymbolAtLocation).toBe("function")
    expect(sources).toHaveLength(1)
    expect(sources[0]!.fileName.endsWith("/project/src/index.ts")).toBe(true)
  }, 120_000)

  test("fails closed on strict policy, inventory and discovery violations", async () => {
    const fixture = await LoadFixtureModule()
    const root = await RepositoryFixture("likego-semantic-global-policy-")
    const encoder = new TextEncoder()
    const malformed = [
      new Uint8Array([0xff]),
      encoder.encode("null\n"),
      encoder.encode('{"schemaVersion":1,"allowedFreeGlobals":[],"extra":true}\n'),
      encoder.encode('{"schemaVersion":2,"allowedFreeGlobals":[]}\n'),
      encoder.encode('{"schemaVersion":1,"allowedFreeGlobals":"console"}\n'),
      encoder.encode('{"schemaVersion":1,"allowedFreeGlobals":[""]}\n'),
      encoder.encode('{"schemaVersion":1,"allowedFreeGlobals":["console","console"]}\n')
    ]
    for (const policy of [null, ...malformed]) {
      const evaluation = await fixture.EvaluateSemanticGlobalFixtureCorpus(
        OneCaseSnapshot(policy),
        root
      )
      expect(evaluation.SubjectsExpected).toBe(1)
      expect(evaluation.SubjectsChecked).toBe(1)
      expect(evaluation.Checks).toEqual([expect.objectContaining({
        id: "FIXTURE_INVENTORY_MISMATCH",
        status: "fail",
        actual: '["FIXTURE_VALIDATOR_THROW"]'
      })])
    }

    const ordinary = OneCaseSnapshot(encoder.encode(
      '{"schemaVersion":1,"allowedFreeGlobals":[]}\n'
    ))
    const extra = File(FamilyRoot + "/unlisted/extra.ts", "export const extra = true\n")
    const inventory = await fixture.EvaluateSemanticGlobalFixtureCorpus(
      SnapshotFiles([...ordinary.Files, extra]),
      root
    )
    expect(inventory.SubjectsChecked).toBe(0)
    expect(inventory.Checks).toEqual([
      expect.objectContaining({ id: "FIXTURE_INVENTORY_MISMATCH" })
    ])
    const duplicated = await fixture.EvaluateSemanticGlobalFixtureCorpus(
      { Sha256: ordinary.Sha256, Files: [...ordinary.Files, ordinary.Files[0]!] },
      root
    )
    expect(duplicated.SubjectsChecked).toBe(0)
    expect(duplicated.Checks).toEqual([
      expect.objectContaining({ id: "FIXTURE_INVENTORY_MISMATCH" })
    ])

    const symlinkRoot = await RepositoryFixture("likego-semantic-global-family-link-")
    const outside = await RepositoryFixture("likego-semantic-global-family-outside-")
    await mkdir(dirname(join(symlinkRoot, FamilyRoot)), { recursive: true })
    await symlink(outside, join(symlinkRoot, FamilyRoot))
    await expect(fixture.DiscoverSemanticGlobalFixtureInputs(symlinkRoot))
      .rejects.toThrow("semantic-global fixture family must be a real directory")

    const nonRegularRoot = await RepositoryFixture("likego-semantic-global-nonregular-")
    await Bun.write(join(nonRegularRoot, CasesPath), '{"schemaVersion":1,"cases":[]}\n')
    await symlink("missing-target", join(nonRegularRoot, FamilyRoot, "linked-payload.ts"))
    await expect(fixture.DiscoverSemanticGlobalFixtureInputs(nonRegularRoot))
      .rejects.toThrow(
        "semantic-global fixture inventory entries must be regular files or directories"
      )

    const missingCasesRoot = await RepositoryFixture("likego-semantic-global-missing-cases-")
    await Bun.write(
      join(missingCasesRoot, FamilyRoot, "payload.ts"),
      "export const value = 1\n"
    )
    expect(await fixture.DiscoverSemanticGlobalFixtureInputs(missingCasesRoot)).toEqual([
      CasesPath,
      FamilyRoot + "/payload.ts"
    ])
  })

  test("rejects malformed CLI usage and safely rolls back every hostile emission", async () => {
    const fixture = await LoadFixtureModule()
    const usageRoot = await RepositoryFixture("likego-semantic-global-usage-")
    const canonicalPath = join(
      usageRoot,
      ".artifacts/gates/boundary-semantic-global-fixtures.json"
    )
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
      ["--root", usageRoot, "--run-id", "a" + "b".repeat(96)]
    ] as const
    for (const args of invalid) {
      const stdout: string[] = []
      const stderr: string[] = []
      expect(await fixture.Main(args, {
        WriteStdout: (value) => { stdout.push(value) },
        WriteStderr: (value) => { stderr.push(value) }
      })).toBe(1)
      expect(stdout).toEqual([])
      expect(stderr).toEqual(["SEMANTIC_GLOBAL_FIXTURE_USAGE invalid arguments\n"])
      expect(await readFile(canonicalPath, "utf8")).toBe("prior-result\n")
    }

    const root = await RepositoryFixture("likego-semantic-global-output-")
    const inputPath = "input.txt"
    await Bun.write(join(root, inputPath), "snapshotted input\n")
    const resultPath = join(
      root,
      ".artifacts/gates/boundary-semantic-global-fixtures.json"
    )
    await mkdir(dirname(resultPath), { recursive: true })
    await Bun.write(resultPath, "prior-result\n")

    const successStdout: string[] = []
    expect(await fixture.MainWithDependencies([
      "--root", root,
      "--run-id", "task6-injected-pass"
    ], {
      WriteStdout: (value) => { successStdout.push(value) },
      WriteStderr: () => { throw new Error("passing gate must not use stderr") }
    }, QuickDependencies(inputPath))).toBe(0)
    expect(successStdout).toHaveLength(1)
    expect(JSON.parse(successStdout[0]!.slice("LIKEGO_GATE_RESULT=".length))).toEqual(
      expect.objectContaining({ runId: "task6-injected-pass", status: "pass" })
    )

    const base = NodeAtomicWriterOperations()
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
        operations: { ...base, Open: async () => { throw new Error("injected atomic failure") } }
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
          [Symbol.toPrimitive]: () => { throw new Error("cannot stringify output") }
        }),
        expected: "unprintable error"
      }
    ]
    for (const failure of failures) {
      await Bun.write(resultPath, "prior-result\n")
      const stdout: string[] = []
      const stderr: string[] = []
      const io = {
        WriteStdout: failure.operations === undefined
          ? () => { throw failure.thrown }
          : (value: string) => { stdout.push(value) },
        WriteStderr: (value: string) => { stderr.push(value) }
      }
      expect(await fixture.MainWithDependencies([
        "--root", root,
        "--run-id", "task6-output-" + failure.id
      ], io, QuickDependencies(inputPath, failure.operations ?? base))).toBe(1)
      expect(stdout).toEqual([])
      expect(stderr).toEqual([
        "SEMANTIC_GLOBAL_FIXTURE_EMIT_ERROR " + failure.expected + "\n"
      ])
      expect(await readFile(resultPath, "utf8")).toBe("prior-result\n")
      expect((await readdir(dirname(resultPath))).filter((name) => (
        name.endsWith(".tmp") || name.endsWith(".lock")
      ))).toEqual([])
    }
  })

  test("routes default IO through Main and turns discovery failure into canonical evidence", async () => {
    const fixture = await LoadFixtureModule()
    const root = await RepositoryFixture("likego-semantic-global-default-io-")
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
      expect(await fixture.Main([])).toBe(1)
      expect(await fixture.Main([
        "--root", root,
        "--run-id", "task6-default-io"
      ])).toBe(1)
    } finally {
      process.stdout.write = originalStdoutWrite
      process.stderr.write = originalStderrWrite
    }
    expect(stderr).toEqual(["SEMANTIC_GLOBAL_FIXTURE_USAGE invalid arguments\n"])
    expect(stdout).toHaveLength(1)
    const result = JSON.parse(stdout[0]!.slice("LIKEGO_GATE_RESULT=".length))
    expect(result).toEqual(expect.objectContaining({
      runId: "task6-default-io",
      status: "fail",
      inputsSha256: null,
      checks: [expect.objectContaining({ id: "GATE_INPUT_ERROR" })]
    }))
  })

  test("exits naturally with exact current-run evidence and rolls back a real EPIPE", async () => {
    const fixture = await LoadFixtureModule()
    const root = await RepositoryFixture("likego-semantic-global-child-")
    await CopyCorpus(root)
    const discovered = await fixture.DiscoverSemanticGlobalFixtureInputs(root)
    const expectedSnapshot = await SnapshotInputs(root, discovered)
    if (expectedSnapshot.Snapshot === null) throw new Error("child corpus must snapshot")
    const child = await SpawnCli(root, "task6-real-ts7-child")
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
    expect(result).toEqual(expect.objectContaining({
      schemaVersion: 1,
      runId: "task6-real-ts7-child",
      gate: "boundary-semantic-global-fixtures",
      mode: "fixture",
      status: "pass",
      releaseReadiness: "not-evaluated",
      inputsSha256: expectedSnapshot.Snapshot.Sha256,
      subjects: { expected: 35, checked: 35 }
    }))
    expect(result.checks.map((check) => [check.id, check.status, check.path])).toEqual(
      ExpectedCases.map((fixtureCase) => ["FIXTURE_CASE_MATCH", "pass", fixtureCase.path])
    )
    expect(JSON.parse(await readFile(
      join(root, ".artifacts/gates/boundary-semantic-global-fixtures.json"),
      "utf8"
    ))).toEqual(result)
    expect(await readdir(join(root, ".artifacts/gates/work"))).toEqual([])

    const pipeRoot = await RepositoryFixture("likego-semantic-global-epipe-")
    await CopyCorpus(pipeRoot)
    const canonicalPath = join(
      pipeRoot,
      ".artifacts/gates/boundary-semantic-global-fixtures.json"
    )
    await mkdir(dirname(canonicalPath), { recursive: true })
    await Bun.write(canonicalPath, "prior-result\n")
    const piped = await SpawnWithClosedStdout(pipeRoot, "task6-real-epipe")
    expect(piped.signalCode).toBeNull()
    expect(piped.exitCode).toBe(1)
    expect(piped.stdout).toBe("")
    expect(piped.stderr).toContain("SEMANTIC_GLOBAL_FIXTURE_EMIT_ERROR")
    expect(piped.stderr).toContain("EPIPE")
    expect(await readFile(canonicalPath, "utf8")).toBe("prior-result\n")
    expect((await readdir(dirname(canonicalPath))).filter((name) => (
      name.endsWith(".tmp") || name.endsWith(".lock")
    ))).toEqual([])
    expect(await readdir(join(pipeRoot, ".artifacts/gates/work"))).toEqual([])
  }, 180_000)
})
