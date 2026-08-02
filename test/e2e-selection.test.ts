import { expect, test } from "bun:test"

import {
  type E2eScope,
  type RequiredTool,
  type SuiteDefinition,
  suiteDefinitions
} from "../e2e/definitions"
import { parseE2eArguments, selectedSuites, selectExecutionPlan } from "../e2e/selection"

function synthetic(
  id: string,
  defaultScopes: readonly E2eScope[],
  options: {
    readonly includeInAll?: boolean
    readonly explicitOnly?: boolean
    readonly provider?: boolean
    readonly requiresDocker?: boolean
    readonly requiredTools?: readonly RequiredTool[]
  } = Object.freeze({})
): SuiteDefinition {
  return Object.freeze({
    id,
    tags: Object.freeze([
      "registered" as const,
      ...(options.provider === true ? (["provider"] as const) : [])
    ]),
    defaultScopes: Object.freeze(defaultScopes.slice()),
    includeInAll: options.includeInAll ?? true,
    explicitOnly: options.explicitOnly,
    cwd: ".",
    command: Object.freeze(["bun", id]),
    timeoutMs: 1_000,
    requiredTools: Object.freeze(
      options.requiredTools?.slice() ?? (["bun"] satisfies readonly RequiredTool[])
    ),
    requiresDocker: options.requiresDocker ?? false,
    dockerOwnership: options.requiresDocker === true ? "suite" : "none"
  })
}

const SyntheticDefinitions = Object.freeze([
  synthetic("suite-a", ["suites"]),
  synthetic("provider-without-docker", ["suites"], { provider: true }),
  synthetic("docker-without-provider", ["suites"], {
    requiresDocker: true,
    requiredTools: ["bun", "docker"]
  }),
  synthetic("runtime-a", ["runtimes"]),
  synthetic("example-a", ["examples"]),
  synthetic("published-a", ["published"]),
  synthetic("explicit-only", ["suites"], { explicitOnly: true })
])

test("scope selection uses explicit scope metadata and stable phase order", () => {
  expect(
    selectExecutionPlan(SyntheticDefinitions, {
      kind: "scope",
      scope: "providers",
      processMode: "managed"
    }).map((definition) => definition.id)
  ).toEqual(["provider-without-docker"])
  expect(
    selectExecutionPlan(SyntheticDefinitions, {
      kind: "scope",
      scope: "suites",
      processMode: "managed"
    }).map((definition) => definition.id)
  ).toEqual(["suite-a", "provider-without-docker", "docker-without-provider"])
  expect(
    selectExecutionPlan(SyntheticDefinitions, {
      kind: "scope",
      scope: "all",
      processMode: "managed"
    }).map((definition) => definition.id)
  ).not.toContain("explicit-only")
  expect(
    selectExecutionPlan(SyntheticDefinitions, {
      kind: "scope",
      scope: "all",
      processMode: "managed"
    }).map((definition) => definition.id)
  ).toEqual([
    "suite-a",
    "provider-without-docker",
    "docker-without-provider",
    "runtime-a",
    "example-a",
    "published-a"
  ])
})

test("explicit suites preserve first user order and can select explicit-only definitions", () => {
  const request = parseE2eArguments([
    "--suite",
    "h3-node",
    "--suite",
    "runner-process",
    "--suite",
    "h3-node"
  ])
  expect(request).toEqual({
    kind: "suites",
    ids: ["h3-node", "runner-process"],
    processMode: "managed"
  })
  expect(
    parseE2eArguments([
      "--require-platform-containment",
      "--suite",
      "h3-node",
      "--suite",
      "runner-process"
    ])
  ).toEqual({
    kind: "suites",
    ids: ["h3-node", "runner-process"],
    processMode: "platform-containment"
  })
  expect(parseE2eArguments(["--scope", "all", "--require-platform-containment"])).toEqual({
    kind: "scope",
    scope: "all",
    processMode: "platform-containment"
  })
  expect(selectedSuites(["--suite", "h3-node", "--suite", "runner-process"])).toEqual([
    "h3-node",
    "runner-process"
  ])
  expect(
    selectExecutionPlan(SyntheticDefinitions, {
      kind: "suites",
      ids: ["explicit-only"],
      processMode: "managed"
    }).map((definition) => definition.id)
  ).toEqual(["explicit-only"])
})

test("CLI rejects missing, unknown, repeated, and mutually exclusive selections", () => {
  expect(() => parseE2eArguments([])).toThrow("E2E requires --scope, --suite, or --help")
  expect(() => parseE2eArguments(["--scope"])).toThrow("--scope requires a value")
  expect(() => parseE2eArguments(["--scope", "missing"])).toThrow("unknown E2E scope missing")
  expect(() => parseE2eArguments(["--scope", "all", "--scope", "all"])).toThrow(
    "--scope may be provided only once"
  )
  expect(() => parseE2eArguments(["--scope", "all", "--suite", "runner-process"])).toThrow(
    "--scope and --suite are mutually exclusive"
  )
  expect(() => parseE2eArguments(["--suite"])).toThrow("--suite requires a value")
  expect(() => parseE2eArguments(["--suite", "missing"])).toThrow("unknown E2E suite missing")
  expect(() => parseE2eArguments(["--docker"])).toThrow("unknown E2E argument --docker")
  expect(() => parseE2eArguments(["--require-platform-containment"])).toThrow(
    "E2E selection is empty"
  )
  expect(() =>
    parseE2eArguments([
      "--scope",
      "all",
      "--require-platform-containment",
      "--require-platform-containment"
    ])
  ).toThrow("--require-platform-containment may be provided only once")
})

test("help must be used alone and selects no execution plan", () => {
  const help = parseE2eArguments(["--help"])
  expect(help).toEqual({ kind: "help" })
  expect(selectExecutionPlan(suiteDefinitions(), help)).toEqual([])
  expect(() => parseE2eArguments(["--help", "--scope", "all"])).toThrow("--help must be used alone")
})

test("production scopes retain framework package and examples ownership boundaries", () => {
  const definitions = suiteDefinitions()
  const suites = selectExecutionPlan(definitions, {
    kind: "scope",
    scope: "suites",
    processMode: "managed"
  }).map((definition) => definition.id)
  const all = selectExecutionPlan(definitions, {
    kind: "scope",
    scope: "all",
    processMode: "managed"
  }).map((definition) => definition.id)
  for (const id of [
    "web-bridge-dist",
    "hono-bridge-dist",
    "h3-bridge-dist",
    "elysia-bridge-dist"
  ]) {
    expect(suites.filter((selected) => selected === id)).toHaveLength(1)
    expect(all.filter((selected) => selected === id)).toHaveLength(1)
  }
  for (const id of ["vanilla-node", "hono-node", "h3-node", "elysia-node"]) {
    expect(suites).not.toContain(id)
    expect(all).not.toContain(id)
  }
  expect(suites).not.toContain("examples")
  expect(all.filter((id) => id === "examples")).toHaveLength(1)
  expect(all.at(-1)).toBe("published")
})
