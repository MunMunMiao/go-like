import { expect, test } from "bun:test"

import {
  type E2eScope,
  findSuiteDefinition,
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

test("production scopes retain Web package and examples ownership boundaries", () => {
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
  for (const id of ["web-bridge-dist"]) {
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

const RuntimeIds = Object.freeze([
  "runtime-core",
  "runtime-bullmq",
  "runtime-connectrpc",
  "runtime-consul",
  "runtime-croner",
  "runtime-etcd",
  "runtime-mdns",
  "runtime-otel",
  "runtime-pino",
  "runtime-prometheus",
  "runtime-winston",
  "runtime-zookeeper"
])

const ProviderPlans = Object.freeze([
  Object.freeze(["bullmq-docker", "packages/bullmq", "test:e2e:job"]),
  Object.freeze(["nats-core-docker", "packages/nats", "test:e2e:core"]),
  Object.freeze(["nats-jetstream-docker", "packages/nats", "test:e2e:jetstream"]),
  Object.freeze(["config-consul-docker", "packages/consul", "test:e2e:config"]),
  Object.freeze(["config-etcd-docker", "packages/etcd", "test:e2e:config"]),
  Object.freeze(["store-consul-docker", "packages/consul", "test:e2e:store"]),
  Object.freeze(["store-etcd-docker", "packages/etcd", "test:e2e:store"]),
  Object.freeze(["registry-consul-docker", "packages/consul", "test:e2e:registry"]),
  Object.freeze(["registry-etcd-docker", "packages/etcd", "test:e2e:registry"]),
  Object.freeze(["registry-kubernetes-docker", "packages/kubernetes", "test:e2e:registry"]),
  Object.freeze(["registry-zookeeper-docker", "packages/zookeeper", "test:e2e:registry"]),
  Object.freeze([
    "registry-transport-consul-docker",
    "packages/consul",
    "test:e2e:registry-transport"
  ]),
  Object.freeze(["registry-mdns-docker", "packages/mdns", "test:e2e:registry"]),
  Object.freeze(["otel-docker", "packages/otel", "test:e2e:otel"]),
  Object.freeze(["broker-rabbitmq-docker", "packages/rabbitmq", "test:e2e:broker"]),
  Object.freeze(["cache-redis-docker", "packages/redis", "test:e2e:cache"]),
  Object.freeze(["config-kubernetes-docker", "packages/kubernetes", "test:e2e:config"]),
  Object.freeze(["config-vault-docker", "packages/vault", "test:e2e:config"]),
  Object.freeze(["store-vault-docker", "packages/vault", "test:e2e:store"]),
  Object.freeze(["transport-http-node-security", "packages/core", "test:e2e:transport"])
])

const ReleaseGateIds: readonly string[] = Object.freeze([
  "release-traceparent",
  "release-etcd-auth-docker",
  "release-dist-brands",
  "release-binding-types",
  "release-disabled-cost",
  "release-dist-graph"
])

test("runtime, provider, and release-gate definitions stay pinned", async () => {
  const definitions = suiteDefinitions()
  const runtimes = definitions.filter((definition) => definition.tags.includes("runtime"))
  expect(runtimes).toHaveLength(12)
  expect(runtimes.map((definition) => definition.id)).toEqual([...RuntimeIds])
  for (const definition of runtimes) {
    expect(definition.command).toEqual(["bun", "run", "test:e2e:runtimes"])
    expect(definition.defaultScopes).toEqual(["runtimes"])
  }
  expect(
    selectExecutionPlan(definitions, {
      kind: "scope",
      scope: "runtimes",
      processMode: "managed"
    }).map((definition) => definition.id)
  ).toEqual([...RuntimeIds])

  const providers = definitions.filter((definition) => definition.tags.includes("provider"))
  const historical = providers.filter((definition) => !definition.id.startsWith("release-"))
  expect(historical).toHaveLength(20)
  expect(
    historical.map((definition) => [definition.id, definition.cwd, definition.command[2]])
  ).toEqual(ProviderPlans.map((plan) => [...plan]))
  for (const definition of historical) {
    expect(definition.command).toEqual(["bun", "run", definition.command[2] ?? ""])
    const manifest: { readonly scripts?: Readonly<Record<string, string>> } = await Bun.file(
      `${definition.cwd}/package.json`
    ).json()
    const scriptName = definition.command[2] ?? ""
    const script = manifest.scripts?.[scriptName]
    expect(script?.trim().length).toBeGreaterThan(0)
  }
  const providerSelection = selectExecutionPlan(definitions, {
    kind: "scope",
    scope: "providers",
    processMode: "managed"
  }).map((definition) => definition.id)
  expect(providerSelection.filter((id) => !id.startsWith("release-"))).toEqual(
    ProviderPlans.map((plan) => plan[0] ?? "")
  )
  expect(providerSelection).toContain("release-etcd-auth-docker")

  expect(definitions.filter((definition) => ReleaseGateIds.includes(definition.id))).toHaveLength(6)
  expect(findSuiteDefinition("release-traceparent")).toMatchObject({
    cwd: ".",
    command: ["bun", "e2e/release/traceparent.ts"],
    defaultScopes: ["suites"],
    requiredTools: ["bun", "node"],
    requiresDocker: false,
    dockerOwnership: "none"
  })
  expect(findSuiteDefinition("release-etcd-auth-docker")).toMatchObject({
    tags: ["registered", "provider"],
    cwd: ".",
    command: ["bun", "e2e/release/etcd-auth-docker.ts"],
    defaultScopes: ["suites", "providers"],
    requiredTools: ["bun", "docker"],
    requiresDocker: true,
    dockerOwnership: "suite"
  })
  expect(findSuiteDefinition("release-dist-brands")).toMatchObject({
    cwd: ".",
    command: ["bun", "e2e/release/dist-brands.ts"],
    defaultScopes: ["suites"],
    requiredTools: ["bun"],
    requiresDocker: false,
    dockerOwnership: "none"
  })
  expect(findSuiteDefinition("release-binding-types")).toMatchObject({
    cwd: ".",
    command: ["bun", "e2e/release/binding-types.ts"],
    defaultScopes: ["suites"],
    requiredTools: ["bun"],
    requiresDocker: false,
    dockerOwnership: "none"
  })
  expect(findSuiteDefinition("release-disabled-cost")).toMatchObject({
    cwd: ".",
    command: ["bun", "e2e/release/disabled-cost.ts"],
    defaultScopes: ["suites"],
    requiredTools: ["bun", "node"],
    requiresDocker: false,
    dockerOwnership: "none"
  })
  expect(findSuiteDefinition("release-dist-graph")).toMatchObject({
    cwd: ".",
    command: ["bun", "e2e/release/dist-graph.ts"],
    defaultScopes: ["suites"],
    requiredTools: ["bun"],
    requiresDocker: false,
    dockerOwnership: "none"
  })
  const suites = selectExecutionPlan(definitions, {
    kind: "scope",
    scope: "suites",
    processMode: "managed"
  }).map((definition) => definition.id)
  for (const id of ReleaseGateIds)
    expect(suites.filter((selected) => selected === id)).toHaveLength(1)
})
