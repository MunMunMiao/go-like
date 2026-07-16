import {
  EmitGateResultWithDependencies,
  NodeAtomicWriterOperations,
  RunGate
} from "../gates/result.ts"
import { ValidateRuntimeMatrix } from "./runtime-manifest.ts"

export interface RuntimeManifestIO {
  readonly WriteStdout: (value: string) => void
  readonly WriteStderr: (value: string) => void
}

interface ParsedArguments {
  readonly Root: string
  readonly RunId?: string
}

const InputPaths = [
  "docs/adr/0001-kernel-public-api.md",
  "docs/adr/0002-build-runtime-and-coverage.md",
  "config/runtime-matrix.json",
  "package.json",
  "bunfig.toml",
  "deno.json"
] as const
const DefaultIO: RuntimeManifestIO = {
  WriteStdout: (value) => { process.stdout.write(value) },
  WriteStderr: (value) => { process.stderr.write(value) }
}

function ParseArguments(args: readonly string[]): ParsedArguments | null {
  let Root = process.cwd()
  let RunId: string | undefined
  const seen = new Set<string>()
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    const value = args[index + 1]
    if (name === undefined || value === undefined || value.length === 0 || seen.has(name)) return null
    seen.add(name)
    if (name === "--root") {
      Root = value
    } else if (name === "--run-id") {
      RunId = value
    } else {
      return null
    }
  }
  return RunId === undefined ? { Root } : { Root, RunId }
}

function ErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function Main(
  args: readonly string[],
  io: RuntimeManifestIO = DefaultIO
): Promise<number> {
  const parsed = ParseArguments(args)
  if (parsed === null) {
    io.WriteStderr("RUNTIME_MANIFEST_USAGE invalid arguments\n")
    return 1
  }

  const result = await RunGate({
    root: parsed.Root,
    gate: "runtime-contract",
    mode: "repository",
    readinessPolicy: "evaluation-only",
    expectedSubjects: 4,
    inputPaths: InputPaths,
    toolchain: { bun: Bun.version, typescript: "7.0.2" },
    ...(parsed.RunId === undefined ? {} : { runId: parsed.RunId })
  }, async (snapshot) => ValidateRuntimeMatrix(snapshot))

  try {
    await EmitGateResultWithDependencies(parsed.Root, result, {
      AtomicWriterOperations: NodeAtomicWriterOperations(),
      WriteStdout: io.WriteStdout
    })
  } catch (error) {
    io.WriteStderr(`RUNTIME_MANIFEST_EMIT_ERROR ${ErrorMessage(error)}\n`)
    return 1
  }
  return result.status === "pass" ? 0 : 1
}

if (import.meta.main) process.exitCode = await Main(process.argv.slice(2))
