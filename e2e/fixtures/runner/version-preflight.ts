import type { RequiredTool, SuiteDefinition } from "../../definitions"
import { runE2eRequest } from "../../executor"
import { runCommand, type CommandResult, type ProcessSupervisor } from "../../harness/process"

const ProbeTools = Object.freeze(["node", "deno", "typescript"] as const)

function requiredArgument(index: number, label: string): string {
  const value = process.argv[index]
  if (value === undefined || value.length === 0) throw new Error(`missing ${label}`)
  return value
}

const toolValue = requiredArgument(2, "tool")
if (!ProbeTools.includes(toolValue as (typeof ProbeTools)[number])) {
  throw new Error(`unsupported probe tool ${toolValue}`)
}
const tool = toolValue as RequiredTool
const root = requiredArgument(3, "root")
const marker = requiredArgument(4, "consumer marker")
function successfulResult(): CommandResult {
  return Object.freeze({
    exitCode: 0,
    signal: null,
    termination: "exit",
    timedOut: false,
    abortReason: null,
    durationMs: 1,
    stdout: "",
    stderr: "",
    cleanupFailures: Object.freeze([]),
    containment: "not-claimed",
    residual: "zero-observed"
  })
}

const definition: SuiteDefinition = Object.freeze({
  id: `${tool}-consumer`,
  tags: Object.freeze(["registered"] as const),
  defaultScopes: Object.freeze(["suites"] as const),
  includeInAll: true,
  cwd: ".",
  command: Object.freeze([process.execPath, "-e", "process.exit(0)"]),
  timeoutMs: 2_000,
  requiredTools: Object.freeze([tool]),
  requiresDocker: false,
  dockerOwnership: "none"
})

const supervisor: ProcessSupervisor = Object.freeze({
  mode: "managed",
  async preflight() {
    return Object.freeze({
      processMode: "managed",
      strategy: "runtime-managed",
      containment: "not-claimed",
      cgroupV2: "n/a"
    })
  },
  run: runCommand,
  async close() {}
})

await runE2eRequest(root, { kind: "scope", scope: "suites", processMode: "managed" }, undefined, {
  definitions: [definition],
  createSupervisor: async () => supervisor,
  executeDefinition: async () => {
    await Bun.write(marker, "consumer started")
    return successfulResult()
  }
})
