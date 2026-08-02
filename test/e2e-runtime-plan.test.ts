import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"

import {
  ExamplesInProcessCommand,
  findSuiteDefinition,
  registeredRuntimeDefinitions,
  suiteDefinitions,
  type SuiteDefinition
} from "../e2e/definitions"
import { ExamplesCoordinatorReserveMs, type ExamplesRunResult } from "../e2e/examples"
import {
  runDefinition,
  runE2eRequest,
  validateExecutionPlan,
  validateRegisteredRuntimeDefinition
} from "../e2e/executor"
import { createProcessSupervisor, runCommand, type CommandResult } from "../e2e/harness/process"
import { createTempDirectory, removeTempDirectory } from "../e2e/harness/temp"
import { RequiredRuntimeVersions } from "../e2e/runtime-versions"

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

function successfulExamplesResult(
  overrides: Partial<ExamplesRunResult> = Object.freeze({})
): ExamplesRunResult {
  const command = successfulResult()
  return Object.freeze({
    ...command,
    status: "passed",
    invocation: "examples-test-invocation",
    examples: Object.freeze([]),
    completeness: Object.freeze({
      executionInputIds: Object.freeze([]),
      participantIds: Object.freeze([]),
      resultIds: Object.freeze([]),
      completedCommandIds: Object.freeze([]),
      missingParticipantIds: Object.freeze([]),
      unexpectedParticipantIds: Object.freeze([]),
      duplicateParticipantIds: Object.freeze([]),
      missingResultIds: Object.freeze([]),
      unexpectedResultIds: Object.freeze([]),
      duplicateResultIds: Object.freeze([]),
      missingCompletedCommandIds: Object.freeze([]),
      unexpectedCompletedCommandIds: Object.freeze([])
    }),
    executionInputIds: Object.freeze([]),
    participantIds: Object.freeze([]),
    resultIds: Object.freeze([]),
    completedCommandIds: Object.freeze([]),
    registeredChildOwners: Object.freeze([]),
    failures: Object.freeze([]),
    ...overrides
  })
}

function successfulOneExampleResult(): ExamplesRunResult {
  const invocation = "examples-test-invocation"
  const owner = "alpha-test-owner"
  const input = Object.freeze({
    id: "alpha",
    packageName: "@likego/example-alpha",
    cwdRealpath: "/repo/examples/alpha",
    scriptName: "test:e2e" as const
  })
  const command = successfulResult()
  return successfulExamplesResult({
    examples: Object.freeze([
      Object.freeze({
        id: input.id,
        input,
        classification: "passed" as const,
        wrapperEntered: true,
        command,
        participant: Object.freeze({
          schemaVersion: 1 as const,
          id: input.id,
          packageName: input.packageName,
          cwdRealpath: input.cwdRealpath,
          workerPid: 12_345,
          workerStartIdentity: "fixture-worker-start",
          childOwner: owner,
          parentInvocation: invocation,
          startedAt: "2026-07-31T05:00:00.000Z"
        }),
        result: Object.freeze({
          schemaVersion: 1 as const,
          id: input.id,
          durationMs: 1,
          exitCode: 0,
          signal: null,
          timedOut: false,
          aborted: false,
          abortReason: null,
          cleanupFailures: Object.freeze([]),
          childOwner: owner,
          status: "passed" as const
        }),
        registration: Object.freeze({
          schemaVersion: 1 as const,
          invocation,
          capabilityDigest: "ab".repeat(32),
          id: input.id,
          packageName: input.packageName,
          cwdRealpath: input.cwdRealpath,
          workerPid: 12_345,
          workerStartIdentity: "fixture-worker-start",
          childOwner: owner,
          requestId: "fixture-registration-request",
          registeredAt: "2026-07-31T05:00:00.000Z"
        }),
        acknowledged: true,
        gracefulRequested: false,
        failures: Object.freeze([])
      })
    ]),
    completeness: Object.freeze({
      executionInputIds: Object.freeze([input.id]),
      participantIds: Object.freeze([input.id]),
      resultIds: Object.freeze([input.id]),
      completedCommandIds: Object.freeze([input.id]),
      missingParticipantIds: Object.freeze([]),
      unexpectedParticipantIds: Object.freeze([]),
      duplicateParticipantIds: Object.freeze([]),
      missingResultIds: Object.freeze([]),
      unexpectedResultIds: Object.freeze([]),
      duplicateResultIds: Object.freeze([]),
      missingCompletedCommandIds: Object.freeze([]),
      unexpectedCompletedCommandIds: Object.freeze([])
    }),
    executionInputIds: Object.freeze([input.id]),
    participantIds: Object.freeze([input.id]),
    resultIds: Object.freeze([input.id]),
    completedCommandIds: Object.freeze([input.id]),
    registeredChildOwners: Object.freeze([owner])
  })
}

function runtimeDefinition(cwd: string): SuiteDefinition {
  return Object.freeze({
    id: "runtime-fixture",
    tags: Object.freeze(["registered", "runtime"] as const),
    defaultScopes: Object.freeze(["runtimes"] as const),
    includeInAll: true,
    cwd,
    command: Object.freeze(["bun", "run", "test:e2e:runtimes"]),
    timeoutMs: 10_000,
    requiredTools: Object.freeze(["bun"] as const),
    requiresDocker: false,
    dockerOwnership: "none"
  })
}

async function withRuntimeFixture(
  manifest: unknown,
  run: (root: string, definition: SuiteDefinition) => Promise<void>
): Promise<void> {
  const directory = await createTempDirectory("likego-runtime-plan-")
  const cwd = join(directory.path, "package")
  try {
    await mkdir(cwd)
    await Bun.write(join(cwd, "package.json"), JSON.stringify(manifest))
    await run(directory.path, runtimeDefinition("package"))
  } finally {
    await removeTempDirectory(directory)
  }
}

test("every registered runtime definition validates its current manifest contract", async () => {
  for (const definition of registeredRuntimeDefinitions()) {
    await validateRegisteredRuntimeDefinition(process.cwd(), definition)
  }
})

test("registered runtime validation fails for missing cwd, invalid manifest, and missing script", async () => {
  await expect(
    validateRegisteredRuntimeDefinition(process.cwd(), runtimeDefinition("missing-runtime-cwd"))
  ).rejects.toThrow("cwd is unavailable")
  await withRuntimeFixture([], async (root, definition) => {
    await expect(validateRegisteredRuntimeDefinition(root, definition)).rejects.toThrow(
      "manifest root is not an object"
    )
  })
  await withRuntimeFixture({ scripts: {} }, async (root, definition) => {
    await expect(validateRegisteredRuntimeDefinition(root, definition)).rejects.toThrow(
      "has no non-empty test:e2e:runtimes script"
    )
  })
  await withRuntimeFixture(
    { scripts: { "test:e2e:runtimes": "   " } },
    async (root, definition) => {
      await expect(validateRegisteredRuntimeDefinition(root, definition)).rejects.toThrow(
        "has no non-empty test:e2e:runtimes script"
      )
    }
  )
})

test("runtime definitions execute fixed argv and do not parse manifest script text", async () => {
  await withRuntimeFixture(
    { scripts: { "test:e2e:runtimes": "echo manifest-text-must-not-be-parsed" } },
    async (root, definition) => {
      await validateRegisteredRuntimeDefinition(root, definition)
      expect(definition.command).toEqual(["bun", "run", "test:e2e:runtimes"])
      expect(definition.command.join(" ")).not.toContain("manifest-text")
    }
  )
})

test("registered runtime command nonzero propagates as the selected definition failure", async () => {
  await withRuntimeFixture(
    { scripts: { "test:e2e:runtimes": "bun -e 'process.exit(23)'" } },
    async (root, definition) => {
      await validateRegisteredRuntimeDefinition(root, definition)
      const supervisor = await createProcessSupervisor("managed", root, {
        run: runCommand,
        compileNativeHelper: async () => "/synthetic/native-helper"
      })
      try {
        await supervisor.preflight()
        await expect(runDefinition(root, definition, supervisor)).rejects.toThrow(
          "runtime-fixture exited 23"
        )
      } finally {
        await supervisor.close()
      }
    }
  )
})

test("the production execution plan has no implicit build, root lane recursion, or if-present", () => {
  for (const definition of suiteDefinitions()) {
    const command = definition.command.join(" ")
    expect(command).not.toContain("bun run build")
    expect(command).not.toContain("--if-present")
    if (definition.cwd === ".") {
      expect(command).not.toMatch(
        /bun run test:e2e:(?:suites|providers|runtimes|examples|published)$/u
      )
    }
  }
})

test("examples definition is the only in-process child-owned lane", async () => {
  const examples = findSuiteDefinition("examples")
  if (examples === undefined) throw new Error("examples definition is unavailable")
  expect(examples.command).toEqual(ExamplesInProcessCommand)
  expect(examples.dockerOwnership).toBe("children-with-invocation-backstop")
  expect(examples.requiresDocker).toBe(true)
  expect(
    suiteDefinitions().filter(
      (definition) => definition.dockerOwnership === "children-with-invocation-backstop"
    )
  ).toEqual([examples])
  await expect(validateExecutionPlan(process.cwd(), suiteDefinitions())).resolves.toBeUndefined()
})

test("examples dispatches in process without a legacy owner while suite ownership is unchanged", async () => {
  const examples = findSuiteDefinition("examples")
  if (examples === undefined) throw new Error("examples definition is unavailable")
  const commandDefinitions: unknown[] = []
  const supervisor = Object.freeze({
    mode: "managed" as const,
    async preflight() {
      return Object.freeze({
        processMode: "managed" as const,
        strategy: "posix-anchored-best-effort" as const,
        containment: "not-claimed" as const,
        cgroupV2: "n/a" as const
      })
    },
    async run(_root: string, definition: unknown) {
      commandDefinitions.push(definition)
      return successfulResult()
    },
    async close() {}
  })
  let examplesCalls = 0
  const definitionStartedAt = 12_345
  let monotonicReads = 0
  await expect(
    runDefinition("/repo", examples, supervisor, undefined, {
      monotonicNow: () => {
        monotonicReads += 1
        return definitionStartedAt
      },
      runExamples: async (root, options) => {
        examplesCalls += 1
        expect(root).toBe("/repo")
        expect(options.supervisor).toBe(supervisor)
        expect(options.processMode).toBe("managed")
        expect(options.timeoutMs).toBe(examples.timeoutMs - ExamplesCoordinatorReserveMs)
        expect(options.deadline).toBe(definitionStartedAt + examples.timeoutMs)
        return successfulExamplesResult()
      }
    })
  ).resolves.toMatchObject({ exitCode: 0 })
  expect(monotonicReads).toBe(2)
  expect(examplesCalls).toBe(1)
  expect(commandDefinitions).toEqual([])

  const suiteOwned: SuiteDefinition = Object.freeze({
    ...runtimeDefinition("."),
    id: "suite-owned",
    tags: Object.freeze(["registered"] as const),
    defaultScopes: Object.freeze(["suites"] as const),
    timeoutMs: 60_000,
    requiredTools: Object.freeze(["bun", "docker"] as const),
    requiresDocker: true,
    dockerOwnership: "suite"
  })
  await runDefinition("/repo", suiteOwned, supervisor)
  expect(commandDefinitions[0]).toMatchObject({
    environment: { LIKEGO_E2E_OWNER: expect.stringMatching(/^suite-owned-/u) }
  })
  expect(
    commandDefinitions
      .slice(1)
      .some((definition) =>
        String(
          (definition as { readonly command?: readonly string[] }).command?.join(" ")
        ).includes("label=io.likego.e2e.owner=suite-owned-")
      )
  ).toBe(true)
})

test("examples completeness is reported on both pass and failure", async () => {
  const examples = findSuiteDefinition("examples")
  if (examples === undefined) throw new Error("examples definition is unavailable")
  const logs: string[] = []
  const supervisor = Object.freeze({
    mode: "managed" as const,
    async preflight() {
      return Object.freeze({
        processMode: "managed" as const,
        strategy: "posix-anchored-best-effort" as const,
        containment: "not-claimed" as const,
        cgroupV2: "n/a" as const
      })
    },
    async run(_root: string, definition: { readonly command: readonly string[] }) {
      const executable = definition.command[0]
      return Object.freeze({
        ...successfulResult(),
        stdout:
          executable === "node"
            ? `v${RequiredRuntimeVersions.node}`
            : executable === "docker"
              ? "28.0.0"
              : ""
      })
    },
    async close() {}
  })
  const invocation = "examples-test-invocation"
  const owner = "alpha-test-owner"
  const input = Object.freeze({
    id: "alpha",
    packageName: "@likego/example-alpha",
    cwdRealpath: "/repo/examples/alpha",
    scriptName: "test:e2e" as const
  })
  const childCommand = Object.freeze({
    ...successfulResult(),
    exitCode: null,
    signal: "SIGKILL",
    termination: "signal" as const
  })
  const failure = Object.freeze({
    code: "example-registered-but-unreported",
    category: "primary" as const,
    summary: "registered-but-unreported"
  })
  const failed = successfulExamplesResult({
    status: "failed",
    exitCode: 1,
    invocation,
    examples: Object.freeze([
      Object.freeze({
        id: "alpha",
        input,
        classification: "registered-but-unreported",
        wrapperEntered: true,
        command: childCommand,
        participant: Object.freeze({
          schemaVersion: 1,
          id: "alpha",
          packageName: input.packageName,
          cwdRealpath: input.cwdRealpath,
          workerPid: 12_345,
          workerStartIdentity: "fixture-worker-start",
          childOwner: owner,
          parentInvocation: invocation,
          startedAt: "2026-07-31T05:00:00.000Z"
        }),
        result: null,
        registration: Object.freeze({
          schemaVersion: 1,
          invocation,
          capabilityDigest: "ab".repeat(32),
          id: "alpha",
          packageName: input.packageName,
          cwdRealpath: input.cwdRealpath,
          workerPid: 12_345,
          workerStartIdentity: "fixture-worker-start",
          childOwner: owner,
          requestId: "fixture-registration-request",
          registeredAt: "2026-07-31T05:00:00.000Z"
        }),
        acknowledged: true,
        gracefulRequested: false,
        failures: Object.freeze([failure])
      })
    ]),
    completeness: Object.freeze({
      executionInputIds: Object.freeze(["alpha"]),
      participantIds: Object.freeze(["alpha"]),
      resultIds: Object.freeze([]),
      completedCommandIds: Object.freeze(["alpha"]),
      missingParticipantIds: Object.freeze([]),
      unexpectedParticipantIds: Object.freeze([]),
      duplicateParticipantIds: Object.freeze([]),
      missingResultIds: Object.freeze(["alpha"]),
      unexpectedResultIds: Object.freeze([]),
      duplicateResultIds: Object.freeze([]),
      missingCompletedCommandIds: Object.freeze([]),
      unexpectedCompletedCommandIds: Object.freeze([])
    }),
    executionInputIds: Object.freeze(["alpha"]),
    participantIds: Object.freeze(["alpha"]),
    resultIds: Object.freeze([]),
    completedCommandIds: Object.freeze(["alpha"]),
    registeredChildOwners: Object.freeze([owner]),
    failures: Object.freeze([failure])
  })
  await expect(
    runE2eRequest(
      "/repo",
      { kind: "scope", scope: "examples", processMode: "managed" },
      undefined,
      {
        definitions: [examples],
        validatePlan: async () => {},
        createSupervisor: async () => supervisor,
        runtimeProbe: {
          bunVersion: () => Bun.version
        },
        runExamples: async () => failed,
        write: (value) => logs.push(value)
      }
    )
  ).rejects.toThrow("examples exited 1")
  const output = logs.join("")
  expect(output).toContain("[e2e:example] INPUT alpha")
  expect(output).toContain(
    "[e2e:example] UNREPORTED alpha classification=registered-but-unreported commandTermination=signal exitCode=null signal=SIGKILL timedOut=false failures=example-registered-but-unreported/primary: registered-but-unreported"
  )
  expect(output).toContain(
    "[e2e:example:failure] code=example-registered-but-unreported category=primary summary=registered-but-unreported"
  )
  expect(output).toContain("selected=1 participants=1 results=0 completed=1 passed=0 failed=1")
})

test("child-owned examples fail closed for a plain or malformed aggregate result", async () => {
  const examples = findSuiteDefinition("examples")
  if (examples === undefined) throw new Error("examples definition is unavailable")
  const supervisor = Object.freeze({
    mode: "managed" as const,
    async preflight() {
      return Object.freeze({
        processMode: "managed" as const,
        strategy: "posix-anchored-best-effort" as const,
        containment: "not-claimed" as const,
        cgroupV2: "n/a" as const
      })
    },
    async run() {
      return successfulResult()
    },
    async close() {}
  })

  await expect(
    runDefinition("/repo", examples, supervisor, undefined, {
      runExamples: async () => successfulResult() as ExamplesRunResult
    })
  ).rejects.toThrow("invalid aggregate result")
  await expect(
    runDefinition("/repo", examples, supervisor, undefined, {
      runExamples: async () =>
        successfulExamplesResult({ examples: Object.freeze([null]) as never })
    })
  ).rejects.toThrow("invalid aggregate result")

  const valid = successfulOneExampleResult()
  await expect(
    runDefinition("/repo", examples, supervisor, undefined, {
      runExamples: async () => ({
        ...valid,
        completeness: {
          ...valid.completeness,
          resultIds: Object.freeze([]),
          missingResultIds: Object.freeze(["alpha"])
        },
        resultIds: Object.freeze([])
      })
    })
  ).rejects.toThrow("invalid aggregate result")

  await expect(
    runDefinition("/repo", examples, supervisor, undefined, {
      runExamples: async () =>
        ({
          ...valid,
          examples: valid.examples.map((record) => ({
            ...record,
            participant: null,
            result: null,
            registration: null,
            wrapperEntered: false,
            acknowledged: false,
            command: null
          })),
          completeness: {
            ...valid.completeness,
            participantIds: Object.freeze([]),
            resultIds: Object.freeze([]),
            completedCommandIds: Object.freeze([]),
            missingParticipantIds: Object.freeze(["alpha"]),
            missingResultIds: Object.freeze(["alpha"]),
            missingCompletedCommandIds: Object.freeze(["alpha"])
          },
          participantIds: Object.freeze([]),
          resultIds: Object.freeze([]),
          completedCommandIds: Object.freeze([]),
          registeredChildOwners: Object.freeze([])
        }) as ExamplesRunResult
    })
  ).rejects.toThrow("invalid aggregate result")
})

test("generic definition injection cannot intercept child-owned examples", async () => {
  const examples = findSuiteDefinition("examples")
  if (examples === undefined) throw new Error("examples definition is unavailable")
  let genericCalls = 0
  let examplesCalls = 0
  const supervisor = Object.freeze({
    mode: "managed" as const,
    async preflight() {
      return Object.freeze({
        processMode: "managed" as const,
        strategy: "posix-anchored-best-effort" as const,
        containment: "not-claimed" as const,
        cgroupV2: "n/a" as const
      })
    },
    async run(_root: string, definition: { readonly command: readonly string[] }) {
      return Object.freeze({
        ...successfulResult(),
        stdout:
          definition.command[0] === "node"
            ? `v${RequiredRuntimeVersions.node}`
            : definition.command[0] === "docker"
              ? "29.6.2"
              : ""
      })
    },
    async close() {}
  })
  await runE2eRequest(
    "/repo",
    { kind: "scope", scope: "examples", processMode: "managed" },
    undefined,
    {
      definitions: [examples],
      validatePlan: async () => {},
      createSupervisor: async () => supervisor,
      runtimeProbe: { bunVersion: () => Bun.version },
      executeDefinition: async () => {
        genericCalls += 1
        return successfulResult()
      },
      runExamples: async () => {
        examplesCalls += 1
        return successfulExamplesResult()
      },
      write: () => {}
    }
  )
  expect(genericCalls).toBe(0)
  expect(examplesCalls).toBe(1)
})

test("root public E2E scripts preserve single-build scope contracts", async () => {
  const manifest = await Bun.file("package.json").json()
  expect(manifest.scripts).toMatchObject({
    "test:e2e:suites": "bun run build && bun e2e/run.ts --scope suites",
    "test:e2e:providers": "bun run build && bun e2e/run.ts --scope providers",
    "test:e2e:runtimes": "bun run build && bun e2e/run.ts --scope runtimes",
    "test:e2e:examples": "bun run build && bun e2e/run.ts --scope examples",
    "test:e2e:published": "bun run build && bun e2e/run.ts --scope published",
    "test:e2e": "bun run build && bun e2e/run.ts --scope all"
  })
  expect(manifest.scripts["test:e2e"]).not.toContain("--if-present")
})

test("the complete selected plan is validated before the first definition starts", async () => {
  const first: SuiteDefinition = Object.freeze({
    ...runtimeDefinition("."),
    id: "first",
    tags: Object.freeze(["registered"] as const),
    defaultScopes: Object.freeze(["suites"] as const)
  })
  const second: SuiteDefinition = Object.freeze({
    ...first,
    id: "second"
  })
  let started = 0
  await expect(
    runE2eRequest("/repo", { kind: "scope", scope: "suites", processMode: "managed" }, undefined, {
      definitions: [first, second],
      validatePlan: async (_root, selected) => {
        expect(selected.map((definition) => definition.id)).toEqual(["first", "second"])
        throw new Error("synthetic validation failure")
      },
      runtimeProbe: {
        bunVersion: () => RequiredRuntimeVersions.bun
      },
      executeDefinition: async () => {
        started += 1
        return successfulResult()
      },
      write: () => {}
    })
  ).rejects.toThrow("synthetic validation failure")
  expect(started).toBe(0)
})

test("an abort between definitions preserves summary count conservation", async () => {
  const controller = new AbortController()
  const logs: string[] = []
  const first: SuiteDefinition = Object.freeze({
    ...runtimeDefinition("."),
    id: "first",
    tags: Object.freeze(["registered"] as const),
    defaultScopes: Object.freeze(["suites"] as const)
  })
  const second: SuiteDefinition = Object.freeze({ ...first, id: "second" })
  let started = 0
  await expect(
    runE2eRequest(
      "/repo",
      { kind: "scope", scope: "suites", processMode: "managed" },
      controller.signal,
      {
        definitions: [first, second],
        validatePlan: async () => {},
        createSupervisor: async () =>
          await createProcessSupervisor("managed", "/repo", {
            compileNativeHelper: async () => "/synthetic/native-helper"
          }),
        runtimeProbe: {
          bunVersion: () => RequiredRuntimeVersions.bun
        },
        executeDefinition: async () => {
          started += 1
          controller.abort(new Error("synthetic between-definition abort"))
          return successfulResult()
        },
        write: (value) => logs.push(value)
      }
    )
  ).rejects.toThrow("synthetic between-definition abort")
  expect(started).toBe(1)
  expect(logs.join("")).toContain("selected=2 started=1 passed=1 failed=0 notRun=1")
  expect(logs.join("")).toContain(
    "termination=exit=1,signal=0,timeout=0,abort=0,supervisor-error=0"
  )
  expect(logs.join("")).toContain("status=failed")
})

test("execution-plan validation rejects empty plans, duplicate IDs, and inconsistent metadata", async () => {
  const directory = await createTempDirectory("likego-runtime-validation-")
  try {
    await expect(validateExecutionPlan(directory.path, [])).rejects.toThrow(
      "execution plan is empty"
    )
    const duplicate = runtimeDefinition(".")
    await expect(validateExecutionPlan(directory.path, [duplicate, duplicate])).rejects.toThrow(
      "duplicate suite id"
    )
    const inconsistent = Object.freeze({
      ...duplicate,
      id: "inconsistent",
      tags: Object.freeze(["registered"] as const),
      requiredTools: Object.freeze(["bun", "docker"] as const),
      requiresDocker: false
    })
    await expect(validateExecutionPlan(directory.path, [inconsistent])).rejects.toThrow(
      "Docker requirement metadata is inconsistent"
    )
    const unauthorizedChildren = Object.freeze({
      ...duplicate,
      id: "not-examples",
      tags: Object.freeze(["registered"] as const),
      command: ExamplesInProcessCommand,
      requiredTools: Object.freeze(["bun", "docker"] as const),
      requiresDocker: true,
      dockerOwnership: "children-with-invocation-backstop" as const
    })
    const examplesIdWithCommandLane = Object.freeze({
      ...duplicate,
      id: "examples",
      tags: Object.freeze(["registered", "example"] as const),
      defaultScopes: Object.freeze(["examples"] as const)
    })
    const sentinelWithSuiteOwnership = Object.freeze({
      ...duplicate,
      id: "not-examples",
      tags: Object.freeze(["registered"] as const),
      command: ExamplesInProcessCommand
    })
    for (const definition of [
      unauthorizedChildren,
      examplesIdWithCommandLane,
      sentinelWithSuiteOwnership
    ]) {
      await expect(validateExecutionPlan(directory.path, [definition])).rejects.toThrow(
        "must satisfy examples id, in-process command, and child Docker ownership together"
      )
    }
  } finally {
    await removeTempDirectory(directory)
  }
})
