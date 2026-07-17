import { createHash } from "node:crypto"
import { lstat, readdir, realpath } from "node:fs/promises"
import { join, relative, sep } from "node:path"
import {
  AnalyzeProjectSessionWithOperations,
  NodeProjectSessionOperations
} from "./project-session.ts"
import { EvaluateAsyncFixtureCorpus, type CorpusEvaluation } from "../gates/fixture-corpus.ts"
import type { AtomicWriterOperations } from "../gates/atomic-writer.ts"
import {
  EmitGateResultWithDependencies,
  NodeAtomicWriterOperations,
  RunGate,
  WriteProcessStderr,
  WriteProcessStdout,
  type InputSnapshot,
  type SnapshotFile
} from "../gates/result.ts"

export interface ProjectSessionFixtureIO {
  readonly WriteStdout: (value: string) => void | Promise<void>
  readonly WriteStderr: (value: string) => void | Promise<void>
}

export interface ProjectSessionFixtureDependencies {
  readonly DiscoverInputPaths: (root: string) => Promise<readonly string[]>
  readonly Evaluate: (snapshot: InputSnapshot, root: string) => Promise<CorpusEvaluation>
  readonly AtomicWriterOperations: AtomicWriterOperations
}

interface ParsedArguments {
  readonly Root: string
  readonly RunId: string
}

const FamilyRoot = "tools/boundaries/fixtures/project-session"
const CasesPath = `${FamilyRoot}/cases.json`
const ExpectedSubjects = 9
const DefaultIO: ProjectSessionFixtureIO = {
  WriteStdout: WriteProcessStdout,
  WriteStderr: WriteProcessStderr
}

function Sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

function CompareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
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

export async function DiscoverProjectSessionFixtureInputs(root: string): Promise<readonly string[]> {
  const repositoryRoot = await realpath(root)
  const familyRoot = join(repositoryRoot, ...FamilyRoot.split("/"))
  const familyInformation = await lstat(familyRoot)
  if (familyInformation.isSymbolicLink() || !familyInformation.isDirectory()) {
    throw new Error("project-session fixture family must be a real directory")
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
        throw new Error("project-session fixture inventory entries must be regular files or directories")
      }
    }
  }
  await Visit(familyRoot)
  if (!paths.includes(CasesPath)) paths.push(CasesPath)
  return [...new Set(paths)].sort(CompareCodeUnits)
}

function CaseSnapshot(files: readonly SnapshotFile[]): InputSnapshot {
  const Files = [...files].sort((left, right) => CompareCodeUnits(left.Path, right.Path))
  return {
    Sha256: Sha256(Files.map((file) => `${file.Path}\0${file.Sha256}\n`).join("")),
    Files
  }
}

export async function EvaluateProjectSessionFixtureCorpus(
  snapshot: InputSnapshot,
  repositoryRoot: string
): Promise<CorpusEvaluation> {
  return EvaluateProjectSessionFixtureCorpusWithAnalyzer(
    snapshot,
    repositoryRoot,
    AnalyzeProjectSessionWithOperations
  )
}

export async function EvaluateProjectSessionFixtureCorpusWithAnalyzer(
  snapshot: InputSnapshot,
  repositoryRoot: string,
  analyze: typeof AnalyzeProjectSessionWithOperations
): Promise<CorpusEvaluation> {
  return EvaluateAsyncFixtureCorpus(snapshot, FamilyRoot, async (files) => {
    const result = await analyze(
      CaseSnapshot(files),
      "project",
      NodeProjectSessionOperations(repositoryRoot)
    )
    return result.Issues
  })
}

export async function Main(
  args: readonly string[],
  io: ProjectSessionFixtureIO = DefaultIO
): Promise<number> {
  return MainWithDependencies(args, io, {
    DiscoverInputPaths: DiscoverProjectSessionFixtureInputs,
    Evaluate: EvaluateProjectSessionFixtureCorpus,
    AtomicWriterOperations: NodeAtomicWriterOperations()
  })
}

export async function MainWithDependencies(
  args: readonly string[],
  io: ProjectSessionFixtureIO,
  dependencies: ProjectSessionFixtureDependencies
): Promise<number> {
  const parsed = ParseArguments(args)
  if (parsed === null) {
    await io.WriteStderr("PROJECT_SESSION_FIXTURE_USAGE invalid arguments\n")
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
    gate: "boundary-project-session-fixtures",
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
    await io.WriteStderr(`PROJECT_SESSION_FIXTURE_EMIT_ERROR ${ErrorMessage(error)}\n`)
    return 1
  }
  return result.status === "pass" ? 0 : 1
}

if (import.meta.main) process.exitCode = await Main(process.argv.slice(2))
