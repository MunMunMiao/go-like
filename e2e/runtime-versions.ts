import { resolve } from "node:path"

import type { RequiredTool } from "./definitions"
import { boundedTail, redactText } from "./harness/diagnostics"
import type {
  CommandDefinition,
  CommandResult,
  ProcessPreflightResult,
  ProcessSupervisor
} from "./harness/process"

export interface RuntimeVersionObservation {
  readonly tool: RequiredTool
  readonly actual: string
}

export interface RuntimeProbeDependencies {
  readonly bunVersion: () => string
}

export type RuntimeProbeRunner = (
  root: string,
  definition: CommandDefinition
) => Promise<CommandResult>

const ToolOrder: readonly RequiredTool[] = Object.freeze([
  "bun",
  "node",
  "deno",
  "typescript",
  "docker"
])

const DefaultProbeDependencies: RuntimeProbeDependencies = Object.freeze({
  bunVersion: () => Bun.version
})

function commandFor(root: string, tool: Exclude<RequiredTool, "bun">): readonly string[] {
  if (tool === "node") return ["node", "--version"]
  if (tool === "deno") return ["deno", "--version"]
  if (tool === "typescript") return [resolve(root, "node_modules/.bin/tsc"), "--version"]
  return ["docker", "version", "--format", "{{.Server.Version}}"]
}

function commandOutput(tool: RequiredTool, result: CommandResult): string {
  if (result.timedOut)
    throw new Error(`prerequisite-tool-unavailable: ${tool} version probe timed out`)
  if (result.termination !== "exit" || result.exitCode === null) {
    throw new Error(
      `prerequisite-tool-unavailable: ${tool} version probe ended with ${result.termination}`
    )
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `prerequisite-tool-unavailable: ${tool} version probe exited ${result.exitCode}: ${boundedTail(result.stderr || result.stdout, 2_000)}`
    )
  }
  return result.stdout.trim()
}

function observedOutput(value: string): string {
  const firstLine = value.trim().split(/\r?\n/u, 1)[0]?.trim() ?? ""
  return firstLine.length === 0 ? "unreported" : boundedTail(redactText(firstLine), 1_000)
}

export function requiredToolsForPlan(
  definitions: readonly { readonly requiredTools: readonly RequiredTool[] }[]
): readonly RequiredTool[] {
  const required = new Set(definitions.flatMap((definition) => definition.requiredTools))
  return Object.freeze(ToolOrder.filter((tool) => required.has(tool)))
}

export async function probeRequiredRuntimeVersions(
  root: string,
  tools: readonly RequiredTool[],
  runner: RuntimeProbeRunner,
  dependencies: RuntimeProbeDependencies = DefaultProbeDependencies
): Promise<readonly RuntimeVersionObservation[]> {
  const observations: RuntimeVersionObservation[] = []
  for (const tool of ToolOrder) {
    if (!tools.includes(tool)) continue
    let raw: string
    if (tool === "bun") raw = dependencies.bunVersion()
    else {
      try {
        raw = commandOutput(
          tool,
          await runner(root, { cwd: ".", command: commandFor(root, tool), timeoutMs: 10_000 })
        )
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("prerequisite-")) throw error
        throw new Error(`prerequisite-tool-unavailable: ${tool} version probe failed`, {
          cause: error
        })
      }
    }
    observations.push(Object.freeze({ tool, actual: observedOutput(raw) }))
  }
  return Object.freeze(observations)
}

export function renderRuntimePreflight(
  observations: readonly RuntimeVersionObservation[],
  process: ProcessPreflightResult
): string {
  const byTool = new Map(observations.map((observation) => [observation.tool, observation]))
  const values = ToolOrder.map((tool) => {
    const observation = byTool.get(tool)
    if (observation === undefined) return `${tool}=n/a`
    return `${tool}=${observation.actual}`
  })
  values.push(
    `processMode=${process.processMode}`,
    `strategy=${process.strategy}`,
    `containment=${process.containment}`,
    `cgroupV2=${process.cgroupV2}`
  )
  return `[e2e] PREFLIGHT ${values.join(" ")}`
}

export type { ProcessSupervisor }
