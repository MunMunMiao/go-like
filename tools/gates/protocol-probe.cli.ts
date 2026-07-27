import {
  emitGateResultWithDependencies,
  nodeAtomicWriterOperations,
  runGate,
  writeProcessStderr,
  writeProcessStdout,
  type GateEmissionDependencies
} from "./result"

type Scenario = "pass" | "evaluator-throw" | "input-error" | "emission-error"

export interface ProtocolProbeIO {
  readonly WriteStdout: (value: string) => void | Promise<void>
  readonly WriteStderr: (value: string) => void | Promise<void>
}

interface ParsedArguments {
  readonly Scenario: Scenario
  readonly Root: string
  readonly RunId?: string
}

const Scenarios = new Set<string>(["pass", "evaluator-throw", "input-error", "emission-error"])
const DefaultIO: ProtocolProbeIO = {
  WriteStdout: writeProcessStdout,
  WriteStderr: writeProcessStderr
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
  io: ProtocolProbeIO = DefaultIO
): Promise<number> {
  const parsed = ParseArguments(args)
  if (parsed === null) {
    await io.WriteStderr("GATE_CLI_USAGE invalid protocol probe arguments\n")
    return 1
  }

  const result = await runGate(
    {
      root: parsed.Root,
      gate: "protocol-probe",
      mode: "repository",
      readinessPolicy: "evaluation-only",
      expectedSubjects: 1,
      inputPaths:
        parsed.Scenario === "input-error" ? ["missing-protocol-input.txt"] : ["package.json"],
      toolchain: { bun: Bun.version },
      ...(parsed.RunId === undefined ? {} : { runId: parsed.RunId })
    },
    async () => {
      if (parsed.Scenario === "evaluator-throw") {
        throw new Error("injected evaluator failure")
      }
      return {
        SubjectsChecked: 1,
        Checks: [{ id: "PROTOCOL_PROBE_PASS", status: "pass" }]
      }
    }
  )

  const operations = nodeAtomicWriterOperations()
  const emissionDependencies: GateEmissionDependencies = {
    AtomicWriterOperations:
      parsed.Scenario === "emission-error"
        ? {
            ...operations,
            Open: async () => {
              throw new Error("injected emission failure")
            }
          }
        : operations,
    WriteStdout: io.WriteStdout
  }
  try {
    await emitGateResultWithDependencies(parsed.Root, result, emissionDependencies)
  } catch (error) {
    await io.WriteStderr(`GATE_EMIT_ERROR ${ErrorMessage(error)}\n`)
    return 1
  }
  return result.status === "pass" ? 0 : 1
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
