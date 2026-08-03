import { resolve } from "node:path"

import type { RequiredTool } from "./definitions"
import { boundedTail } from "./harness/diagnostics"
import type {
  CommandDefinition,
  CommandResult,
  ProcessPreflightResult,
  ProcessSupervisor
} from "./harness/process"

export const RequiredRuntimeVersions = Object.freeze({
  bun: "1.3.14",
  node: "26.5.1",
  deno: "2.9.4",
  typescript: "7.0.2",
  k6: "2.1.0",
  k6Image:
    "grafana/k6:2.1.0@sha256:65c920dc067d5e2e00befbf982af6ad6ad0117034e8b1c65817c7975c52d4669"
} as const)

export interface RuntimeVersionObservation {
  readonly tool: RequiredTool
  readonly required: string | null
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

function exactOutput(value: string, pattern: RegExp, label: string): string {
  const match = pattern.exec(value.trim())
  if (match?.[1] === undefined) {
    throw new Error(`prerequisite-version-unparseable: cannot parse ${label} version`)
  }
  return match[1]
}

export function parseNodeVersion(output: string): string {
  return exactOutput(output, /^v(\d+\.\d+\.\d+)$/u, "Node.js")
}

export function parseDenoVersion(output: string): string {
  const firstLine = output.split(/\r?\n/u, 1)[0] ?? ""
  return exactOutput(firstLine, /^deno (\d+\.\d+\.\d+)(?:\s.*)?$/u, "Deno")
}

export function parseTypeScriptVersion(output: string): string {
  return exactOutput(output, /^Version (\d+\.\d+\.\d+)$/u, "TypeScript")
}

function parseDockerVersion(output: string): string {
  return exactOutput(output, /^(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/u, "Docker")
}

function requiredVersion(tool: RequiredTool): string | null {
  if (tool === "bun") return RequiredRuntimeVersions.bun
  if (tool === "node") return RequiredRuntimeVersions.node
  if (tool === "deno") return RequiredRuntimeVersions.deno
  if (tool === "typescript") return RequiredRuntimeVersions.typescript
  return null
}

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

function parseObservedVersion(tool: RequiredTool, output: string): string {
  if (tool === "bun") return exactOutput(output, /^(\d+\.\d+\.\d+)$/u, "Bun")
  if (tool === "node") return parseNodeVersion(output)
  if (tool === "deno") return parseDenoVersion(output)
  if (tool === "typescript") return parseTypeScriptVersion(output)
  return parseDockerVersion(output)
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
    const actual = parseObservedVersion(tool, raw)
    const required = requiredVersion(tool)
    observations.push(Object.freeze({ tool, required, actual }))
  }
  return Object.freeze(observations)
}

export function assertRequiredRuntimeVersions(
  observations: readonly RuntimeVersionObservation[]
): void {
  const mismatches = observations.filter(
    (observation) => observation.required !== null && observation.actual !== observation.required
  )
  if (mismatches.length === 0) return
  throw new Error(
    `prerequisite-version-mismatch: ${mismatches
      .map(
        (observation) =>
          `${observation.tool} required=${observation.required} actual=${observation.actual}`
      )
      .join("; ")}`
  )
}

export function renderRuntimePreflight(
  observations: readonly RuntimeVersionObservation[],
  process: ProcessPreflightResult
): string {
  const byTool = new Map(observations.map((observation) => [observation.tool, observation]))
  const values = ToolOrder.map((tool) => {
    const observation = byTool.get(tool)
    if (observation === undefined) return `${tool}=n/a`
    return observation.required === null
      ? `${tool}=${observation.actual}`
      : `${tool}=${observation.actual}(required=${observation.required})`
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
