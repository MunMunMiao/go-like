import {
  emitGateResultWithDependencies,
  nodeAtomicWriterOperations,
  runGate,
  writeProcessStderr,
  writeProcessStdout,
  type GateMode,
  type ReadinessPolicy
} from "../gates/result"
import { evaluateFixtureCorpus } from "../gates/fixture-corpus"
import { checkOfficialManifests, validateOfficialPackage } from "./validate"
import { readFile, readdir } from "node:fs/promises"
import { join, relative, resolve, sep } from "node:path"

import { discoverWorkspaces } from "../workspaces/discovery"

export interface ManifestCheckIO {
  readonly WriteStdout: (value: string) => void | Promise<void>
  readonly WriteStderr: (value: string) => void | Promise<void>
}

interface ParsedArguments {
  readonly Root: string
  readonly Mode: "fixture" | "repository"
  readonly RunId?: string
}

interface InputInventory {
  readonly Paths: readonly string[]
  readonly ExpectedSubjects: number
  readonly SubjectDirectories: readonly string[]
}

interface GateContract {
  readonly Gate: string
  readonly Mode: GateMode
  readonly ReadinessPolicy: ReadinessPolicy
}

const FamilyRoot = "tools/manifests/fixtures"
const CasesPath = `${FamilyRoot}/cases.json`
const SharedPaths = [
  "schemas/capability-manifest.schema.json",
  "schemas/owner-manifest.schema.json",
  "config/runtime-matrix.json"
] as const
const ManifestNames = ["package.json", "capability.json", "owner.json"] as const
const DefaultIO: ManifestCheckIO = {
  WriteStdout: writeProcessStdout,
  WriteStderr: writeProcessStderr
}

function CompareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function ParseArguments(args: readonly string[]): ParsedArguments | null {
  let Root = process.cwd()
  let Mode: "fixture" | "repository" | undefined
  let RunId: string | undefined
  const seen = new Set<string>()
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    const value = args[index + 1]
    if (name === undefined || value === undefined || value.length === 0 || seen.has(name))
      return null
    seen.add(name)
    if (name === "--root") Root = value
    else if (name === "--mode" && (value === "fixture" || value === "repository")) Mode = value
    else if (name === "--run-id") RunId = value
    else return null
  }
  if (Mode === undefined) return null
  return RunId === undefined ? { Root, Mode } : { Root, Mode, RunId }
}

function IsRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function IsMissing(error: unknown): boolean {
  return IsRecord(error) && error.code === "ENOENT"
}

async function FilesBelow(root: string, directoryPath: string): Promise<readonly string[]> {
  const absoluteRoot = resolve(root)
  const paths: string[] = []
  async function Visit(directory: string): Promise<void> {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (IsMissing(error)) return
      throw error
    }
    for (const entry of entries) {
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) {
        await Visit(absolute)
      } else {
        paths.push(relative(absoluteRoot, absolute).split(sep).join("/"))
      }
    }
  }
  await Visit(join(absoluteRoot, directoryPath))
  return paths.sort(CompareCodeUnits)
}

async function FixtureSubjectCount(root: string): Promise<number> {
  try {
    const value: unknown = JSON.parse(await readFile(join(root, CasesPath), "utf8"))
    return IsRecord(value) && value.schemaVersion === 1 && Array.isArray(value.cases)
      ? value.cases.length
      : 0
  } catch {
    return 0
  }
}

async function FixtureInventory(root: string): Promise<InputInventory> {
  const discovered = await FilesBelow(root, FamilyRoot)
  const Paths = [...new Set([...SharedPaths, CasesPath, ...discovered])].sort(CompareCodeUnits)
  return { Paths, ExpectedSubjects: await FixtureSubjectCount(root), SubjectDirectories: [] }
}

async function RepositoryInventory(root: string): Promise<InputInventory> {
  const paths = ["package.json", ...SharedPaths] as string[]
  const subjectDirectories: string[] = []
  for (const workspace of await discoverWorkspaces(root)) {
    if (workspace.private) continue
    subjectDirectories.push(workspace.root)
    for (const manifestName of ManifestNames) {
      paths.push(`${workspace.root}/${manifestName}`)
    }
    for (const path of await FilesBelow(root, `${workspace.root}/src`)) {
      paths.push(path)
    }
    for (const path of await FilesBelow(root, `${workspace.root}/test`)) {
      paths.push(path)
    }
  }
  return {
    Paths: [...new Set(paths)].sort(CompareCodeUnits),
    ExpectedSubjects: subjectDirectories.length,
    SubjectDirectories: Object.freeze(subjectDirectories)
  }
}

function ContractFor(mode: "fixture" | "repository"): GateContract {
  return mode === "fixture"
    ? { Gate: "manifest-fixtures", Mode: "fixture", ReadinessPolicy: "evaluation-only" }
    : { Gate: "official-manifests", Mode: "repository", ReadinessPolicy: "package-admission" }
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

export async function main(
  args: readonly string[],
  io: ManifestCheckIO = DefaultIO
): Promise<number> {
  const parsed = ParseArguments(args)
  if (parsed === null) {
    await io.WriteStderr("MANIFEST_USAGE invalid arguments\n")
    return 1
  }

  let inventory: InputInventory
  try {
    inventory =
      parsed.Mode === "fixture"
        ? await FixtureInventory(parsed.Root)
        : await RepositoryInventory(parsed.Root)
  } catch (error) {
    await io.WriteStderr(`MANIFEST_DISCOVERY_ERROR ${ErrorMessage(error)}\n`)
    return 1
  }
  const contract = ContractFor(parsed.Mode)
  const result = await runGate(
    {
      root: parsed.Root,
      gate: contract.Gate,
      mode: contract.Mode,
      readinessPolicy: contract.ReadinessPolicy,
      expectedSubjects: inventory.ExpectedSubjects,
      inputPaths: inventory.Paths,
      toolchain: { bun: Bun.version, typescript: "7.0.2" },
      ...(parsed.RunId === undefined ? {} : { runId: parsed.RunId })
    },
    async (snapshot) => {
      if (parsed.Mode === "repository") {
        return checkOfficialManifests(snapshot, inventory.SubjectDirectories)
      }
      const corpus = evaluateFixtureCorpus(snapshot, FamilyRoot, validateOfficialPackage)
      return { SubjectsChecked: corpus.SubjectsChecked, Checks: corpus.Checks }
    }
  )

  try {
    await emitGateResultWithDependencies(parsed.Root, result, {
      AtomicWriterOperations: nodeAtomicWriterOperations(),
      WriteStdout: io.WriteStdout
    })
  } catch (error) {
    await io.WriteStderr(`MANIFEST_EMIT_ERROR ${ErrorMessage(error)}\n`)
    return 1
  }
  return result.status === "pass" ? 0 : 1
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
