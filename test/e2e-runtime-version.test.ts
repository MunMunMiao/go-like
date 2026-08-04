import { expect, test } from "bun:test"
import { chmod, lstat } from "node:fs/promises"
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
  assertRequiredRuntimeVersions,
  parseDenoVersion,
  parseNodeVersion,
  parseTypeScriptVersion,
  probeRequiredRuntimeVersions,
  RequiredRuntimeVersions,
  requiredToolsForPlan,
  type RuntimeProbeDependencies,
  type RuntimeProbeRunner
} from "../e2e/runtime-versions"

const RepresentativeNodeVersion = "26.0.0"

function result(stdout = "", exitCode = 0): CommandResult {
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
    residual: "zero-observed"
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
      bunVersion: () => overrides.bun ?? RequiredRuntimeVersions.bun
    }),
    runner: async (_root: string, definition: CommandDefinition) => {
      const executable = definition.command[0] ?? ""
      if (executable === "node") return result(overrides.node ?? `v${RepresentativeNodeVersion}`)
      if (executable === "deno") {
        return result(
          overrides.deno ??
            `deno ${RequiredRuntimeVersions.deno}\nv8 fixture\ntypescript ${RequiredRuntimeVersions.typescript}`
        )
      }
      if (executable === "docker") return result(overrides.docker ?? "29.6.2")
      return result(overrides.typescript ?? `Version ${RequiredRuntimeVersions.typescript}`)
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

async function expectPathMismatch(tool: Exclude<RequiredTool, "bun" | "docker">): Promise<void> {
  const directory = await createTempDirectory(`go-like-${tool}-version-`)
  const marker = join(directory.path, "consumer-started")
  try {
    await writeVersionShim(
      join(directory.path, "node"),
      `if [ "$1" = "--version" ]; then printf '%s\\n' 'v0.0.1'; else printf '%s\\n' 'Version 0.0.1'; fi`
    )
    await writeVersionShim(join(directory.path, "deno"), `printf '%s\\n' 'deno 0.0.1'`)
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
    expect(exitCode).not.toBe(0)
    expect(`${stdout}\n${stderr}`).toContain("prerequisite-version-mismatch")
    expect(`${stdout}\n${stderr}`).toContain(`${tool}=0.0.1(required=`)
    await expect(lstat(marker)).rejects.toThrow()
  } finally {
    await removeTempDirectory(directory)
  }
}

test("runtime version parsers accept exact supported formats", () => {
  expect(parseNodeVersion("v26.0.0\n")).toBe("26.0.0")
  expect(parseDenoVersion("deno 2.9.4 (stable)\nv8 14\ntypescript 7.0.2\n")).toBe("2.9.4")
  expect(parseTypeScriptVersion("Version 7.0.2\n")).toBe("7.0.2")
})

test("runtime version parsers reject malformed or ambiguous output", () => {
  expect(() => parseNodeVersion("26.0.0")).toThrow("cannot parse Node.js version")
  expect(() => parseNodeVersion("v26.0.0\nextra")).toThrow("cannot parse Node.js version")
  expect(() => parseDenoVersion("typescript 7.0.2")).toThrow("cannot parse Deno version")
  expect(() => parseTypeScriptVersion("typescript 7.0.2")).toThrow(
    "cannot parse TypeScript version"
  )
})

test("Node runtime requirement accepts every 26.x patch but rejects adjacent majors", () => {
  expect(() =>
    assertRequiredRuntimeVersions([
      Object.freeze({ tool: "node", required: RequiredRuntimeVersions.node, actual: "26.5.0" })
    ])
  ).not.toThrow()
  expect(() =>
    assertRequiredRuntimeVersions([
      Object.freeze({ tool: "node", required: RequiredRuntimeVersions.node, actual: "27.0.0" })
    ])
  ).toThrow("node required=26.x actual=27.0.0")
})

test("tool union probes only explicit definition requirements in fixed order", async () => {
  const calls: string[] = []
  const dependencies: RuntimeProbeDependencies = {
    bunVersion: () => {
      calls.push("bun")
      return RequiredRuntimeVersions.bun
    }
  }
  const runner: RuntimeProbeRunner = async (_root, definition) => {
    const executable = definition.command[0] ?? ""
    calls.push(executable)
    return executable === "node" ? result(`v${RepresentativeNodeVersion}`) : result("29.6.2")
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

test("version mismatch reports required and actual before any selected consumer starts", async () => {
  const logs: string[] = []
  let started = 0
  let failure: unknown = null
  const probes = probeVersions({ node: "v0.0.1" })
  try {
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
  } catch (error) {
    failure = error
  }
  expect(started).toBe(0)
  expect(String(failure)).toContain("prerequisite-version-mismatch")
  expect(logs.join("")).toContain("node=0.0.1(required=26.x)")
  expect(logs.join("")).toContain("selected=1 started=0 passed=0 failed=0 notRun=1")
  expect(logs.join("")).toContain("status=failed")
})

test("Bun, Deno, and project-local TypeScript mismatches all fail before execution", async () => {
  for (const [tool, overrides] of [
    ["bun", { bun: "0.0.1" }],
    ["deno", { deno: "deno 0.0.1" }],
    ["typescript", { typescript: "Version 0.0.1" }]
  ] as const) {
    let started = false
    const probes = probeVersions(overrides)
    await expect(
      runE2eRequest(
        "/repo",
        { kind: "scope", scope: "suites", processMode: "managed" },
        undefined,
        {
          definitions: [selectedDefinition(`${tool}-consumer`, [tool])],
          validatePlan: async () => {},
          createSupervisor: async () => testSupervisor(probes.runner),
          runtimeProbe: probes.dependencies,
          executeDefinition: async () => {
            started = true
            return result()
          },
          write: () => {}
        }
      )
    ).rejects.toThrow("prerequisite-version-mismatch")
    expect(started).toBe(false)
  }
})

test("fake PATH Node, Deno, and project-local TypeScript mismatches leave no consumer marker", async () => {
  for (const tool of ["node", "deno", "typescript"] as const) {
    await expectPathMismatch(tool)
  }
})
