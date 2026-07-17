import { createHash } from "node:crypto"
import { lstat, readdir, realpath } from "node:fs/promises"
import { join, relative, sep } from "node:path"
import type { SourceFile } from "typescript/unstable/ast"
import {
  NodeProjectSessionOperations,
  WithProjectSessionWithOperations
} from "./project-session.ts"
import {
  CheckModuleSyntax,
  type BoundaryIssue,
  type ModulePolicy
} from "./module-syntax.ts"
import type { AtomicWriterOperations } from "../gates/atomic-writer.ts"
import { EvaluateAsyncFixtureCorpus, type CorpusEvaluation } from "../gates/fixture-corpus.ts"
import {
  EmitGateResultWithDependencies,
  NodeAtomicWriterOperations,
  RunGate,
  WriteProcessStderr,
  WriteProcessStdout,
  type InputSnapshot,
  type SnapshotFile
} from "../gates/result.ts"

export interface ModuleSyntaxFixtureIO {
  readonly WriteStdout: (value: string) => void | Promise<void>
  readonly WriteStderr: (value: string) => void | Promise<void>
}

export interface ModuleSyntaxFixtureDependencies {
  readonly DiscoverInputPaths: (root: string) => Promise<readonly string[]>
  readonly Evaluate: (snapshot: InputSnapshot, root: string) => Promise<CorpusEvaluation>
  readonly AtomicWriterOperations: AtomicWriterOperations
}

export type ModuleSyntaxChecker = (
  sourceFiles: readonly SourceFile[],
  policy: ModulePolicy
) => readonly BoundaryIssue[]

interface ParsedArguments {
  readonly Root: string
  readonly RunId: string
}

interface PolicyDocument {
  readonly schemaVersion: 1
  readonly allowedWorkspaceDependencies: readonly string[]
}

const FamilyRoot = "tools/boundaries/fixtures/module-syntax"
const CasesPath = `${FamilyRoot}/cases.json`
const ExpectedSubjects = 20
const Decoder = new TextDecoder("utf-8", { fatal: true })
const DefaultIO: ModuleSyntaxFixtureIO = {
  WriteStdout: WriteProcessStdout,
  WriteStderr: WriteProcessStderr
}

function Sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

function CompareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function IsRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function HasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
}

function ErrorMessage(error: unknown): string {
  try {
    if (error instanceof Error) {
      const message: unknown = error.message
      return typeof message === "string" ? message : "unprintable error"
    }
    return String(error)
  } catch {
    return "unprintable error"
  }
}

function ParseArguments(args: readonly string[]): ParsedArguments | null {
  let Root: string | undefined
  let RunId: string | undefined
  const seen = new Set<string>()
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    const value = args[index + 1]
    if (name === undefined || value === undefined || value.length === 0 || seen.has(name)) return null
    seen.add(name)
    if (name === "--root") Root = value
    else if (name === "--run-id" && /^[a-z0-9][a-z0-9_-]{0,95}$/.test(value)) RunId = value
    else return null
  }
  return Root === undefined || RunId === undefined ? null : { Root, RunId }
}

function ParsePolicy(files: readonly SnapshotFile[]): PolicyDocument {
  const candidates = files.filter((file) => file.Path === "policy.json")
  if (candidates.length !== 1) throw new Error("module-syntax fixture requires one policy.json")
  let value: unknown
  try {
    value = JSON.parse(Decoder.decode(candidates[0]!.Bytes)) as unknown
  } catch {
    throw new Error("module-syntax fixture policy must be canonical UTF-8 JSON")
  }
  if (
    !IsRecord(value)
    || !HasExactKeys(value, ["schemaVersion", "allowedWorkspaceDependencies"])
    || value.schemaVersion !== 1
    || !Array.isArray(value.allowedWorkspaceDependencies)
  ) throw new Error("module-syntax fixture policy must use the fixed shape")
  const allowed = value.allowedWorkspaceDependencies
  if (
    !allowed.every((item) => typeof item === "string" && item.length > 0)
    || new Set(allowed).size !== allowed.length
  ) throw new Error("module-syntax fixture policy dependencies must be unique non-empty strings")
  return { schemaVersion: 1, allowedWorkspaceDependencies: [...allowed] as string[] }
}

export async function DiscoverModuleSyntaxFixtureInputs(root: string): Promise<readonly string[]> {
  const repositoryRoot = await realpath(root)
  const familyRoot = join(repositoryRoot, ...FamilyRoot.split("/"))
  const familyInformation = await lstat(familyRoot)
  if (familyInformation.isSymbolicLink() || !familyInformation.isDirectory()) {
    throw new Error("module-syntax fixture family must be a real directory")
  }

  const paths: string[] = []
  async function Visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => CompareCodeUnits(left.name, right.name))
    for (const entry of entries) {
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) {
        await Visit(absolute)
      } else if (entry.isFile()) {
        paths.push(relative(repositoryRoot, absolute).split(sep).join("/"))
      } else {
        throw new Error("module-syntax fixture inventory entries must be regular files or directories")
      }
    }
  }
  await Visit(familyRoot)
  if (!paths.includes(CasesPath)) paths.push(CasesPath)
  return [...new Set(paths)].sort(CompareCodeUnits)
}

function CaseSnapshot(files: readonly SnapshotFile[]): InputSnapshot {
  const Files = files
    .filter((file) => file.Path.startsWith("project/"))
    .sort((left, right) => CompareCodeUnits(left.Path, right.Path))
  return {
    Sha256: Sha256(Files.map((file) => `${file.Path}\0${file.Sha256}\n`).join("")),
    Files
  }
}

export async function EvaluateModuleSyntaxFixtureCorpus(
  snapshot: InputSnapshot,
  repositoryRoot: string
): Promise<CorpusEvaluation> {
  return EvaluateModuleSyntaxFixtureCorpusWithChecker(snapshot, repositoryRoot, CheckModuleSyntax)
}

export async function EvaluateModuleSyntaxFixtureCorpusWithChecker(
  snapshot: InputSnapshot,
  repositoryRoot: string,
  check: ModuleSyntaxChecker
): Promise<CorpusEvaluation> {
  return EvaluateAsyncFixtureCorpus(snapshot, FamilyRoot, async (files) => {
    const policy = ParsePolicy(files)
    return WithProjectSessionWithOperations(
      CaseSnapshot(files),
      "project",
      async (session) => check(session.SourceFiles, {
        PackageRoot: join(session.StagedRoot, "project"),
        AllowedWorkspaceDependencies: policy.allowedWorkspaceDependencies
      }),
      NodeProjectSessionOperations(repositoryRoot)
    )
  })
}

export async function Main(
  args: readonly string[],
  io: ModuleSyntaxFixtureIO = DefaultIO
): Promise<number> {
  return MainWithDependencies(args, io, {
    DiscoverInputPaths: DiscoverModuleSyntaxFixtureInputs,
    Evaluate: EvaluateModuleSyntaxFixtureCorpus,
    AtomicWriterOperations: NodeAtomicWriterOperations()
  })
}

export async function MainWithDependencies(
  args: readonly string[],
  io: ModuleSyntaxFixtureIO,
  dependencies: ModuleSyntaxFixtureDependencies
): Promise<number> {
  const parsed = ParseArguments(args)
  if (parsed === null) {
    await io.WriteStderr("MODULE_SYNTAX_FIXTURE_USAGE invalid arguments\n")
    return 1
  }

  let inputPaths: readonly string[]
  try {
    inputPaths = await dependencies.DiscoverInputPaths(parsed.Root)
  } catch {
    inputPaths = [""]
  }
  const result = await RunGate({
    root: parsed.Root,
    gate: "boundary-module-syntax-fixtures",
    mode: "fixture",
    readinessPolicy: "evaluation-only",
    expectedSubjects: ExpectedSubjects,
    inputPaths,
    toolchain: { bun: Bun.version, typescript: "7.0.2" },
    runId: parsed.RunId
  }, async (snapshot) => {
    const evaluation = await dependencies.Evaluate(snapshot, parsed.Root)
    return {
      SubjectsChecked: evaluation.SubjectsChecked,
      Checks: evaluation.Checks
    }
  })

  try {
    await EmitGateResultWithDependencies(parsed.Root, result, {
      AtomicWriterOperations: dependencies.AtomicWriterOperations,
      WriteStdout: io.WriteStdout
    })
  } catch (error) {
    await io.WriteStderr(`MODULE_SYNTAX_FIXTURE_EMIT_ERROR ${ErrorMessage(error)}\n`)
    return 1
  }
  return result.status === "pass" ? 0 : 1
}

if (import.meta.main) process.exitCode = await Main(process.argv.slice(2))
