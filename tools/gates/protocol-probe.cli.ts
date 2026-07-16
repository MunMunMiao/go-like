import {
  EmitGateResultWithDependencies,
  NodeAtomicWriterOperations,
  RunGate,
  type GateEmissionDependencies
} from "./result.ts"

type Scenario = "pass" | "evaluator-throw" | "input-error" | "emission-error"

export interface ProtocolProbeIO {
  readonly WriteStdout: (value: string) => void
  readonly WriteStderr: (value: string) => void
}

interface ParsedArguments {
  readonly Scenario: Scenario
  readonly Root: string
  readonly RunId?: string
}

const Scenarios = new Set<string>(["pass", "evaluator-throw", "input-error", "emission-error"])
const DefaultIO: ProtocolProbeIO = {
  WriteStdout: (value) => { process.stdout.write(value) },
  WriteStderr: (value) => { process.stderr.write(value) }
}

function ParseArguments(args: readonly string[]): ParsedArguments | null {
  let Scenario: Scenario | null = null
  let Root = process.cwd()
  let RunId: string | undefined
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    const value = args[index + 1]
    if (value === undefined) {
      return null
    }
    if (name === "--scenario" && Scenarios.has(value)) {
      Scenario = value as Scenario
    } else if (name === "--root") {
      Root = value
    } else if (name === "--run-id") {
      RunId = value
    } else {
      return null
    }
  }
  if (Scenario === null) {
    return null
  }
  return RunId === undefined ? { Scenario, Root } : { Scenario, Root, RunId }
}

function ErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function Main(
  args: readonly string[],
  io: ProtocolProbeIO = DefaultIO
): Promise<number> {
  const parsed = ParseArguments(args)
  if (parsed === null) {
    io.WriteStderr("GATE_CLI_USAGE invalid protocol probe arguments\n")
    return 1
  }

  const result = await RunGate({
    root: parsed.Root,
    gate: "protocol-probe",
    mode: "repository",
    readinessPolicy: "evaluation-only",
    expectedSubjects: 1,
    inputPaths: parsed.Scenario === "input-error" ? ["missing-protocol-input.txt"] : ["package.json"],
    toolchain: { bun: Bun.version },
    ...(parsed.RunId === undefined ? {} : { runId: parsed.RunId })
  }, async () => {
    if (parsed.Scenario === "evaluator-throw") {
      throw new Error("injected evaluator failure")
    }
    return {
      SubjectsChecked: 1,
      Checks: [{ id: "PROTOCOL_PROBE_PASS", status: "pass" }]
    }
  })

  const operations = NodeAtomicWriterOperations()
  const emissionDependencies: GateEmissionDependencies = {
    AtomicWriterOperations: parsed.Scenario === "emission-error"
      ? {
          ...operations,
          Open: async () => { throw new Error("injected emission failure") }
        }
      : operations,
    WriteStdout: io.WriteStdout
  }
  try {
    await EmitGateResultWithDependencies(parsed.Root, result, emissionDependencies)
  } catch (error) {
    io.WriteStderr(`GATE_EMIT_ERROR ${ErrorMessage(error)}\n`)
    return 1
  }
  return result.status === "pass" ? 0 : 1
}

if (import.meta.main) process.exitCode = await Main(process.argv.slice(2))
