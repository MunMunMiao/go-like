import { expect, test } from "bun:test"
import { chmod } from "node:fs/promises"
import { join, resolve } from "node:path"

import type { RequiredTool, SuiteDefinition } from "../e2e/definitions"
import { runE2eRequest } from "../e2e/executor"
import type {
  CommandDefinition,
  CommandResult,
  ProcessPreflightResult,
  ProcessSupervisor
} from "../e2e/harness/process"
import { createTempDirectory, removeTempDirectory } from "../e2e/harness/temp"
import {
  probeRequiredRuntimeVersions,
  requiredToolsForPlan,
  type RuntimeProbeDependencies,
  type RuntimeProbeRunner
} from "../e2e/runtime-versions"

function result(
  stdout = "",
  exitCode = 0,
  overrides: Partial<CommandResult> = Object.freeze({})
): CommandResult {
  return Object.freeze({
    exitCode,
    signal: null,
    termination: "exit",
    timedOut: false,
    abortReason: null,
    durationMs: 1,
    stdout,
    stderr: "",
    cleanupFailures: Object.freeze([]),
    containment: "not-claimed",
    residual: "zero-observed",
    ...overrides
  })
}

function selectedDefinition(
  id: string,
  requiredTools: SuiteDefinition["requiredTools"]
): SuiteDefinition {
  return Object.freeze({
    id,
    tags: Object.freeze(["registered"] as const),
    defaultScopes: Object.freeze(["suites"] as const),
    includeInAll: true,
    cwd: ".",
    command: Object.freeze(["bun", id]),
    timeoutMs: 1_000,
    requiredTools: Object.freeze(requiredTools.slice()),
    requiresDocker: requiredTools.includes("docker"),
    dockerOwnership: requiredTools.includes("docker") ? "suite" : "none"
  })
}

function probeVersions(overrides: Partial<Record<string, string>> = {}): {
  readonly dependencies: RuntimeProbeDependencies
  readonly runner: RuntimeProbeRunner
} {
  return Object.freeze({
    dependencies: Object.freeze({
      bunVersion: () => overrides.bun ?? "bun-observed"
    }),
    runner: async (_root: string, definition: CommandDefinition) => {
      const executable = definition.command[0] ?? ""
      if (executable === "node") return result(overrides.node ?? "node-observed")
      if (executable === "deno") return result(overrides.deno ?? "deno-observed")
      if (executable === "docker") return result(overrides.docker ?? "docker-observed")
      return result(overrides.typescript ?? "typescript-observed")
    }
  })
}

function testSupervisor(runner: RuntimeProbeRunner, events: string[] = []): ProcessSupervisor {
  let preflighted = false
  const preflight: ProcessPreflightResult = Object.freeze({
    processMode: "managed",
    strategy: "posix-anchored-best-effort",
    containment: "not-claimed",
    cgroupV2: "n/a"
  })
  return Object.freeze({
    mode: "managed",
    async preflight() {
      events.push("platform-preflight")
      preflighted = true
      return preflight
    },
    async run(root: string, definition: CommandDefinition) {
      expect(preflighted).toBe(true)
      events.push(`spawn:${definition.command[0] ?? ""}`)
      return await runner(root, definition)
    },
    async close() {
      events.push("close")
    }
  })
}

async function writeVersionShim(path: string, body: string): Promise<void> {
  await Bun.write(path, `#!/bin/sh\n${body}\n`)
  await chmod(path, 0o700)
}

async function expectPathObservationAccepted(
  tool: Exclude<RequiredTool, "bun" | "docker">
): Promise<void> {
  const expectedPreflight = {
    node: "[e2e] PREFLIGHT bun=n/a node=future node channel deno=n/a typescript=n/a docker=n/a",
    deno: "[e2e] PREFLIGHT bun=n/a node=n/a deno=custom deno build typescript=n/a docker=n/a",
    typescript: "[e2e] PREFLIGHT bun=n/a node=n/a deno=n/a typescript=typescript nightly docker=n/a"
  } as const
  const directory = await createTempDirectory(`go-like-${tool}-version-`)
  const marker = join(directory.path, "consumer-started")
  try {
    await writeVersionShim(
      join(directory.path, "node"),
      `if [ "$1" = "--version" ]; then printf '%s\\n' 'future node channel'; else printf '%s\\n' 'typescript nightly'; fi`
    )
    await writeVersionShim(
      join(directory.path, "deno"),
      `printf '%s\\n' 'custom deno build'; printf '%s\\n' 'extra detail'`
    )
    const child = Bun.spawn(
      [
        process.execPath,
        resolve("e2e/fixtures/runner/version-preflight.ts"),
        tool,
        process.cwd(),
        marker
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PATH: `${directory.path}:${process.env.PATH ?? ""}`
        },
        stdout: "pipe",
        stderr: "pipe"
      }
    )
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text()
    ])
    if (exitCode !== 0) {
      throw new Error(
        `version preflight child exited ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`
      )
    }
    expect(`${stdout}\n${stderr}`).toContain(expectedPreflight[tool])
    expect(`${stdout}\n${stderr}`).not.toContain("required=")
    expect(await Bun.file(marker).text()).toBe("consumer started")
  } finally {
    await removeTempDirectory(directory)
  }
}

test("tool union probes only explicit definition requirements in fixed order", async () => {
  const calls: string[] = []
  const dependencies: RuntimeProbeDependencies = {
    bunVersion: () => {
      calls.push("bun")
      return "bun-observed"
    }
  }
  const runner: RuntimeProbeRunner = async (_root, definition) => {
    const executable = definition.command[0] ?? ""
    calls.push(executable)
    return executable === "node" ? result("node-observed") : result("docker-observed")
  }
  const tools = requiredToolsForPlan([
    selectedDefinition("docker-only", ["docker"]),
    selectedDefinition("node-only", ["node"])
  ])
  expect(tools).toEqual(["node", "docker"])
  const observations = await probeRequiredRuntimeVersions("/repo", tools, runner, dependencies)
  expect(observations.map((observation) => observation.tool)).toEqual(["node", "docker"])
  expect(calls).toEqual(["node", "docker"])
})

test("successful tool probes record arbitrary output without an eligibility gate", async () => {
  const observations = await probeRequiredRuntimeVersions(
    "/repo",
    ["bun", "node", "deno", "typescript", "docker"],
    async (_root, definition) => {
      const executable = definition.command[0] ?? ""
      if (executable === "node") return result("future-node channel")
      if (executable === "deno") return result("custom deno build\nextra detail")
      if (executable === "docker") return result("")
      return result("typescript nightly")
    },
    { bunVersion: () => "bun-canary" }
  )

  expect(observations).toEqual([
    { tool: "bun", actual: "bun-canary" },
    { tool: "node", actual: "future-node channel" },
    { tool: "deno", actual: "custom deno build" },
    { tool: "typescript", actual: "typescript nightly" },
    { tool: "docker", actual: "unreported" }
  ])
})

test("successful observations redact token-like output and bound the first line", async () => {
  const observations = await probeRequiredRuntimeVersions(
    "/repo",
    ["node", "deno"],
    async (_root, definition) =>
      result(definition.command[0] === "node" ? "token=probe-secret" : "x".repeat(1_001)),
    { bunVersion: () => "unused" }
  )

  expect(observations).toEqual([
    { tool: "node", actual: "token=<redacted>" },
    { tool: "deno", actual: "x".repeat(1_000) }
  ])
})

test("platform preflight completes before runtime probes and selected consumers", async () => {
  const events: string[] = []
  const probes = probeVersions()
  await runE2eRequest(
    "/repo",
    { kind: "scope", scope: "suites", processMode: "managed" },
    undefined,
    {
      definitions: [selectedDefinition("consumer", ["node"])],
      validatePlan: async () => {
        events.push("validate")
      },
      createSupervisor: async () => testSupervisor(probes.runner, events),
      runtimeProbe: probes.dependencies,
      executeDefinition: async () => {
        events.push("consumer")
        return result()
      },
      write: () => {}
    }
  )
  expect(events).toEqual(["validate", "platform-preflight", "spawn:node", "consumer", "close"])
})

test("platform preflight failure prevents runtime probes and selected consumers", async () => {
  const events: string[] = []
  const probes = probeVersions()
  const failingSupervisor: ProcessSupervisor = Object.freeze({
    mode: "platform-containment",
    async preflight() {
      events.push("platform-preflight")
      throw new Error("platform-containment-unsupported")
    },
    async run() {
      events.push("spawn")
      return result()
    },
    async close() {
      events.push("close")
    }
  })
  await expect(
    runE2eRequest(
      "/repo",
      { kind: "scope", scope: "suites", processMode: "platform-containment" },
      undefined,
      {
        definitions: [selectedDefinition("consumer", ["node"])],
        validatePlan: async () => {
          events.push("validate")
        },
        createSupervisor: async () => failingSupervisor,
        runtimeProbe: probes.dependencies,
        executeDefinition: async () => {
          events.push("consumer")
          return result()
        },
        write: () => {}
      }
    )
  ).rejects.toThrow("platform-containment-unsupported")
  expect(events).toEqual(["validate", "platform-preflight", "close"])
})

test("version differences are observed without blocking the selected consumer", async () => {
  const logs: string[] = []
  let started = 0
  const probes = probeVersions({ node: "v999.0.0" })

  await runE2eRequest(
    "/repo",
    { kind: "scope", scope: "suites", processMode: "managed" },
    undefined,
    {
      definitions: [selectedDefinition("consumer", ["node"])],
      validatePlan: async () => {},
      createSupervisor: async () => testSupervisor(probes.runner),
      runtimeProbe: probes.dependencies,
      executeDefinition: async () => {
        started += 1
        return result()
      },
      write: (value) => logs.push(value)
    }
  )

  expect(started).toBe(1)
  expect(logs.join("")).toContain("node=v999.0.0")
  expect(logs.join("")).not.toContain("required=")
})

async function expectUnavailableProbeStopsConsumer(
  runner: RuntimeProbeRunner,
  reason: string
): Promise<void> {
  let started = false
  const probes = probeVersions()
  await expect(
    runE2eRequest("/repo", { kind: "scope", scope: "suites", processMode: "managed" }, undefined, {
      definitions: [selectedDefinition("consumer", ["node"])],
      validatePlan: async () => {},
      createSupervisor: async () => testSupervisor(runner),
      runtimeProbe: probes.dependencies,
      executeDefinition: async () => {
        started = true
        return result()
      },
      write: () => {}
    })
  ).rejects.toThrow(`prerequisite-tool-unavailable: node version probe ${reason}`)
  expect(started).toBe(false)
}

test("a thrown required-tool probe prevents the selected consumer", async () => {
  await expectUnavailableProbeStopsConsumer(async () => {
    throw new Error("ENOENT")
  }, "failed")
})

test("a timed-out required-tool probe prevents the selected consumer", async () => {
  await expectUnavailableProbeStopsConsumer(
    async () => result("", 0, { timedOut: true, termination: "timeout", exitCode: null }),
    "timed out"
  )
})

test("an abnormally terminated required-tool probe prevents the selected consumer", async () => {
  await expectUnavailableProbeStopsConsumer(
    async () => result("", 0, { termination: "signal", exitCode: null, signal: "SIGTERM" }),
    "ended with signal"
  )
})

test("a nonzero required-tool probe prevents the selected consumer", async () => {
  let started = false
  const probes = probeVersions()
  const runner: RuntimeProbeRunner = async () => result("", 17)

  await expect(
    runE2eRequest("/repo", { kind: "scope", scope: "suites", processMode: "managed" }, undefined, {
      definitions: [selectedDefinition("consumer", ["node"])],
      validatePlan: async () => {},
      createSupervisor: async () => testSupervisor(runner),
      runtimeProbe: probes.dependencies,
      executeDefinition: async () => {
        started = true
        return result()
      },
      write: () => {}
    })
  ).rejects.toThrow("prerequisite-tool-unavailable: node version probe exited 17")
  expect(started).toBe(false)
})

test.each(["node", "deno", "typescript"] as const)(
  "fake PATH %s observation allows the consumer to start",
  async (tool) => {
    await expectPathObservationAccepted(tool)
  }
)
