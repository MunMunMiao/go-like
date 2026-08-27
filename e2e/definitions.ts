export type E2eScope = "suites" | "providers" | "runtimes" | "examples" | "published"
export type E2eScopeSelection = E2eScope | "all"
export type SuiteTag = "registered" | "provider" | "runtime" | "example" | "published"
export type RequiredTool = "bun" | "node" | "deno" | "typescript" | "docker"
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
  suite(
    "runner-process",
    ".",
    ["bun", "test", "--isolate", "--no-orphans", "e2e/runner-process.test.ts"],
    30_000,
    ["bun"]
  ),
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
  suite("web-node-native", "packages/web", ["bun", "run", "test:e2e"], 60_000, ["bun", "node"]),
  suite("web-bridge-dist", "packages/web", ["bun", "run", "test:e2e:bridge-dist"], 60_000, [
    "bun",
    "node"
  ]),
  suite("transport-http-node", "packages/transport/http", ["bun", "run", "test:e2e"], 60_000, [
    "bun",
    "node"
  ]),
  suite("cron-native", "packages/croner", ["bun", "run", "test:e2e"], 60_000, ["bun", "node"]),
  provider("bullmq-docker", "packages/bullmq", ["bun", "run", "test:e2e"], 180_000),
  provider("nats-core-docker", "packages/nats", ["bun", "run", "test:e2e:core"], 180_000),
  provider("nats-jetstream-docker", "packages/nats", ["bun", "run", "test:e2e:jetstream"], 180_000),
  provider("config-consul-docker", "packages/config/consul", ["bun", "run", "test:e2e"], 180_000),
  provider("config-etcd-docker", "packages/config/etcd", ["bun", "run", "test:e2e"], 180_000),
  provider("store-consul-docker", "packages/store/consul", ["bun", "run", "test:e2e"], 300_000),
  provider("store-etcd-docker", "packages/store/etcd", ["bun", "run", "test:e2e"], 240_000),
  provider(
    "registry-consul-docker",
    "packages/registry/consul",
    ["bun", "run", "test:e2e"],
    300_000
  ),
  provider("registry-etcd-docker", "packages/registry/etcd", ["bun", "run", "test:e2e"], 300_000),
  provider(
    "registry-kubernetes-docker",
    "packages/registry/kubernetes",
    ["bun", "run", "test:e2e"],
    420_000
  ),
  provider(
    "registry-zookeeper-docker",
    "packages/registry/zookeeper",
    ["bun", "run", "test:e2e"],
    420_000
  ),
  provider(
    "registry-transport-consul-docker",
    ".",
    ["bun", "e2e/scripts/registry-transport-consul-docker.ts"],
    180_000
  ),
  provider("registry-mdns-docker", "packages/registry/mdns", ["bun", "run", "test:e2e"], 240_000),
  provider("otel-docker", "packages/otel", ["bun", "run", "test:e2e"], 300_000),
  provider(
    "broker-rabbitmq-docker",
    "packages/broker/rabbitmq",
    ["bun", "run", "test:e2e"],
    420_000
  ),
  provider("cache-redis-docker", "packages/cache/redis", ["bun", "run", "test:e2e"], 420_000),
  provider(
    "config-kubernetes-docker",
    "packages/config/kubernetes",
    ["bun", "run", "test:e2e"],
    420_000
  ),
  provider("config-vault-docker", "packages/config/vault", ["bun", "run", "test:e2e"], 300_000),
  provider("store-vault-docker", "packages/store/vault", ["bun", "run", "test:e2e"], 300_000),
  provider(
    "transport-http-node-security",
    "packages/transport/http",
    ["bun", "run", "test:e2e:node-security"],
    300_000
  ),
  runtime("runtime-bullmq", "packages/bullmq", ["bun", "node"]),
  runtime("runtime-config", "packages/config", ["bun", "node", "deno"]),
  runtime("runtime-config-consul", "packages/config/consul", ["bun", "node", "deno"]),
  runtime("runtime-context", "packages/context", ["bun", "node", "deno"]),
  runtime("runtime-core", "packages/core", ["bun", "node", "deno"]),
  runtime("runtime-croner", "packages/croner", ["bun", "node", "deno"]),
  runtime("runtime-health", "packages/health", ["bun", "node", "deno"]),
  runtime("runtime-metadata", "packages/metadata", ["bun", "node", "deno"]),
  runtime("runtime-otel", "packages/otel", ["bun", "node"]),
  runtime("runtime-pino", "packages/pino", ["bun", "node"]),
  runtime("runtime-prometheus", "packages/prometheus", ["bun", "node"]),
  runtime("runtime-registry-consul", "packages/registry/consul", ["bun", "node", "deno"]),
  runtime("runtime-registry-etcd", "packages/registry/etcd", ["bun", "node", "deno"]),
  runtime("runtime-registry-mdns", "packages/registry/mdns", ["bun", "node", "deno"]),
  runtime("runtime-registry-zookeeper", "packages/registry/zookeeper", ["bun", "node"]),
  runtime("runtime-resilience", "packages/resilience", ["bun", "node", "deno"]),
  runtime("runtime-store-etcd", "packages/store/etcd", ["bun", "node", "deno"]),
  runtime("runtime-struct", "packages/struct", ["bun", "node", "deno"]),
  runtime("runtime-transport", "packages/transport", ["bun", "node", "deno"]),
  runtime("runtime-transport-http", "packages/transport/http", ["bun", "node", "deno"]),
  runtime("runtime-transport-memory", "packages/transport/memory", ["bun", "node", "deno"]),
  runtime("runtime-web", "packages/web", ["bun", "node", "deno"]),
  runtime("runtime-winston", "packages/winston", ["bun", "node"]),
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
    requiredTools: ["bun", "node", "deno", "typescript"],
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
