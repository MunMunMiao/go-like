export type E2eScope = "suites" | "providers" | "runtimes" | "examples" | "published"
export type E2eScopeSelection = E2eScope | "all"
export type SuiteTag = "registered" | "provider" | "runtime" | "example" | "published"
export type RequiredTool = "bun" | "node" | "typescript" | "openssl" | "docker"
export type DockerOwnership = "none" | "suite" | "children-with-invocation-backstop"

export interface SuiteDefinition {
  readonly id: string
  readonly tags: readonly SuiteTag[]
  readonly defaultScopes: readonly E2eScope[]
  readonly includeInAll: boolean
  readonly explicitOnly?: boolean | undefined
  readonly cwd: string
  readonly command: readonly string[]
  readonly timeoutMs: number
  readonly requiredTools: readonly RequiredTool[]
  readonly requiresDocker: boolean
  readonly dockerOwnership: DockerOwnership
}

const RegisteredRuntimeTimeoutMs = 300_000
const PublishedTimeoutMs = 1_800_000

/** Sentinel metadata for the examples lane, which the executor dispatches in process. */
export const ExamplesInProcessCommand = Object.freeze(["internal:examples"] as const)

function definition(value: SuiteDefinition): SuiteDefinition {
  return Object.freeze({
    ...value,
    tags: Object.freeze(value.tags.slice()),
    defaultScopes: Object.freeze(value.defaultScopes.slice()),
    command: Object.freeze(value.command.slice()),
    requiredTools: Object.freeze(value.requiredTools.slice())
  })
}

function suite(
  id: string,
  cwd: string,
  command: readonly string[],
  timeoutMs: number,
  requiredTools: readonly RequiredTool[]
): SuiteDefinition {
  return definition({
    id,
    tags: ["registered"],
    defaultScopes: ["suites"],
    includeInAll: true,
    cwd,
    command,
    timeoutMs,
    requiredTools,
    requiresDocker: false,
    dockerOwnership: "none"
  })
}

function compatibilitySuite(
  id: string,
  cwd: string,
  command: readonly string[],
  timeoutMs: number,
  requiredTools: readonly RequiredTool[]
): SuiteDefinition {
  return definition({
    id,
    tags: ["registered"],
    defaultScopes: ["suites"],
    includeInAll: true,
    explicitOnly: true,
    cwd,
    command,
    timeoutMs,
    requiredTools,
    requiresDocker: false,
    dockerOwnership: "none"
  })
}

function provider(
  id: string,
  cwd: string,
  command: readonly string[],
  timeoutMs: number
): SuiteDefinition {
  return definition({
    id,
    tags: ["registered", "provider"],
    defaultScopes: ["suites", "providers"],
    includeInAll: true,
    cwd,
    command,
    timeoutMs,
    requiredTools: ["bun", "docker"],
    requiresDocker: true,
    dockerOwnership: "suite"
  })
}

function runtime(id: string, cwd: string, requiredTools: readonly RequiredTool[]): SuiteDefinition {
  return definition({
    id,
    tags: ["registered", "runtime"],
    defaultScopes: ["runtimes"],
    includeInAll: true,
    cwd,
    command: ["bun", "run", "test:e2e:runtimes"],
    timeoutMs: RegisteredRuntimeTimeoutMs,
    requiredTools,
    requiresDocker: false,
    dockerOwnership: "none"
  })
}

const Definitions: readonly SuiteDefinition[] = Object.freeze([
  suite("runner-process", ".", ["bun", "test", "--isolate", "e2e/runner-process.test.ts"], 30_000, [
    "bun"
  ]),
  suite("store-file-process", ".", ["bun", "e2e/scripts/store-file-process.ts"], 60_000, ["bun"]),
  compatibilitySuite(
    "vanilla-node",
    ".",
    ["bun", "e2e/scripts/web-framework-native.ts", "vanilla"],
    30_000,
    ["bun", "node"]
  ),
  compatibilitySuite(
    "hono-node",
    ".",
    ["bun", "e2e/scripts/web-framework-native.ts", "hono"],
    30_000,
    ["bun", "node"]
  ),
  compatibilitySuite(
    "elysia-node",
    ".",
    ["bun", "e2e/scripts/web-framework-native.ts", "elysia"],
    30_000,
    ["bun", "node"]
  ),
  compatibilitySuite("h3-node", ".", ["bun", "e2e/scripts/web-framework-native.ts", "h3"], 30_000, [
    "bun",
    "node"
  ]),
  suite("web-node-native", "packages/core", ["bun", "run", "test:e2e:web-native"], 60_000, [
    "bun",
    "node"
  ]),
  suite("web-bridge-dist", "packages/core", ["bun", "test/e2e/web-bridge-dist-e2e.ts"], 60_000, [
    "bun",
    "node"
  ]),
  suite(
    "transport-http-node",
    "packages/core",
    ["bun", "test/e2e/transport-http-run-node-e2e.ts"],
    60_000,
    ["bun", "node"]
  ),
  suite("cron-native", "packages/croner", ["bun", "run", "test:e2e"], 60_000, ["bun", "node"]),
  provider("bullmq-docker", "packages/bullmq", ["bun", "run", "test:e2e:job"], 180_000),
  provider("nats-core-docker", "packages/nats", ["bun", "run", "test:e2e:core"], 180_000),
  provider("nats-jetstream-docker", "packages/nats", ["bun", "run", "test:e2e:jetstream"], 180_000),
  provider("config-consul-docker", "packages/consul", ["bun", "run", "test:e2e:config"], 180_000),
  provider("config-etcd-docker", "packages/etcd", ["bun", "run", "test:e2e:config"], 180_000),
  provider("store-consul-docker", "packages/consul", ["bun", "run", "test:e2e:store"], 300_000),
  provider("store-etcd-docker", "packages/etcd", ["bun", "run", "test:e2e:store"], 240_000),
  provider(
    "registry-consul-docker",
    "packages/consul",
    ["bun", "run", "test:e2e:registry"],
    300_000
  ),
  provider("registry-etcd-docker", "packages/etcd", ["bun", "run", "test:e2e:registry"], 300_000),
  provider(
    "registry-kubernetes-docker",
    "packages/kubernetes",
    ["bun", "run", "test:e2e:registry"],
    420_000
  ),
  provider(
    "registry-zookeeper-docker",
    "packages/zookeeper",
    ["bun", "run", "test:e2e:registry"],
    420_000
  ),
  provider(
    "registry-transport-consul-docker",
    "packages/consul",
    ["bun", "run", "test:e2e:registry-transport"],
    180_000
  ),
  provider("registry-mdns-docker", "packages/mdns", ["bun", "run", "test:e2e:registry"], 240_000),
  provider("otel-docker", "packages/otel", ["bun", "run", "test:e2e:otel"], 300_000),
  provider(
    "broker-rabbitmq-docker",
    "packages/rabbitmq",
    ["bun", "run", "test:e2e:broker"],
    420_000
  ),
  provider("cache-redis-docker", "packages/redis", ["bun", "run", "test:e2e:cache"], 420_000),
  provider(
    "config-kubernetes-docker",
    "packages/kubernetes",
    ["bun", "run", "test:e2e:config"],
    420_000
  ),
  provider("config-vault-docker", "packages/vault", ["bun", "run", "test:e2e:config"], 300_000),
  provider("store-vault-docker", "packages/vault", ["bun", "run", "test:e2e:store"], 300_000),
  provider(
    "transport-http-node-security",
    "packages/core",
    ["bun", "run", "test:e2e:transport"],
    300_000
  ),
  suite("release-traceparent", ".", ["bun", "e2e/release/traceparent.ts"], 300_000, [
    "bun",
    "node"
  ]),
  provider("release-etcd-auth-docker", ".", ["bun", "e2e/release/etcd-auth-docker.ts"], 300_000),
  suite("release-dist-brands", ".", ["bun", "e2e/release/dist-brands.ts"], 120_000, ["bun"]),
  suite("release-binding-types", ".", ["bun", "e2e/release/binding-types.ts"], 180_000, ["bun"]),
  suite("release-disabled-cost", ".", ["bun", "e2e/release/disabled-cost.ts"], 300_000, [
    "bun",
    "node"
  ]),
  suite("release-dist-graph", ".", ["bun", "e2e/release/dist-graph.ts"], 120_000, ["bun"]),
  runtime("runtime-core", "packages/core", ["bun", "node"]),
  runtime("runtime-bullmq", "packages/bullmq", ["bun", "node"]),
  runtime("runtime-connectrpc", "packages/connectrpc", ["bun", "node"]),
  runtime("runtime-consul", "packages/consul", ["bun", "node"]),
  runtime("runtime-croner", "packages/croner", ["bun", "node"]),
  runtime("runtime-etcd", "packages/etcd", ["bun", "node"]),
  runtime("runtime-mdns", "packages/mdns", ["bun", "node"]),
  runtime("runtime-otel", "packages/otel", ["bun", "node"]),
  runtime("runtime-pino", "packages/pino", ["bun", "node"]),
  runtime("runtime-prometheus", "packages/prometheus", ["bun", "node"]),
  runtime("runtime-winston", "packages/winston", ["bun", "node"]),
  runtime("runtime-zookeeper", "packages/zookeeper", ["bun", "node"]),
  definition({
    id: "examples",
    tags: ["registered", "example"],
    defaultScopes: ["examples"],
    includeInAll: true,
    cwd: ".",
    command: ExamplesInProcessCommand,
    timeoutMs: 2_700_000,
    requiredTools: ["bun", "node", "docker"],
    requiresDocker: true,
    dockerOwnership: "children-with-invocation-backstop"
  }),
  definition({
    id: "published",
    tags: ["registered", "published"],
    defaultScopes: ["published"],
    includeInAll: true,
    cwd: ".",
    command: ["bun", "e2e/published.ts"],
    timeoutMs: PublishedTimeoutMs,
    requiredTools: ["bun", "node", "typescript", "openssl"],
    requiresDocker: false,
    dockerOwnership: "none"
  })
])

export function suiteDefinitions(): readonly SuiteDefinition[] {
  return Definitions
}

export function findSuiteDefinition(id: string): SuiteDefinition | undefined {
  return Definitions.find((candidate) => candidate.id === id)
}

export function registeredRuntimeDefinitions(): readonly SuiteDefinition[] {
  return Definitions.filter((candidate) => candidate.tags.includes("runtime"))
}
