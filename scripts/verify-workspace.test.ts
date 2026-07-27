import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { verifyBunRuntime, verifyExampleProgram, verifyWorkspace } from "./verify-workspace"
import { discoverWorkspaces } from "../tools/workspaces/discovery"

const Roots: string[] = []
const RootScripts = {
  changeset: "changeset",
  "version:packages": "changeset version && bun update --filter '*'",
  release: "bun scripts/release-preflight.cli.ts && bun run verify && changeset publish",
  fmt: "oxfmt .",
  "fmt:check": "oxfmt --check .",
  "doc:dev": "vitepress dev doc",
  "doc:build": "vitepress build doc",
  "doc:preview": "vitepress preview doc",
  "verify:doc": "bun test test/doc-site.test.ts && bun run doc:build",
  audit: "bun audit",
  "clean:generated": "bun scripts/clean-generated.cli.ts",
  build:
    "bun run clean:generated && bun run build:packages && bun run verify:dist && bun run build:stamp",
  "build:packages": "bun run --filter './packages/**' --sequential --if-present build",
  "build:stamp": "bun scripts/published/build-stamp.cli.ts",
  "verify:dist": "bun scripts/verify-dist.cli.ts",
  "typecheck:root":
    "tsc -p tsconfig.json --pretty false && tsc -p tsconfig.test.json --pretty false && tsc -p tsconfig.tsdown.json --pretty false",
  "typecheck:e2e": "tsc -p e2e/tsconfig.json --pretty false",
  typecheck:
    "bun run typecheck:root && bun run typecheck:e2e && bun run --workspaces --sequential typecheck && bun run build:packages",
  test: "bun test --isolate --no-orphans",
  "test:coverage": "bun test --isolate --no-orphans --coverage",
  "test:coverage:workspaces":
    "bun run --filter './packages/**' --sequential test:coverage && bun scripts/published/workspace-coverage.cli.ts",
  "test:examples": "bun run --filter '@likego/example-*' --parallel test",
  "test:examples:programs": "bun run build:packages && bun scripts/verify-example-programs.cli.ts",
  "test:examples:node":
    "bun run build:packages && bun run --filter '@likego/example-*' --parallel --if-present e2e:node:prepared",
  "test:examples:docker":
    "bun run --filter '@likego/example-*' --sequential --if-present test:docker",
  "test:transport-http:node-security":
    "bun run --filter @likego/transport-http e2e:node-security:docker",
  "test:providers:docker": "bun scripts/provider-docker-gate.cli.ts",
  "test:providers:docker:prepared":
    "bun run --filter @likego/broker-rabbitmq --filter @likego/cache-redis --filter @likego/registry-consul --filter @likego/registry-etcd --filter @likego/registry-kubernetes --filter @likego/registry-mdns --filter @likego/registry-zookeeper --filter @likego/config-kubernetes --filter @likego/config-vault --filter @likego/store-vault --sequential test:docker",
  "test:published:runtime": "bun scripts/published/cli.ts --gate runtime",
  "test:published:types": "bun scripts/published/cli.ts --gate types",
  "test:published": "bun run test:published:runtime && bun run test:published:types",
  "test:e2e:inventory": "bun e2e/run.ts --inventory",
  "test:e2e:docker-ownership":
    "LIKEGO_E2E_DOCKER_OWNERSHIP=1 bun test --isolate --no-orphans e2e/suites.test.ts",
  "test:e2e:prepared": "bun e2e/run.ts",
  "test:e2e": "bun run build && bun run test:e2e:prepared",
  "soak:http": "bun scripts/soak.cli.ts --duration 60m --output .artifacts/soak/http.json",
  "soak:check": "bun scripts/soak.cli.ts --check .artifacts/soak/http.json",
  "verify:file-inventory": "bun scripts/generate-file-inventory.cli.ts --check",
  "verify:manifests": "bun tools/manifests/check.cli.ts --mode repository --root .",
  "verify:workspace": "bun scripts/verify-workspace.cli.ts",
  verify:
    "bun run fmt:check && bun run verify:workspace && bun run verify:manifests && bun run verify:file-inventory && bun run audit && bun run clean:generated && bun run typecheck && bun run verify:dist && bun run build:stamp && bun run test:coverage && bun run test:coverage:workspaces && bun run test:examples && bun scripts/verify-example-programs.cli.ts && bun run --filter '@likego/example-*' --parallel --if-present e2e:node:prepared && bun run test:examples:docker && bun run test:e2e:docker-ownership && bun run test:transport-http:node-security && bun run test:providers:docker && bun run test:published && bun run test:e2e:prepared && bun run verify:doc"
} as const
const RootOverrides = {
  "fast-uri": "3.1.4",
  vite: "6.4.3"
} as const
const ValidRootManifest = {
  name: "likego",
  version: "0.0.1",
  private: true,
  type: "module",
  packageManager: "bun@1.3.14",
  workspaces: ["packages/*", "adapters/*", "examples/*"],
  scripts: RootScripts,
  overrides: RootOverrides,
  devDependencies: {
    "@babel/parser": "8.0.4",
    "@babel/types": "8.0.4",
    "@changesets/cli": "2.31.1",
    "@types/bun": "1.3.14",
    oxfmt: "0.60.0",
    tsdown: "0.22.14",
    typescript: "7.0.2",
    vitepress: "1.6.4"
  }
} as const
const CliPath = fileURLToPath(new URL("./verify-workspace.cli.ts", import.meta.url))
const ProviderDockerGateCliPath = fileURLToPath(
  new URL("./provider-docker-gate.cli.ts", import.meta.url)
)
const FinalWorkspaceGlobs = [
  "packages/*",
  "packages/broker/memory",
  "packages/broker/rabbitmq",
  "packages/cache/memory",
  "packages/cache/redis",
  "packages/config/consul",
  "packages/config/etcd",
  "packages/config/kubernetes",
  "packages/config/vault",
  "packages/registry/consul",
  "packages/registry/etcd",
  "packages/registry/kubernetes",
  "packages/registry/mdns",
  "packages/registry/zookeeper",
  "packages/store/consul",
  "packages/store/etcd",
  "packages/store/file",
  "packages/store/memory",
  "packages/store/vault",
  "packages/transport/http",
  "packages/transport/memory",
  "examples/*"
] as const
const FinalReleasePackages = [
  "@likego/broker",
  "@likego/broker-memory",
  "@likego/broker-rabbitmq",
  "@likego/bullmq",
  "@likego/cache",
  "@likego/cache-memory",
  "@likego/cache-redis",
  "@likego/client",
  "@likego/config",
  "@likego/config-consul",
  "@likego/config-etcd",
  "@likego/config-kubernetes",
  "@likego/config-vault",
  "@likego/context",
  "@likego/core",
  "@likego/create",
  "@likego/croner",
  "@likego/elysia",
  "@likego/event",
  "@likego/h3",
  "@likego/health",
  "@likego/hono",
  "@likego/metadata",
  "@likego/nats",
  "@likego/otel",
  "@likego/pino",
  "@likego/prometheus",
  "@likego/registry",
  "@likego/registry-consul",
  "@likego/registry-etcd",
  "@likego/registry-kubernetes",
  "@likego/registry-mdns",
  "@likego/registry-zookeeper",
  "@likego/resilience",
  "@likego/server",
  "@likego/store",
  "@likego/store-consul",
  "@likego/store-etcd",
  "@likego/store-file",
  "@likego/store-memory",
  "@likego/store-vault",
  "@likego/transport",
  "@likego/transport-http",
  "@likego/transport-memory",
  "@likego/web",
  "@likego/winston"
] as const
const ExampleCatalog: { readonly examples: readonly { readonly id: string }[] } = await Bun.file(
  join(import.meta.dir, "../examples/catalog.json")
).json()
const FinalPrivatePackages = [
  "@likego/testing",
  ...ExampleCatalog.examples.map((entry) => `@likego/example-${entry.id}`)
].sort()
const FinalExampleWorkspaceIdentities = ExampleCatalog.examples.map((entry) => ({
  root: `examples/${entry.id}`,
  name: `@likego/example-${entry.id}`
}))
const FinalWorkspaceIdentities = [
  ...FinalExampleWorkspaceIdentities,
  { root: "packages/broker", name: "@likego/broker" },
  { root: "packages/broker/memory", name: "@likego/broker-memory" },
  { root: "packages/broker/rabbitmq", name: "@likego/broker-rabbitmq" },
  { root: "packages/bullmq", name: "@likego/bullmq" },
  { root: "packages/cache", name: "@likego/cache" },
  { root: "packages/cache/memory", name: "@likego/cache-memory" },
  { root: "packages/cache/redis", name: "@likego/cache-redis" },
  { root: "packages/client", name: "@likego/client" },
  { root: "packages/config", name: "@likego/config" },
  { root: "packages/config/consul", name: "@likego/config-consul" },
  { root: "packages/config/etcd", name: "@likego/config-etcd" },
  { root: "packages/config/kubernetes", name: "@likego/config-kubernetes" },
  { root: "packages/config/vault", name: "@likego/config-vault" },
  { root: "packages/context", name: "@likego/context" },
  { root: "packages/core", name: "@likego/core" },
  { root: "packages/create", name: "@likego/create" },
  { root: "packages/croner", name: "@likego/croner" },
  { root: "packages/elysia", name: "@likego/elysia" },
  { root: "packages/event", name: "@likego/event" },
  { root: "packages/h3", name: "@likego/h3" },
  { root: "packages/health", name: "@likego/health" },
  { root: "packages/hono", name: "@likego/hono" },
  { root: "packages/metadata", name: "@likego/metadata" },
  { root: "packages/nats", name: "@likego/nats" },
  { root: "packages/otel", name: "@likego/otel" },
  { root: "packages/pino", name: "@likego/pino" },
  { root: "packages/prometheus", name: "@likego/prometheus" },
  { root: "packages/registry", name: "@likego/registry" },
  { root: "packages/registry/consul", name: "@likego/registry-consul" },
  { root: "packages/registry/etcd", name: "@likego/registry-etcd" },
  { root: "packages/registry/kubernetes", name: "@likego/registry-kubernetes" },
  { root: "packages/registry/mdns", name: "@likego/registry-mdns" },
  { root: "packages/registry/zookeeper", name: "@likego/registry-zookeeper" },
  { root: "packages/resilience", name: "@likego/resilience" },
  { root: "packages/server", name: "@likego/server" },
  { root: "packages/store", name: "@likego/store" },
  { root: "packages/store/consul", name: "@likego/store-consul" },
  { root: "packages/store/etcd", name: "@likego/store-etcd" },
  { root: "packages/store/file", name: "@likego/store-file" },
  { root: "packages/store/memory", name: "@likego/store-memory" },
  { root: "packages/store/vault", name: "@likego/store-vault" },
  { root: "packages/testing", name: "@likego/testing" },
  { root: "packages/transport", name: "@likego/transport" },
  { root: "packages/transport/http", name: "@likego/transport-http" },
  { root: "packages/transport/memory", name: "@likego/transport-memory" },
  { root: "packages/web", name: "@likego/web" },
  { root: "packages/winston", name: "@likego/winston" }
].sort((left, right) => left.root.localeCompare(right.root))
const FinalTsconfigPaths = {
  "@likego/config": ["./packages/config/src/index.ts"],
  "@likego/broker": ["./packages/broker/src/index.ts"],
  "@likego/broker/provider": ["./packages/broker/src/provider.ts"],
  "@likego/broker-memory": ["./packages/broker/memory/src/index.ts"],
  "@likego/broker-rabbitmq": ["./packages/broker/rabbitmq/src/index.ts"],
  "@likego/cache": ["./packages/cache/src/index.ts"],
  "@likego/cache-memory": ["./packages/cache/memory/src/index.ts"],
  "@likego/cache-redis": ["./packages/cache/redis/src/index.ts"],
  "@likego/config/env": ["./packages/config/src/env.ts"],
  "@likego/config/file": ["./packages/config/src/file.ts"],
  "@likego/config/node": ["./packages/config/src/node.ts"],
  "@likego/config/yaml": ["./packages/config/src/yaml.ts"],
  "@likego/config-consul": ["./packages/config/consul/src/index.ts"],
  "@likego/config-etcd": ["./packages/config/etcd/src/index.ts"],
  "@likego/config-kubernetes": ["./packages/config/kubernetes/src/index.ts"],
  "@likego/config-vault": ["./packages/config/vault/src/index.ts"],
  "@likego/context": ["./packages/context/src/index.ts"],
  "@likego/core": ["./packages/core/src/index.ts"],
  "@likego/core/lifecycle": ["./packages/core/src/lifecycle.ts"],
  "@likego/core/node": ["./packages/core/src/node.ts"],
  "@likego/create": ["./packages/create/src/index.ts"],
  "@likego/croner": ["./packages/croner/src/index.ts"],
  "@likego/elysia": ["./packages/elysia/src/index.ts"],
  "@likego/event": ["./packages/event/src/index.ts"],
  "@likego/h3": ["./packages/h3/src/index.ts"],
  "@likego/health": ["./packages/health/src/index.ts"],
  "@likego/hono": ["./packages/hono/src/index.ts"],
  "@likego/metadata": ["./packages/metadata/src/index.ts"],
  "@likego/bullmq": ["./packages/bullmq/src/index.ts"],
  "@likego/client": ["./packages/client/src/index.ts"],
  "@likego/nats": ["./packages/nats/src/index.ts"],
  "@likego/nats/broker": ["./packages/nats/src/broker.ts"],
  "@likego/nats/jetstream": ["./packages/nats/src/jetstream.ts"],
  "@likego/nats/jetstream/broker": ["./packages/nats/src/jetstream-broker.ts"],
  "@likego/otel": ["./packages/otel/src/index.ts"],
  "@likego/otel/testing": ["./packages/otel/src/testing.ts"],
  "@likego/pino": ["./packages/pino/src/index.ts"],
  "@likego/prometheus": ["./packages/prometheus/src/index.ts"],
  "@likego/registry": ["./packages/registry/src/index.ts"],
  "@likego/registry-consul": ["./packages/registry/consul/src/index.ts"],
  "@likego/registry-etcd": ["./packages/registry/etcd/src/index.ts"],
  "@likego/registry-kubernetes": ["./packages/registry/kubernetes/src/index.ts"],
  "@likego/registry-mdns": ["./packages/registry/mdns/src/index.ts"],
  "@likego/registry-mdns/node": ["./packages/registry/mdns/src/node.ts"],
  "@likego/registry-zookeeper": ["./packages/registry/zookeeper/src/index.ts"],
  "@likego/resilience": ["./packages/resilience/src/index.ts"],
  "@likego/server": ["./packages/server/src/index.ts"],
  "@likego/store": ["./packages/store/src/index.ts"],
  "@likego/store-consul": ["./packages/store/consul/src/index.ts"],
  "@likego/store-etcd": ["./packages/store/etcd/src/index.ts"],
  "@likego/store-file": ["./packages/store/file/src/index.ts"],
  "@likego/store-file/node": ["./packages/store/file/src/node.ts"],
  "@likego/store-memory": ["./packages/store/memory/src/index.ts"],
  "@likego/store-vault": ["./packages/store/vault/src/index.ts"],
  "@likego/testing": ["./packages/testing/src/index.ts"],
  "@likego/testing/server": ["./packages/testing/src/server.ts"],
  "@likego/testing/listener": ["./packages/testing/src/listener.ts"],
  "@likego/transport": ["./packages/transport/src/index.ts"],
  "@likego/transport/headers": ["./packages/transport/src/headers.ts"],
  "@likego/transport-http": ["./packages/transport/http/src/index.ts"],
  "@likego/transport-http/node": ["./packages/transport/http/src/node.ts"],
  "@likego/transport-memory": ["./packages/transport/memory/src/index.ts"],
  "@likego/web": ["./packages/web/src/index.ts"],
  "@likego/web/health": ["./packages/web/src/health.ts"],
  "@likego/web/node": ["./packages/web/src/node.ts"],
  "@likego/web/node/testing": ["./packages/web/src/node-testing.ts"],
  "@likego/winston": ["./packages/winston/src/index.ts"]
} as const

afterEach(async () => {
  await Promise.all(Roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function Fixture(manifest: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "likego-workspace-"))
  Roots.push(root)
  await Bun.write(join(root, "package.json"), `${JSON.stringify(manifest)}\n`)
  await Bun.write(
    join(root, "tsconfig.build.json"),
    `${JSON.stringify({ files: [], references: [] })}\n`
  )
  await Bun.write(
    join(root, "tsconfig.tsdown.json"),
    `${JSON.stringify({
      extends: "./tsconfig.base.json",
      compilerOptions: { noEmit: true, types: ["bun"], skipLibCheck: true },
      files: ["tsdown.config.ts"]
    })}\n`
  )
  return root
}

async function WriteWorkspace(
  root: string,
  location: string,
  name: string,
  dependencies: Readonly<Record<string, string>> = {}
): Promise<void> {
  await mkdir(join(root, location), { recursive: true })
  const privateExample = name.startsWith("@likego/example-")
  const privateWorkspace = privateExample || name === "@likego/testing"
  await Bun.write(
    join(root, location, "package.json"),
    `${JSON.stringify({
      name,
      ...(privateWorkspace ? {} : { version: "1.2.3" }),
      private: privateWorkspace,
      type: "module",
      ...(privateExample
        ? {
            scripts: {
              start: "bun run --cwd ../.. build:packages && bun run start:prepared",
              "start:prepared":
                "bun build src/main.ts --target=node --outfile=.artifacts/main.mjs && node .artifacts/main.mjs",
              test: "bun test --isolate --no-orphans test"
            }
          }
        : privateWorkspace
          ? { exports: { ".": "./src/index.ts" } }
          : { exports: { ".": "./dist/index.js" } }),
      ...(privateWorkspace ? {} : { publishConfig: { directory: "dist", access: "public" } }),
      dependencies
    })}\n`
  )
  if (privateExample) await WriteExampleProgramFiles(root, location, name)
}

async function WriteExampleProgramFiles(
  root: string,
  location: string,
  name: string
): Promise<void> {
  await mkdir(join(root, location, "src"), { recursive: true })
  await mkdir(join(root, location, "test"), { recursive: true })
  await Bun.write(
    join(root, location, "src", "main.ts"),
    'process.stdout.write("LIKEGO_EXAMPLE_READY={}\\n")\n'
  )
  await Bun.write(join(root, location, "src", "service.ts"), "export const service = true\n")
  await Bun.write(join(root, location, "src", "http.ts"), "export const handler = true\n")
  await Bun.write(
    join(root, location, "test", "service.test.ts"),
    'import { service } from "../src/service"\nvoid service\n'
  )
  await Bun.write(
    join(root, location, "README.md"),
    [
      "# Example",
      "",
      "LikeGo capability and source responsibilities:",
      "",
      "- `src/main.ts`: program entry.",
      "- `src/service.ts`: business service.",
      "- `src/http.ts`: request handler.",
      "",
      `bun run --filter ${name} start`,
      ""
    ].join("\n")
  )
}

async function WriteBuildReferences(root: string, paths: readonly string[]): Promise<void> {
  await Bun.write(
    join(root, "tsconfig.build.json"),
    `${JSON.stringify({
      files: [],
      references: paths.map((path) => ({ path: `./${path}` }))
    })}\n`
  )
}

async function WriteNeutralWorkspace(root: string): Promise<void> {
  await WriteWorkspace(root, "packages/fixture", "@likego/fixture")
  await WriteBuildReferences(root, ["packages/fixture"])
}

async function RunVerifier(root: string): Promise<{
  readonly ExitCode: number
  readonly Stdout: string
  readonly Stderr: string
}> {
  const subprocess = Bun.spawn({
    cmd: [process.execPath, CliPath],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe"
  })
  const [ExitCode, Stdout, Stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text()
  ])
  return { ExitCode, Stdout, Stderr }
}

describe("verifyWorkspace", () => {
  test("rejects Bun runtime version drift", () => {
    expect(verifyBunRuntime("1.3.13")).toEqual({
      Code: "BUN_RUNTIME",
      Path: "Bun.version",
      Message: "Bun runtime must be exactly 1.3.14 (observed 1.3.13)"
    })
    expect(verifyBunRuntime("1.3.14")).toBeNull()
  })

  test("accepts the repository root", async () => {
    expect(await verifyWorkspace(fileURLToPath(new URL("..", import.meta.url)))).toEqual([])
  })

  test("locks the repository to the final 46 release and private workspace identities", async () => {
    const root = fileURLToPath(new URL("..", import.meta.url))
    const rootManifest = await Bun.file(join(root, "package.json")).json()
    const buildManifest = await Bun.file(join(root, "tsconfig.build.json")).json()
    const rootTsconfig = await Bun.file(join(root, "tsconfig.base.json")).json()
    expect(rootManifest.workspaces).toEqual(FinalWorkspaceGlobs)
    expect(rootManifest.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
    expect(rootTsconfig.compilerOptions.paths).toEqual(FinalTsconfigPaths)
    expect(Object.keys(rootTsconfig.compilerOptions.paths)).toHaveLength(67)

    const workspaces = await discoverWorkspaces(root)
    const releasePackages = workspaces
      .filter((workspace) => !workspace.private)
      .map((workspace) => workspace.name)
      .sort()
    const privatePackages = workspaces
      .filter((workspace) => workspace.private)
      .map((workspace) => workspace.name)
      .sort()
    const workspaceRoots = workspaces.map((workspace) => workspace.root).sort()
    const buildRoots = buildManifest.references
      .map((reference: { readonly path: string }) => reference.path.replace(/^\.\//, ""))
      .sort()

    expect(releasePackages).toEqual([...FinalReleasePackages])
    expect(privatePackages).toEqual([...FinalPrivatePackages])
    expect(workspaces).toHaveLength(FinalReleasePackages.length + FinalPrivatePackages.length)
    expect(
      workspaces.map((workspace) => ({
        root: workspace.root,
        name: workspace.name
      }))
    ).toEqual(FinalWorkspaceIdentities.map(({ root, name }) => ({ root, name })))
    expect(
      workspaces
        .filter((workspace) => !workspace.private)
        .map((workspace) => workspace.root)
        .sort()
    ).toEqual(buildRoots)
    expect(workspaceRoots.some((workspace) => workspace.startsWith("adapters/"))).toBe(false)

    const routingFiles = [
      "package.json",
      "bunfig.toml",
      "deno.json",
      "tsconfig.base.json",
      "tsconfig.build.json",
      "tsconfig.json",
      "tsconfig.test.json",
      "tsconfig.tsdown.json",
      "e2e/tsconfig.json"
    ]
    const routing = (
      await Promise.all(routingFiles.map((path) => Bun.file(join(root, path)).text()))
    ).join("\n")
    for (const identity of [
      "@likego/fetch",
      "@likego/fetch-node",
      "@likego/http",
      "@likego/config-env",
      "@likego/config-file",
      "@likego/cron-croner",
      "@likego/job-bullmq-node",
      "@likego/log-pino-node",
      "@likego/log-winston-node",
      "@likego/metrics-prom-client-node",
      "@likego/nats-core-node",
      "@likego/nats-jetstream-node",
      "@likego/otel-node"
    ]) {
      expect(routing).not.toContain(identity)
    }
  })

  test("discovers direct and explicitly nested workspaces from the root manifest", async () => {
    const workspaces = [
      "packages/*",
      "packages/config/consul",
      "packages/registry/mdns",
      "packages/transport/http",
      "examples/*"
    ]
    const root = await Fixture({ ...ValidRootManifest, workspaces })
    await Bun.write(join(root, "bun.lock"), "lockfileVersion = 1\n")
    await WriteWorkspace(root, "packages/config/consul", "@likego/config-consul")
    await WriteWorkspace(root, "packages/config", "@likego/config", {
      "@likego/config-consul": "1.2.3"
    })
    await WriteWorkspace(root, "packages/registry/mdns", "@likego/registry-mdns")
    await WriteWorkspace(root, "packages/registry", "@likego/registry", {
      "@likego/registry-mdns": "1.2.3"
    })
    await WriteWorkspace(root, "packages/transport/http", "@likego/transport-http")
    await WriteWorkspace(root, "packages/transport", "@likego/transport", {
      "@likego/transport-http": "1.2.3"
    })
    await WriteWorkspace(root, "examples/demo", "@likego/example-demo")
    await WriteBuildReferences(root, [
      "packages/config",
      "packages/config/consul",
      "packages/registry",
      "packages/registry/mdns",
      "packages/transport",
      "packages/transport/http"
    ])

    expect(await verifyWorkspace(root)).toEqual([])
  })

  test("rejects missing extra duplicate and escaping build references", async () => {
    const root = await Fixture({ ...ValidRootManifest, workspaces: ["packages/*"] })
    await Bun.write(join(root, "bun.lock"), "lockfileVersion = 1\n")
    await WriteWorkspace(root, "packages/one", "@likego/one")

    for (const paths of [
      [],
      ["packages/one", "packages/extra"],
      ["packages/one", "packages/one"],
      ["../outside"]
    ]) {
      await WriteBuildReferences(root, paths)
      expect((await verifyWorkspace(root)).map((issue) => issue.Code)).toEqual(["BUILD_REFERENCES"])
    }
  })

  test("locks the isolated tsdown UserConfig typecheck boundary", async () => {
    const root = await Fixture(ValidRootManifest)
    await Bun.write(join(root, "bun.lock"), "lockfileVersion = 1\n")
    await WriteNeutralWorkspace(root)
    await Bun.write(
      join(root, "tsconfig.tsdown.json"),
      `${JSON.stringify({
        extends: "./tsconfig.base.json",
        compilerOptions: { noEmit: true, types: ["bun"], skipLibCheck: false },
        files: ["tsdown.config.ts"]
      })}\n`
    )

    expect((await verifyWorkspace(root)).map((issue) => issue.Code)).toEqual([
      "TSDOWN_TYPECHECK_CONFIG"
    ])
  })

  test("rejects malformed build reference documents and entries", async () => {
    const root = await Fixture({ ...ValidRootManifest, workspaces: ["packages/*"] })
    await Bun.write(join(root, "bun.lock"), "lockfileVersion = 1\n")
    await WriteWorkspace(root, "packages/one", "@likego/one")

    for (const source of [
      "{\n",
      JSON.stringify({ references: {} }),
      JSON.stringify({ references: [{}] }),
      JSON.stringify({ references: [{ path: "" }] })
    ]) {
      await Bun.write(join(root, "tsconfig.build.json"), `${source}\n`)
      expect(
        (await verifyWorkspace(root)).filter((issue) => issue.Code === "BUILD_REFERENCES")
      ).toHaveLength(1)
    }
  })

  test("rejects root toolchain and lockfile drift", async () => {
    const root = await Fixture({
      name: "wrong",
      version: "0.0.1",
      private: false,
      type: "commonjs",
      packageManager: "npm@latest",
      workspaces: ["packages/**"],
      scripts: RootScripts,
      devDependencies: {
        "@types/bun": "^1.3.14",
        typescript: "latest"
      }
    })
    await Bun.write(join(root, "package-lock.json"), "{}\n")

    expect((await verifyWorkspace(root)).map((issue) => issue.Code)).toEqual([
      "ROOT_NAME",
      "ROOT_PRIVATE",
      "ROOT_TYPE",
      "PACKAGE_MANAGER",
      "WORKSPACES",
      "ROOT_OVERRIDES",
      "DEV_DEPENDENCY",
      "DEV_DEPENDENCY",
      "DEV_DEPENDENCY",
      "DEV_DEPENDENCY",
      "DEV_DEPENDENCY",
      "DEV_DEPENDENCY",
      "DEV_DEPENDENCY",
      "DEV_DEPENDENCY",
      "BUN_LOCK_MISSING",
      "FOREIGN_LOCKFILE"
    ])
  })

  test("rejects invalid workspace manifests and floating dependencies", async () => {
    const root = await Fixture(ValidRootManifest)
    await Bun.write(join(root, "bun.lock"), "lockfileVersion = 1\n")
    await mkdir(join(root, "packages", "bad"), { recursive: true })
    await Bun.write(
      join(root, "packages", "bad", "package.json"),
      JSON.stringify({
        name: "bad",
        version: "latest",
        private: false,
        type: "commonjs",
        publishConfig: { directory: "dist", access: "public" },
        dependencies: {
          external: "^1.0.0",
          internal: "workspace:^"
        }
      })
    )
    await WriteBuildReferences(root, ["packages/bad"])

    expect((await verifyWorkspace(root)).map((issue) => issue.Code)).toEqual([
      "WORKSPACE_NAME",
      "WORKSPACE_TYPE",
      "WORKSPACE_VERSION",
      "WORKSPACE_EXPORTS",
      "DEPENDENCY_SPECIFIER",
      "DEPENDENCY_SPECIFIER"
    ])
  })

  test("rejects release metadata and generated build output on private examples", async () => {
    const root = await Fixture({ ...ValidRootManifest, workspaces: ["examples/*"] })
    await Bun.write(join(root, "bun.lock"), "lockfileVersion = 1\n")
    await mkdir(join(root, "examples", "bad"), { recursive: true })
    await Bun.write(
      join(root, "examples", "bad", "package.json"),
      JSON.stringify({
        name: "@likego/example-bad",
        version: "0.0.1",
        private: true,
        type: "module",
        files: ["dist"],
        exports: { ".": "./dist/index.js" },
        scripts: {
          build: "tsc",
          start: "bun run --cwd ../.. build:packages && bun run start:prepared",
          "start:prepared":
            "bun build src/main.ts --target=node --outfile=.artifacts/main.mjs && node .artifacts/main.mjs",
          test: "bun test --isolate --no-orphans test"
        },
        publishConfig: { directory: "dist", access: "public" }
      })
    )
    await WriteExampleProgramFiles(root, "examples/bad", "@likego/example-bad")

    expect((await verifyWorkspace(root)).map((issue) => issue.Code)).toEqual([
      "PRIVATE_VERSION",
      "PRIVATE_FILES",
      "PRIVATE_DIST_EXPORT",
      "PRIVATE_BUILD_SCRIPT",
      "PUBLISH_CONFIG"
    ])
  })

  test("rejects example entrypoint, source split, test import, and README drift", async () => {
    const root = await Fixture({ ...ValidRootManifest, workspaces: ["examples/*"] })
    await Bun.write(join(root, "bun.lock"), "lockfileVersion = 1\n")
    await WriteWorkspace(root, "examples/bad", "@likego/example-bad")
    await rm(join(root, "examples", "bad", "src", "http.ts"))
    await Bun.write(
      join(root, "examples", "bad", "src", "program.ts"),
      "export const legacyProgram = true\n"
    )
    await Bun.write(
      join(root, "examples", "bad", "test", "service.test.ts"),
      'import "../src/main"\n'
    )
    await Bun.write(
      join(root, "examples", "bad", "README.md"),
      "# Example\n\nLikeGo\n\n`src/main.ts`\n\nbun run --filter @likego/example-bad start\n"
    )
    await Bun.write(
      join(root, "examples", "bad", "package.json"),
      JSON.stringify({
        name: "@likego/example-bad",
        private: true,
        type: "module",
        scripts: {
          start: "bun start",
          "start:prepared":
            "bun build src/program.ts --target=node --outfile=.artifacts/program.mjs && node .artifacts/program.mjs",
          test: "bun test --isolate --no-orphans test"
        }
      })
    )

    expect((await verifyExampleProgram(root, "examples/bad")).map((issue) => issue.Code)).toEqual([
      "EXAMPLE_PROGRAM",
      "EXAMPLE_SOURCE_SPLIT",
      "EXAMPLE_START",
      "EXAMPLE_START_PREPARED",
      "EXAMPLE_TEST_IMPORT",
      "EXAMPLE_README"
    ])
  })

  test("rejects examples without a test script", async () => {
    const root = await Fixture({ ...ValidRootManifest, workspaces: ["examples/*"] })
    await Bun.write(join(root, "bun.lock"), "lockfileVersion = 1\n")
    await WriteWorkspace(root, "examples/bad", "@likego/example-bad")
    const manifestPath = join(root, "examples", "bad", "package.json")
    const manifest = await Bun.file(manifestPath).json()
    delete manifest.scripts.test
    await Bun.write(manifestPath, `${JSON.stringify(manifest)}\n`)

    expect((await verifyExampleProgram(root, "examples/bad")).map((issue) => issue.Code)).toEqual([
      "EXAMPLE_TEST_SCRIPT"
    ])
  })

  test("rejects dependency specifiers that contradict workspace ownership", async () => {
    const root = await Fixture(ValidRootManifest)
    await Bun.write(join(root, "bun.lock"), "lockfileVersion = 1\n")
    await mkdir(join(root, "packages", "app"), { recursive: true })
    await mkdir(join(root, "packages", "library"), { recursive: true })
    await Bun.write(
      join(root, "packages", "app", "package.json"),
      JSON.stringify({
        name: "@likego/app",
        version: "1.2.3",
        type: "module",
        publishConfig: { directory: "dist", access: "public" },
        exports: {
          ".": "./dist/index.js"
        },
        dependencies: {
          "@likego/library": "workspace:*",
          external: "workspace:*"
        }
      })
    )
    await Bun.write(
      join(root, "packages", "library", "package.json"),
      JSON.stringify({
        name: "@likego/library",
        version: "1.2.3",
        type: "module",
        publishConfig: { directory: "dist", access: "public" },
        exports: {
          ".": "./dist/index.js"
        }
      })
    )
    await WriteBuildReferences(root, ["packages/app", "packages/library"])

    expect((await verifyWorkspace(root)).map((issue) => issue.Code)).toEqual([
      "DEPENDENCY_SPECIFIER",
      "DEPENDENCY_SPECIFIER"
    ])
  })

  test("rejects missing, unknown, and drifted root scripts", async () => {
    const invalidScripts: readonly unknown[] = [
      undefined,
      true,
      { ...RootScripts, unknown: "bun test" },
      { ...RootScripts, test: true },
      { ...RootScripts, test: "node --test" }
    ]

    for (const scripts of invalidScripts) {
      const root = await Fixture({ ...ValidRootManifest, scripts })
      await Bun.write(join(root, "bun.lock"), "lockfileVersion = 1\n")
      await WriteNeutralWorkspace(root)
      expect((await verifyWorkspace(root)).map((issue) => issue.Code)).toEqual(["ROOT_SCRIPTS"])
    }
  })

  test("rejects missing, unknown, and drifted root security overrides", async () => {
    const invalidOverrides: readonly unknown[] = [
      undefined,
      true,
      { ...RootOverrides, unknown: "1.0.0" },
      { ...RootOverrides, vite: "6.4.2" }
    ]

    for (const overrides of invalidOverrides) {
      const root = await Fixture({ ...ValidRootManifest, overrides })
      await Bun.write(join(root, "bun.lock"), "lockfileVersion = 1\n")
      await WriteNeutralWorkspace(root)
      expect((await verifyWorkspace(root)).map((issue) => issue.Code)).toEqual(["ROOT_OVERRIDES"])
    }
  })

  test("locks the non-recursive ten-provider Docker supervisor and its hard deadline", async () => {
    const rootManifest: { readonly scripts?: Readonly<Record<string, unknown>> } = await Bun.file(
      join(import.meta.dir, "../package.json")
    ).json()
    expect(rootManifest.scripts?.["test:providers:docker"]).toBe(
      "bun scripts/provider-docker-gate.cli.ts"
    )
    expect(rootManifest.scripts?.["test:providers:docker:prepared"]).toBe(
      "bun run --filter @likego/broker-rabbitmq --filter @likego/cache-redis --filter @likego/registry-consul --filter @likego/registry-etcd --filter @likego/registry-kubernetes --filter @likego/registry-mdns --filter @likego/registry-zookeeper --filter @likego/config-kubernetes --filter @likego/config-vault --filter @likego/store-vault --sequential test:docker"
    )
    const source = await Bun.file(ProviderDockerGateCliPath).text()
    const normalized = source.replace(/\s+/gu, " ")
    expect(normalized).toContain("const TotalTimeoutMs = 20 * 60_000")
    expect(normalized).toContain("const CleanupReserveMs = 60_000")
    expect(normalized).toContain(
      "const childTimeoutMs = Math.min( ChildTimeoutMs, Math.floor(deadline - performance.now()) - CleanupReserveMs )"
    )
    expect(normalized).toContain("timeoutMs: childTimeoutMs")
    expect(normalized).toContain(
      "if (primary === null && controller.signal.aborted) { primary = Object.freeze({ reason: controller.signal.reason }) }"
    )
    expect(source).toContain('"test:providers:docker:prepared"')
    expect(source).not.toMatch(/["']test:providers:docker["']/u)
    for (const token of [
      '"package": "@likego/broker-rabbitmq"',
      "LIKEGO_CACHE_REDIS_E2E_RESULT=",
      "LIKEGO_REGISTRY_CONSUL_E2E_RESULT=",
      "LIKEGO_ETCD_DOCKER_V2=",
      "LIKEGO_KUBERNETES_DOCKER_V2=",
      "LIKEGO_REGISTRY_MDNS_E2E_RESULT=",
      "LIKEGO_ZOOKEEPER_DOCKER_EVIDENCE_V2=",
      "LIKEGO_CONFIG_KUBERNETES_DOCKER=",
      "LIKEGO_CONFIG_VAULT_E2E_RESULT=",
      "LIKEGO_STORE_VAULT_E2E_RESULT="
    ]) {
      expect(source).toContain(token)
    }
    expect(normalized).toContain("if (!result.stdout.includes(token))")
  })

  test("CLI exits non-zero with a stable issue for an invalid fixture cwd", async () => {
    const root = await Fixture({
      ...ValidRootManifest,
      scripts: { ...RootScripts, test: "node --test" }
    })
    await Bun.write(join(root, "bun.lock"), "lockfileVersion = 1\n")
    await WriteNeutralWorkspace(root)

    expect(await RunVerifier(root)).toEqual({
      ExitCode: 1,
      Stdout: "",
      Stderr: "ROOT_SCRIPTS package.json: scripts must exactly match the required root scripts\n"
    })
  })

  test("rejects floating and workspace root dependencies", async () => {
    const root = await Fixture({
      ...ValidRootManifest,
      dependencies: {
        exact: "1.2.3"
      },
      devDependencies: {
        ...ValidRootManifest.devDependencies,
        floating: "^1.0.0"
      },
      optionalDependencies: {
        workspace: "workspace:*"
      }
    })
    await Bun.write(join(root, "bun.lock"), "lockfileVersion = 1\n")
    await WriteNeutralWorkspace(root)

    expect((await verifyWorkspace(root)).map((issue) => issue.Code)).toEqual([
      "DEPENDENCY_SPECIFIER",
      "DEPENDENCY_SPECIFIER"
    ])
  })

  test("rejects legacy root and nested workspace lockfiles", async () => {
    const root = await Fixture(ValidRootManifest)
    await Bun.write(join(root, "bun.lock"), "lockfileVersion = 1\n")
    await Bun.write(join(root, "bun.lockb"), "legacy\n")
    await mkdir(join(root, "packages", "app"), { recursive: true })
    await Bun.write(
      join(root, "packages", "app", "package.json"),
      JSON.stringify({
        name: "@likego/app",
        version: "1.2.3",
        type: "module",
        publishConfig: { directory: "dist", access: "public" },
        exports: {
          ".": "./dist/index.js"
        }
      })
    )
    await WriteBuildReferences(root, ["packages/app"])
    await Bun.write(join(root, "packages", "app", "package-lock.json"), "{}\n")

    expect((await verifyWorkspace(root)).map(({ Code, Path }) => ({ Code, Path }))).toEqual([
      { Code: "FOREIGN_LOCKFILE", Path: "bun.lockb" },
      { Code: "FOREIGN_LOCKFILE", Path: "packages/app/package-lock.json" }
    ])
  })

  test("rejects handwritten JavaScript outside generated directories", async () => {
    const root = await Fixture(ValidRootManifest)
    await Bun.write(join(root, "bun.lock"), "lockfileVersion = 1\n")
    await WriteWorkspace(root, "packages/app", "@likego/app")
    await WriteWorkspace(root, "adapters/host", "@likego/host")
    await WriteWorkspace(root, "examples/example", "@likego/example-example")
    await WriteBuildReferences(root, ["packages/app", "adapters/host"])
    await mkdir(join(root, "e2e/load"), { recursive: true })
    await Bun.write(join(root, "e2e/load/k6-http.js"), "export default function load() {}\n")
    for (const path of [
      "scripts/handwritten.js",
      "tools/handwritten.mjs",
      "test/handwritten.cjs",
      "examples/example/handwritten.jsx"
    ]) {
      await Bun.write(join(root, path), "export {}\n")
    }
    await Bun.write(join(root, "packages/app/dist/generated.js"), "export {}\n")
    await Bun.write(join(root, "adapters/host/.artifacts/generated.mjs"), "export {}\n")

    expect((await verifyWorkspace(root)).map(({ Code, Path }) => ({ Code, Path }))).toEqual([
      { Code: "HANDWRITTEN_JAVASCRIPT", Path: "examples/example/handwritten.jsx" },
      { Code: "HANDWRITTEN_JAVASCRIPT", Path: "scripts/handwritten.js" },
      { Code: "HANDWRITTEN_JAVASCRIPT", Path: "test/handwritten.cjs" },
      { Code: "HANDWRITTEN_JAVASCRIPT", Path: "tools/handwritten.mjs" }
    ])
  })

  test("rejects only real extension-bearing internal TypeScript imports", async () => {
    const root = await Fixture(ValidRootManifest)
    await Bun.write(join(root, "bun.lock"), "lockfileVersion = 1\n")
    await mkdir(join(root, "scripts"), { recursive: true })
    await Bun.write(join(root, "scripts/value.ts"), "export const value = 1\n")
    await Bun.write(
      join(root, "scripts/entry.ts"),
      [
        'import "./value.ts"',
        'export { value } from "./value.js"',
        'void import("./value.mjs")',
        'void import("./value")',
        'void import("ajv/dist/2020.js")',
        "const lookalike = 'import \"./ignored.js\"'",
        "void lookalike",
        ""
      ].join("\n")
    )

    expect(
      (await verifyWorkspace(root))
        .filter((issue) => issue.Code === "RELATIVE_IMPORT_EXTENSION")
        .map(({ Path, Message }) => ({ Path, Message }))
    ).toEqual([
      {
        Path: "scripts/entry.ts",
        Message: "internal TypeScript module specifier must omit its extension: ./value.ts"
      },
      {
        Path: "scripts/entry.ts",
        Message: "internal TypeScript module specifier must omit its extension: ./value.js"
      },
      {
        Path: "scripts/entry.ts",
        Message: "internal TypeScript module specifier must omit its extension: ./value.mjs"
      }
    ])
  })

  test("scans executable TypeScript after its shebang", async () => {
    const root = await Fixture(ValidRootManifest)
    await Bun.write(join(root, "bun.lock"), "lockfileVersion = 1\n")
    await mkdir(join(root, "scripts"), { recursive: true })
    await Bun.write(join(root, "scripts/cli.ts"), "#!/usr/bin/env node\nexport {}\n")

    expect(
      (await verifyWorkspace(root)).filter((issue) => issue.Code === "TYPESCRIPT_SCAN")
    ).toEqual([])
  })

  test("reports an unreadable TypeScript syntax boundary without aborting workspace verification", async () => {
    const root = await Fixture(ValidRootManifest)
    await Bun.write(join(root, "bun.lock"), "lockfileVersion = 1\n")
    await mkdir(join(root, "scripts"), { recursive: true })
    await Bun.write(join(root, "scripts/broken.ts"), "import {")

    expect(
      (await verifyWorkspace(root)).filter((issue) => issue.Code === "TYPESCRIPT_SCAN")
    ).toEqual([
      {
        Code: "TYPESCRIPT_SCAN",
        Path: "scripts/broken.ts",
        Message: "development TypeScript must be syntactically scannable"
      }
    ])
  })
})
