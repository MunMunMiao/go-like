import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { parse } from "@babel/parser"
import { traverseFast } from "@babel/types"

import {
  newBusinessCaseRegistry,
  type PublishedBusinessCase
} from "../../scripts/published/business-cases"
import {
  clearPublishedGateArtifacts,
  publishedGateArtifactPath,
  validatePublishedReleaseInventory
} from "../../scripts/published/cli"
import { discoverPublishedPackages, stagePublishedPackage } from "../../scripts/published/inventory"
import { writePublishedBuildStamp } from "../../scripts/published/build-stamp"
import { runCommand } from "../../scripts/published/process"
import { distPackageManifest } from "../../scripts/package-dist"
import {
  parseDenoCoverage,
  parseNodeCoverage,
  parsePublishedLcov,
  requirePublishedFileInventory
} from "../../scripts/published/coverage"
import {
  nodeLtsImage,
  nodeCoverageArgs,
  prepareDenoPackageStage,
  publishedDockerArgs,
  publishedDockerOutcome,
  publishedCoverageDetail,
  publishedNodeTestArgs,
  requirePublishedProductionDependency,
  runPublishedRuntimePackage,
  validateH3LibCheckException,
  validateNatsExactOptionalException
} from "../../scripts/published/runner"
import {
  classifySourceCoverage,
  validateBunPackageCoverage
} from "../../scripts/published/workspace-coverage"
import { publishedBusinessCases } from "./business-cases"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function rootFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "likego-published-test-"))
  roots.push(root)
  await writeJson(join(root, "package.json"), {
    name: "likego-published-fixture",
    private: true,
    packageManager: "bun@1.3.14",
    workspaces: ["packages/*", "adapters/*"]
  })
  await writeJson(join(root, "tsconfig.base.json"), { compilerOptions: { strict: true } })
  await writeJson(join(root, "tsconfig.tsdown.json"), {
    extends: "./tsconfig.base.json",
    compilerOptions: { noEmit: true, types: ["bun"], skipLibCheck: true },
    files: ["tsdown.config.ts"]
  })
  await writeJson(join(root, "tsconfig.build.json"), { files: [] })
  await mkdir(join(root, "scripts"), { recursive: true })
  await Bun.write(join(root, "scripts/annotate-dist.ts"), "export const annotation = 1\n")
  await Bun.write(join(root, "scripts/annotate-dist.cli.ts"), "import './annotate-dist.js'\n")
  await Bun.write(join(root, "scripts/package-dist.ts"), "export const packageDist = 1\n")
  await mkdir(join(root, "tools/workspaces"), { recursive: true })
  await Bun.write(join(root, "tools/workspaces/discovery.ts"), "export const discovery = 1\n")
  await Bun.write(join(root, "tsdown.config.ts"), "export default {}\n")
  await Bun.write(join(root, "LICENSE"), "MIT fixture license\n")
  return root
}

async function prepareFixtureLock(root: string): Promise<void> {
  const process = Bun.spawn(["bun", "install", "--lockfile-only", "--ignore-scripts"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe"
  })
  const stdout = new Response(process.stdout).text()
  const stderr = new Response(process.stderr).text()
  const exitCode = await process.exited
  const output = `${await stdout}${await stderr}`.trim()
  if (exitCode !== 0)
    throw new Error(`fixture lock generation failed with exit ${exitCode}: ${output}`)
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true })
  await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`)
}

interface TypeScriptBoundaryResult {
  readonly exitCode: number
  readonly output: string
}

async function writeDeclarationPackage(
  root: string,
  name: string,
  exports: Readonly<Record<string, string>>,
  declarations: Readonly<Record<string, string>>
): Promise<void> {
  const packageRoot = join(root, "node_modules", name)
  await writeJson(join(packageRoot, "package.json"), {
    name,
    version: "0.1.0",
    type: "module",
    exports
  })
  for (const path of Object.keys(declarations)) {
    const source = declarations[path]
    if (source === undefined) throw new Error(`${name} declaration fixture is missing ${path}`)
    await mkdir(join(packageRoot, path, ".."), { recursive: true })
    await Bun.write(join(packageRoot, path), source)
  }
}

async function natsBoundaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "likego-nats-boundary-"))
  roots.push(root)
  await writeDeclarationPackage(
    root,
    "@likego/context",
    { ".": "./index.d.ts" },
    {
      "index.d.ts": [
        "export interface Context {}",
        "export declare function background(): Context",
        ""
      ].join("\n")
    }
  )
  await writeDeclarationPackage(
    root,
    "@likego/core",
    { ".": "./index.d.ts" },
    {
      "index.d.ts": [
        'import type { Context } from "@likego/context"',
        "export interface Server { start(ctx: Context): Promise<void>; stop(ctx: Context): Promise<void> }",
        ""
      ].join("\n")
    }
  )
  await mkdir(join(root, "node_modules", "@nats-io"), { recursive: true })
  const workspaceRoot = join(import.meta.dir, "../..")
  for (const packageName of ["transport-node", "jetstream"]) {
    await symlink(
      join(workspaceRoot, "packages/nats/node_modules/@nats-io", packageName),
      join(root, "node_modules/@nats-io", packageName),
      "dir"
    )
  }
  await mkdir(join(root, "node_modules", "@types"), { recursive: true })
  await symlink(
    join(workspaceRoot, "packages/nats/node_modules/@types/node"),
    join(root, "node_modules/@types/node"),
    "dir"
  )
  return root
}

async function runTypeScriptBoundary(
  root: string,
  consumer: string
): Promise<TypeScriptBoundaryResult> {
  await Bun.write(join(root, "type-consumer.ts"), consumer)
  const compiler = join(import.meta.dir, "../../node_modules/.bin/tsc")
  const process = Bun.spawn(
    [
      compiler,
      "--ignoreConfig",
      "--pretty",
      "false",
      "--noEmit",
      "--target",
      "ES2023",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--lib",
      "ES2023,DOM",
      "--strict",
      "--exactOptionalPropertyTypes",
      "true",
      "--noUncheckedIndexedAccess",
      "--skipLibCheck",
      "true",
      "--typeRoots",
      join(root, "node_modules/@types"),
      "--types",
      "node",
      "type-consumer.ts"
    ],
    {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe"
    }
  )
  const stdout = new Response(process.stdout).text()
  const stderr = new Response(process.stderr).text()
  const exitCode = await process.exited
  return Object.freeze({ exitCode, output: `${await stdout}${await stderr}` })
}

async function writePackage(
  root: string,
  location: string,
  name: string,
  dependencies: Readonly<Record<string, string>> = {},
  runtimes: readonly Readonly<Record<string, unknown>>[] = [
    {
      runtime: "node",
      lane: "current",
      minimumVersion: "26.5.0",
      testedVersions: ["26.5.0"],
      terminalObservability: "observable"
    }
  ]
): Promise<void> {
  const packageRoot = join(root, location)
  const sourceManifest = {
    name,
    version: "0.1.0",
    private: location.startsWith("examples/"),
    type: "module",
    exports: {
      ".": "./src/index.ts"
    },
    dependencies,
    license: "MIT",
    files: ["dist"]
  }
  await writeJson(join(packageRoot, "package.json"), sourceManifest)
  await writeJson(join(packageRoot, "capability.json"), {
    schemaVersion: 2,
    package: name,
    packageKind: location.startsWith("packages/") ? "portable" : "integration",
    stability: "provisional",
    releaseBlocking: true,
    exports: {
      ".": {
        kind: location.startsWith("packages/") ? "portable" : "integration",
        residency: "resident",
        ownerResources: ["fixture"],
        capabilities: ["fixture"],
        runtimes
      }
    }
  })
  await mkdir(join(packageRoot, "src"), { recursive: true })
  await Bun.write(join(packageRoot, "src/index.ts"), "export const value = 1\n")
  await mkdir(join(packageRoot, "test"), { recursive: true })
  await Bun.write(
    join(packageRoot, "test/containment-sentinel.ts"),
    `export const packageName = ${JSON.stringify(name)}\n`
  )
  await Bun.write(join(packageRoot, "README.md"), `# ${name}\n`)
  const license = await Bun.file(join(root, "LICENSE")).text()
  await Bun.write(join(packageRoot, "LICENSE"), license)
  await writeJson(join(packageRoot, "tsconfig.json"), { extends: "../../tsconfig.base.json" })
  await new Promise((resolve) => setTimeout(resolve, 5))
  await mkdir(join(packageRoot, "dist"), { recursive: true })
  await Bun.write(join(packageRoot, "dist/index.js"), "export const value = 1\n")
  await Bun.write(join(packageRoot, "dist/index.d.ts"), "export declare const value = 1\n")
  await Bun.write(join(packageRoot, "dist/README.md"), `# ${name}\n`)
  await Bun.write(join(packageRoot, "dist/LICENSE"), license)
  const versions = new Map(Object.keys(dependencies).map((dependency) => [dependency, "0.1.0"]))
  await writeJson(
    join(packageRoot, "dist/package.json"),
    distPackageManifest(sourceManifest, versions)
  )
}

function businessCase(packageName = "@fixture/nats-compat"): PublishedBusinessCase {
  return {
    package: packageName,
    exports: ["."],
    runtimeModule: `import { value } from "${packageName}"\nexport async function run() { if (value !== 1) throw new Error("bad value") }\n`,
    typeConsumer: `import { value } from "${packageName}"\nconst exact: 1 = value\nvoid exact\n`,
    natsExactOptionalPolicies: [
      {
        export: ".",
        directDependency: "@nats-io/transport-node"
      }
    ]
  }
}

describe("published business-case registry", () => {
  test("preserves a neutral export and direct-dependency type policy", () => {
    const registry = newBusinessCaseRegistry()
    registry.register(businessCase())

    expect(registry.get("@fixture/nats-compat")?.natsExactOptionalPolicies).toEqual([
      {
        export: ".",
        directDependency: "@nats-io/transport-node"
      }
    ])
  })

  test("rejects duplicate registrations and missing package-name imports", () => {
    const registry = newBusinessCaseRegistry()
    registry.register(businessCase())
    expect(() => registry.register(businessCase())).toThrow("duplicate published business case")
    expect(() =>
      registry.register({
        package: "@likego/missing-import",
        exports: ["."],
        runtimeModule: "export async function run() {}\n",
        typeConsumer: "export {}\n"
      })
    ).toThrow("must import its target by package name")
  })

  test("rejects comment-spoofed imports and invalid per-export policy inventories", () => {
    const registry = newBusinessCaseRegistry()
    expect(() =>
      registry.register({
        package: "@fixture/comment-spoof",
        exports: [".", "./testing"],
        runtimeModule: 'import "@fixture/comment-spoof"\nexport async function run() {}\n',
        typeConsumer: [
          'import type { Value } from "@fixture/comment-spoof"',
          '// from "@fixture/comment-spoof/testing"',
          "declare const value: Value",
          "void value",
          ""
        ].join("\n")
      })
    ).toThrow("must import declared export ./testing")

    const missingExportPolicy = businessCase()
    expect(() =>
      registry.register({
        package: missingExportPolicy.package,
        exports: missingExportPolicy.exports,
        runtimeModule: missingExportPolicy.runtimeModule,
        typeConsumer: missingExportPolicy.typeConsumer,
        natsExactOptionalPolicies: [
          {
            export: "./missing",
            directDependency: "@nats-io/transport-node"
          }
        ]
      })
    ).toThrow("unknown NATS exact-optional policy")

    const duplicatePolicy = businessCase("@fixture/nats-duplicate")
    expect(() =>
      registry.register({
        package: duplicatePolicy.package,
        exports: duplicatePolicy.exports,
        runtimeModule: duplicatePolicy.runtimeModule,
        typeConsumer: duplicatePolicy.typeConsumer,
        natsExactOptionalPolicies: [
          { export: ".", directDependency: "@nats-io/transport-node" },
          { export: ".", directDependency: "@nats-io/jetstream" }
        ]
      })
    ).toThrow("unknown NATS exact-optional policy")
  })

  test("preserves exact per-export source overrides for future hybrid lanes", () => {
    const registry = newBusinessCaseRegistry()
    const rootRuntime = 'import "@fixture/hybrid"\nexport async function run() {}\n'
    const nodeRuntime = 'import "@fixture/hybrid/node"\nexport async function run() {}\n'
    const rootTypes =
      'import type { Root } from "@fixture/hybrid"\ndeclare const rootValue: Root\nvoid rootValue\n'
    const nodeTypes =
      'import type { NodeValue } from "@fixture/hybrid/node"\ndeclare const nodeValue: NodeValue\nvoid nodeValue\n'
    registry.register({
      package: "@fixture/hybrid",
      exports: [".", "./node"],
      runtimeModule: rootRuntime,
      typeConsumer: `${rootTypes}${nodeTypes}`,
      runtimeModules: { ".": rootRuntime, "./node": nodeRuntime },
      typeConsumers: { ".": rootTypes, "./node": nodeTypes }
    })

    expect(registry.get("@fixture/hybrid")?.runtimeModules).toEqual({
      ".": rootRuntime,
      "./node": nodeRuntime
    })
    expect(registry.get("@fixture/hybrid")?.typeConsumers).toEqual({
      ".": rootTypes,
      "./node": nodeTypes
    })
  })

  test("preserves one strict Node-only preload and rejects unsafe preload imports", () => {
    const registry = newBusinessCaseRegistry()
    const valid = businessCase("@fixture/node-preload")
    const preload = 'import { registerHooks } from "node:module"\nvoid registerHooks\n'
    registry.register({
      package: valid.package,
      exports: valid.exports,
      runtimeModule: valid.runtimeModule,
      typeConsumer: valid.typeConsumer,
      nodePreloadModule: preload
    })
    expect(registry.get(valid.package)?.nodePreloadModule).toBe(preload)

    const invalidSources = [
      { source: "", message: "must be non-empty JavaScript" },
      { source: 'import "./fake.mjs"\n', message: "relative or direct dist import" },
      {
        source: 'import "@fixture/node-preload/dist/native.js"\n',
        message: "relative or direct dist import"
      },
      { source: 'await import("../fake.mjs")\n', message: "relative or direct dist import" },
      {
        source: "const specifier = 'node:module'\nawait import(specifier)\n",
        message: "non-literal dynamic import"
      },
      { source: "const value: number = 1\n", message: "syntactically scannable" },
      { source: "import {\n", message: "syntactically scannable" }
    ]
    for (const [index, invalid] of invalidSources.entries()) {
      const candidate = businessCase(`@fixture/node-preload-${index}`)
      expect(() =>
        registry.register({
          package: candidate.package,
          exports: candidate.exports,
          runtimeModule: candidate.runtimeModule,
          typeConsumer: candidate.typeConsumer,
          nodePreloadModule: invalid.source
        })
      ).toThrow(invalid.message)
    }
  })

  test("keeps independent published proofs for every config export", () => {
    const configCase = publishedBusinessCases().get("@likego/config")

    expect(configCase).not.toBeNull()
    expect(Object.keys(configCase?.runtimeModules ?? {}).sort()).toEqual([
      ".",
      "./env",
      "./file",
      "./node",
      "./yaml"
    ])
    expect(Object.keys(configCase?.typeConsumers ?? {}).sort()).toEqual([
      ".",
      "./env",
      "./file",
      "./node",
      "./yaml"
    ])

    const rootRuntime = configCase?.runtimeModules?.["."] ?? ""
    const envRuntime = configCase?.runtimeModules?.["./env"] ?? ""
    const fileRuntime = configCase?.runtimeModules?.["./file"] ?? ""
    const nodeRuntime = configCase?.runtimeModules?.["./node"] ?? ""
    const yamlRuntime = configCase?.runtimeModules?.["./yaml"] ?? ""
    for (const runtime of [envRuntime, fileRuntime, nodeRuntime, yamlRuntime]) {
      expect(runtime).toMatch(
        /import\s*\{[^}]*\bplaceholderResolver\b[^}]*\bresolver\b[^}]*\}\s*from "@likego\/config"/s
      )
    }
    expect(envRuntime).toContain('from "@likego/config/env"')
    expect(envRuntime).toContain("envSource")
    expect(fileRuntime).toContain('from "@likego/config/file"')
    expect(fileRuntime).toContain("fileSource")
    expect(nodeRuntime).toContain('from "@likego/config/node"')
    expect(nodeRuntime).toContain("newNodeFileCapability")
    expect(yamlRuntime).toContain('from "@likego/config/yaml"')
    expect(yamlRuntime).toContain("decodeYaml")
    expect(fileRuntime).toContain("runConfigSubpathFixture")
    expect(envRuntime).not.toBe(rootRuntime)
    expect(fileRuntime).not.toBe(rootRuntime)
    expect(nodeRuntime).not.toBe(rootRuntime)
    expect(yamlRuntime).not.toBe(rootRuntime)

    expect(configCase?.typeConsumers?.["./env"]).toContain('from "@likego/config/env"')
    expect(configCase?.typeConsumers?.["./file"]).toContain('from "@likego/config/file"')
    expect(configCase?.typeConsumers?.["./node"]).toContain('from "@likego/config/node"')
    expect(configCase?.typeConsumers?.["./yaml"]).toContain('from "@likego/config/yaml"')
  })

  test("keeps a real published exchange and public types for Memory Transport", () => {
    const transportCase = publishedBusinessCases().get("@likego/transport")
    const memoryCase = publishedBusinessCases().get("@likego/transport-memory")

    expect(transportCase?.runtimeModule).toContain('getBuiltinModule("vm")')
    expect(transportCase?.runtimeModule).not.toContain('from "node:vm"')
    expect(memoryCase?.runtimeModule).toContain('from "@likego/transport-memory"')
    expect(memoryCase?.runtimeModule).toContain('getBuiltinModule("vm")')
    expect(memoryCase?.runtimeModule).not.toContain('from "node:vm"')
    expect(memoryCase?.runtimeModule).toContain("newMemoryTransport")
    expect(memoryCase?.runtimeModule).toContain("listener.accept")
    expect(memoryCase?.typeConsumer).toContain('from "@likego/transport-memory"')
    expect(memoryCase?.typeConsumer).toContain("type MemoryTransport")
  })

  test("waits for the published Server listener instead of guessing scheduler progress", () => {
    const runtime = publishedBusinessCases().get("@likego/server")?.runtimeModule ?? ""

    expect(runtime).toContain("const accepting = Promise.withResolvers()")
    expect(runtime).toContain("accepting.resolve()")
    expect(runtime).toContain("await accepting.promise")
    expect(runtime).not.toContain("await Promise.resolve()")
  })

  test("keeps portable Store types independent from internal testing and Node host lanes", () => {
    const storeCase = publishedBusinessCases().get("@likego/store")
    const fileCase = publishedBusinessCases().get("@likego/store-file")

    expect(storeCase?.exports).toEqual([".", "./provider"])
    expect(storeCase?.typeConsumers).toBeUndefined()
    expect(storeCase?.typeConsumer).toContain('from "@likego/store"')
    expect(storeCase?.typeConsumer).toContain('from "@likego/store/provider"')
    expect(storeCase?.typeConsumer).not.toContain("@likego/store/testing")

    expect(Object.keys(fileCase?.typeConsumers ?? {}).sort()).toEqual([".", "./node"])
    expect(fileCase?.typeConsumers?.["."]).toContain('from "@likego/store-file"')
    expect(fileCase?.typeConsumers?.["."]).not.toContain("@likego/store-file/node")
    expect(fileCase?.typeConsumers?.["./node"]).toContain('from "@likego/store-file/node"')
  })

  test("keeps memory Store and Broker behavior runtime-neutral", () => {
    const providers = [
      ["@likego/store-memory", "newMemoryStore"],
      ["@likego/broker-memory", "newMemoryBroker"]
    ] as const

    for (const [packageName, apiMarker] of providers) {
      const businessCase = publishedBusinessCases().get(packageName)
      const runtimeModule = businessCase?.runtimeModule ?? ""
      expect(businessCase?.exports).toEqual(["."])
      expect(runtimeModule).toContain(`from "${packageName}"`)
      expect(runtimeModule).toContain(apiMarker)
      expect(runtimeModule).not.toContain("Bun.")
      expect(businessCase?.typeConsumer).toContain(`from "${packageName}"`)
    }
  })

  test("keeps completion provider behavior runtime-neutral", () => {
    const providers = [
      ["@likego/config-vault", "vaultSource"],
      ["@likego/store-consul", "newConsulStore"],
      ["@likego/store-etcd", "newEtcdStore"],
      ["@likego/store-vault", "newVaultStore"]
    ] as const

    for (const [packageName, apiMarker] of providers) {
      const runtimeModule = publishedBusinessCases().get(packageName)?.runtimeModule ?? ""

      expect(runtimeModule).toContain(`from "${packageName}"`)
      expect(runtimeModule).toContain(apiMarker)
      expect(runtimeModule).not.toContain("Bun.")
    }
  })

  test("keeps portable and Node Web exports in independent published lanes", () => {
    const webCase = publishedBusinessCases().get("@likego/web")

    expect(webCase).not.toBeNull()
    expect(Object.keys(webCase?.runtimeModules ?? {}).sort()).toEqual([".", "./health", "./node"])
    expect(Object.keys(webCase?.typeConsumers ?? {}).sort()).toEqual([".", "./health", "./node"])

    const portableTypes = webCase?.typeConsumers?.["."] ?? ""
    const healthTypes = webCase?.typeConsumers?.["./health"] ?? ""
    const nodeRuntime = webCase?.runtimeModules?.["./node"] ?? ""
    expect(portableTypes).toContain('from "@likego/web"')
    expect(portableTypes).not.toContain("@likego/web/node")
    expect(healthTypes).toContain('from "@likego/web/health"')
    expect(healthTypes).not.toContain("@likego/web/node")
    expect(nodeRuntime).toContain('from "@likego/web/node"')
  })

  test("keeps the go-micro-style unary Client published proof", () => {
    const clientCase = publishedBusinessCases().get("@likego/client")
    const runtime = clientCase?.runtimeModule ?? ""
    const types = clientCase?.typeConsumer ?? ""

    expect(clientCase).not.toBeNull()
    expect(runtime).toContain('from "@likego/client"')
    expect(runtime).toContain("newClient")
    expect(runtime).toContain("closeTimeout")
    expect(runtime).toContain("circuitBreakerMiddleware")
    expect(runtime).toContain("Client operation circuit breaker changed")
    expect(runtime).toContain("observed === cleanupFailure")
    expect(runtime).toContain("Client resident cleanup failure changed")
    expect(runtime).toContain(".call(")
    expect(runtime).toContain("Likego-Service")
    expect(runtime).toContain("Likego-Endpoint")
    expect(runtime).toContain("discover,select,dial,send,recv,feedback,middleware.after,close")
    expect(runtime).not.toContain("void [identity")
    expect(types).toContain("CallRequest")
    expect(types).toContain("type Client")
    expect(types).toContain("newClient")
    expect(types).toContain("closeTimeout")
    expect(types).toContain("circuitBreakerMiddleware")
    expect(types).toContain("type BodyCodec")
    expect(types).toContain('use("orders/*", layer)')
    expect(types).not.toContain("ResidentClient")
  })

  test("keeps the go-micro-style internal Server published proof", () => {
    const serverCase = publishedBusinessCases().get("@likego/server")
    const runtime = serverCase?.runtimeModule ?? ""
    const types = serverCase?.typeConsumer ?? ""

    expect(serverCase).not.toBeNull()
    expect(runtime).toContain('from "@likego/server"')
    expect(runtime).toContain("newServer")
    expect(runtime).toContain("handler")
    expect(runtime).toContain("rateLimitMiddleware")
    expect(runtime).toContain("Server rate limiter changed")
    expect(runtime).toContain("server.stop")
    expect(runtime).toContain("orders.get")
    expect(runtime).not.toContain("registeredFetchService")
    expect(types).toContain("newServer")
    expect(types).toContain("rateLimitMiddleware")
    expect(types).toContain("type Server")
    expect(types).not.toContain("ServiceDeclaration")
  })

  test("runs real published behavior for every Web framework bridge", () => {
    const expected = [
      ["@likego/elysia", "newElysiaHandler", 'from "elysia"'],
      ["@likego/h3", "newH3Handler", 'from "h3"'],
      ["@likego/hono", "newHonoHandler", 'from "hono"']
    ] as const

    for (const [packageName, factory, nativeImport] of expected) {
      const businessCase = publishedBusinessCases().get(packageName)
      const runtime = businessCase?.runtimeModule ?? ""

      expect(businessCase).not.toBeNull()
      expect(runtime).toContain(`from "${packageName}"`)
      expect(runtime).toContain(nativeImport)
      expect(runtime).toContain(factory)
      expect(runtime).toContain("new Request")
      expect(runtime).toContain(".json()")
      expect(runtime).not.toContain("void [identity")
    }

    const h3Runtime = publishedBusinessCases().get("@likego/h3")?.runtimeModule ?? ""
    expect(h3Runtime).toContain("createApp")
    expect(h3Runtime).toContain("createRouter")
    expect(h3Runtime).toContain("defineEventHandler")
    expect(h3Runtime).toContain("getRouterParam")
    expect(h3Runtime).not.toContain("new H3()")
  })

  test("keeps framework type consumers on their native application boundaries", () => {
    const elysiaTypes = publishedBusinessCases().get("@likego/elysia")?.typeConsumer ?? ""
    expect(elysiaTypes).toContain("ElysiaApplication")
    expect(elysiaTypes).toContain("fetch: (_request: Request) => new Response()")
    expect(elysiaTypes).not.toContain('from "elysia"')

    const h3Types = publishedBusinessCases().get("@likego/h3")?.typeConsumer ?? ""
    expect(h3Types).toContain("H3Application")
    expect(h3Types).toContain("createApp")
    expect(h3Types).toContain('from "h3"')
    expect(h3Types).not.toContain("fetch: (_request: Request) => new Response()")
  })

  test("keeps independent behavioral proofs for every transport export", () => {
    const transportCase = publishedBusinessCases().get("@likego/transport")

    expect(transportCase).not.toBeNull()
    expect(Object.keys(transportCase?.runtimeModules ?? {}).sort()).toEqual([
      ".",
      "./headers",
      "./json",
      "./provider"
    ])
    expect(Object.keys(transportCase?.typeConsumers ?? {}).sort()).toEqual([
      ".",
      "./headers",
      "./json",
      "./provider"
    ])

    const rootRuntime = transportCase?.runtimeModules?.["."] ?? ""
    const headersRuntime = transportCase?.runtimeModules?.["./headers"] ?? ""
    const jsonRuntime = transportCase?.runtimeModules?.["./json"] ?? ""
    const providerRuntime = transportCase?.runtimeModules?.["./provider"] ?? ""
    expect(rootRuntime).toContain('from "@likego/transport"')
    expect(rootRuntime).toContain("snapshotMessage")
    expect(headersRuntime).toContain('from "@likego/transport/headers"')
    expect(headersRuntime).toContain("Likego-Topic")
    expect(jsonRuntime).toContain('from "@likego/transport/json"')
    expect(jsonRuntime).toContain("jsonCodec")
    expect(providerRuntime).toContain('from "@likego/transport/provider"')
    expect(rootRuntime).not.toContain("void [identity")
    expect(headersRuntime).not.toContain("void [identity")
  })

  test("keeps the complete Consul lifecycle and redirect proof in its published authority", () => {
    const consulCase = publishedBusinessCases().get("@likego/registry-consul")
    const runtime = consulCase?.runtimeModule ?? ""
    const types = consulCase?.typeConsumer ?? ""

    expect(consulCase).not.toBeNull()
    expect(runtime).toContain('from "@likego/registry-consul"')
    expect(runtime).toContain("await registry.register")
    expect(runtime).toContain("await registry.getService")
    expect(runtime).toContain("await registry.deregister")
    expect(runtime).toContain("register exposed a private handle")
    expect(types).toContain("deregisterCriticalServiceAfterMs")
    expect(types).toContain("ConsulTransportError")
  })

  test("keeps independent behavioral proofs for every mDNS Registry export", () => {
    const mdnsCase = publishedBusinessCases().get("@likego/registry-mdns")

    expect(mdnsCase).not.toBeNull()
    expect(Object.keys(mdnsCase?.runtimeModules ?? {}).sort()).toEqual([".", "./node"])
    expect(Object.keys(mdnsCase?.typeConsumers ?? {}).sort()).toEqual([".", "./node"])

    const rootRuntime = mdnsCase?.runtimeModules?.["."] ?? ""
    const nodeRuntime = mdnsCase?.runtimeModules?.["./node"] ?? ""
    expect(rootRuntime).toContain('from "@likego/registry-mdns"')
    expect(rootRuntime).toContain("newMDNSRegistry")
    expect(rootRuntime).toContain("conformanceScenario")
    expect(rootRuntime).toContain("lifecycleScenario")
    expect(nodeRuntime).toContain('from "@likego/registry-mdns/node"')
    expect(nodeRuntime).toContain("newNodeMDNSHost")
    expect(nodeRuntime).toContain("bindDatagram")
    expect(nodeRuntime).not.toContain("newNodeMDNSHostWithFactory")
    expect(rootRuntime).not.toContain("void [identity")
    expect(nodeRuntime).not.toContain("void [identity")
  })

  test("keeps independent behavioral proofs for every HTTP Transport export", () => {
    const httpCase = publishedBusinessCases().get("@likego/transport-http")

    expect(httpCase).not.toBeNull()
    expect(Object.keys(httpCase?.runtimeModules ?? {}).sort()).toEqual([".", "./node"])
    expect(Object.keys(httpCase?.typeConsumers ?? {}).sort()).toEqual([".", "./node"])

    const rootRuntime = httpCase?.runtimeModules?.["."] ?? ""
    const rootTypes = httpCase?.typeConsumers?.["."] ?? ""
    const nodeRuntime = httpCase?.runtimeModules?.["./node"] ?? ""
    expect(rootRuntime).toContain('from "@likego/transport-http"')
    expect(rootRuntime).toContain("newHTTPTransport")
    expect(rootTypes).toContain("type HTTPTransport")
    expect(rootTypes).toContain("maxMessageBytes")
    expect(nodeRuntime).toContain('from "@likego/transport-http/node"')
    expect(nodeRuntime).toContain("newNodeHTTPTransport")
    expect(rootRuntime).not.toContain("void [identity")
    expect(nodeRuntime).not.toContain("void [identity")
  })

  test("rejects relative and direct dist imports", () => {
    const registry = newBusinessCaseRegistry()
    expect(() =>
      registry.register({
        package: "@likego/relative",
        exports: ["."],
        runtimeModule:
          'import { value } from "../../packages/relative/dist/index.js"\nexport async function run() { void value }\n',
        typeConsumer:
          'import type { Value } from "@likego/relative"\nvoid (null satisfies Value | null)\n'
      })
    ).toThrow("relative or direct dist import")
  })
})

describe("published package inventory and stage", () => {
  test("discovers the exact final 46-package and 67-export release inventory", async () => {
    const expected = {
      "@likego/broker": [".", "./provider"],
      "@likego/broker-memory": ["."],
      "@likego/broker-rabbitmq": ["."],
      "@likego/bullmq": ["."],
      "@likego/cache": [".", "./provider"],
      "@likego/cache-memory": ["."],
      "@likego/cache-redis": ["."],
      "@likego/client": ["."],
      "@likego/config": [".", "./env", "./file", "./node", "./yaml"],
      "@likego/config-consul": ["."],
      "@likego/config-etcd": ["."],
      "@likego/config-kubernetes": ["."],
      "@likego/config-vault": ["."],
      "@likego/context": ["."],
      "@likego/core": [".", "./lifecycle", "./node"],
      "@likego/create": ["."],
      "@likego/croner": ["."],
      "@likego/elysia": ["."],
      "@likego/event": ["."],
      "@likego/h3": ["."],
      "@likego/health": ["."],
      "@likego/hono": ["."],
      "@likego/metadata": ["."],
      "@likego/nats": [".", "./broker", "./jetstream", "./jetstream/broker"],
      "@likego/otel": ["."],
      "@likego/pino": ["."],
      "@likego/prometheus": ["."],
      "@likego/registry": [".", "./provider"],
      "@likego/registry-consul": ["."],
      "@likego/registry-etcd": ["."],
      "@likego/registry-kubernetes": ["."],
      "@likego/registry-mdns": [".", "./node"],
      "@likego/registry-zookeeper": ["."],
      "@likego/resilience": ["."],
      "@likego/server": ["."],
      "@likego/store": [".", "./provider"],
      "@likego/store-consul": ["."],
      "@likego/store-etcd": ["."],
      "@likego/store-file": [".", "./node"],
      "@likego/store-memory": ["."],
      "@likego/store-vault": ["."],
      "@likego/transport": [".", "./headers", "./json", "./provider"],
      "@likego/transport-http": [".", "./node"],
      "@likego/transport-memory": ["."],
      "@likego/web": [".", "./health", "./node"],
      "@likego/winston": ["."]
    }
    const inventory = await discoverPublishedPackages(join(import.meta.dir, "../.."))
    const actual: Record<string, readonly string[]> = {}
    for (const subject of inventory.packages.filter((subject) => subject.releaseBlocking)) {
      actual[subject.name] = subject.exports.map((publishedExport) => publishedExport.name).sort()
    }

    expect(actual).toEqual(expected)
    expect(Object.values(actual).reduce((total, exports) => total + exports.length, 0)).toBe(67)
  })

  test("locks the full gate to 46 exact release packages and business cases", async () => {
    const repositoryRoot = join(import.meta.dir, "../..")
    const inventory = await discoverPublishedPackages(repositoryRoot)
    const releasePackages = inventory.packages
      .filter((subject) => subject.releaseBlocking)
      .map((subject) => subject.name)
    const cases = publishedBusinessCases()
      .list()
      .map((businessCase) => businessCase.package)

    expect(() => validatePublishedReleaseInventory(releasePackages, cases)).not.toThrow()
    expect(() => validatePublishedReleaseInventory(releasePackages.slice(1), cases)).toThrow(
      "requires exactly 46"
    )
    const driftedCases = Array.from(cases)
    driftedCases[0] = "@likego/unregistered"
    expect(() => validatePublishedReleaseInventory(releasePackages, driftedCases)).toThrow(
      "business-case inventory drifted"
    )
  })

  test("keeps selected evidence separate and clears stale canonical artifacts", async () => {
    const root = await rootFixture()
    const full = publishedGateArtifactPath(root, "runtime", "full")
    const selected = publishedGateArtifactPath(root, "runtime", "selected")
    expect(full).not.toBe(selected)
    await mkdir(join(root, ".artifacts", "published"), { recursive: true })
    await Bun.write(full, "stale full\n")
    await Bun.write(selected, "stale selected\n")

    await clearPublishedGateArtifacts(root, "runtime")

    expect(await Bun.file(full).exists()).toBe(false)
    expect(await Bun.file(selected).exists()).toBe(false)
  })

  test("discovers a publishable parent and its explicitly nested child workspace", async () => {
    const root = await rootFixture()
    await writeJson(join(root, "package.json"), {
      name: "likego-published-fixture",
      private: true,
      packageManager: "bun@1.3.14",
      workspaces: ["packages/*", "packages/config/consul"]
    })
    await writePackage(root, "packages/config", "@likego/config")
    await writePackage(root, "packages/config/consul", "@likego/config-consul")

    const inventory = await discoverPublishedPackages(root)

    expect(inventory.packages.map((subject) => subject.name)).toEqual([
      "@likego/config",
      "@likego/config-consul"
    ])
  })

  test("discovers exact capability rows and rejects duplicate package ownership", async () => {
    const root = await rootFixture()
    await writePackage(root, "packages/one", "@likego/one")
    await writePackage(root, "adapters/two", "@likego/one")
    await expect(discoverPublishedPackages(root)).rejects.toThrow(
      "duplicate workspace package name"
    )
  })

  test("keeps hybrid runtime support on its individual published export lanes", async () => {
    const root = await rootFixture()
    await writePackage(root, "packages/hybrid", "@likego/hybrid")
    const packageRoot = join(root, "packages/hybrid")
    await writeJson(join(packageRoot, "package.json"), {
      name: "@likego/hybrid",
      version: "0.1.0",
      private: false,
      type: "module",
      exports: {
        ".": "./src/index.ts",
        "./node": "./src/node.ts"
      },
      dependencies: {},
      license: "MIT",
      files: ["dist"]
    })
    await writeJson(join(packageRoot, "capability.json"), {
      schemaVersion: 2,
      package: "@likego/hybrid",
      packageKind: "hybrid",
      stability: "provisional",
      releaseBlocking: true,
      exports: {
        ".": {
          kind: "portable",
          residency: "non-resident",
          ownerResources: [],
          capabilities: ["web"],
          runtimes: [
            {
              runtime: "deno",
              lane: "exact",
              minimumVersion: "2.9.4",
              testedVersions: ["2.9.4"],
              terminalObservability: "not-applicable"
            }
          ]
        },
        "./node": {
          kind: "integration",
          residency: "resident",
          ownerResources: ["node-server"],
          capabilities: ["server"],
          runtimes: [
            {
              runtime: "node",
              lane: "current",
              minimumVersion: "26.5.0",
              testedVersions: ["26.5.0"],
              terminalObservability: "observable"
            }
          ]
        }
      }
    })

    const inventory = await discoverPublishedPackages(root)
    const subject = inventory.byName.get("@likego/hybrid")
    if (subject === undefined) throw new Error("hybrid fixture was not discovered")

    expect(subject.packageKind).toBe("hybrid")
    expect(subject.exports).toEqual([
      {
        name: ".",
        kind: "portable",
        residency: "non-resident",
        ownerResources: [],
        capabilities: ["web"],
        runtimes: [{ runtime: "deno", lane: "exact", version: "2.9.4" }]
      },
      {
        name: "./node",
        kind: "integration",
        residency: "resident",
        ownerResources: ["node-server"],
        capabilities: ["server"],
        runtimes: [{ runtime: "node", lane: "current", version: "26.5.0" }]
      }
    ])
    expect("runtimes" in subject).toBe(false)
  })

  test("requires runtime coverage only for each hybrid export reachable closure", async () => {
    const root = await rootFixture()
    await writeJson(join(root, "deno.json"), {
      compilerOptions: { strict: true }
    })
    await writePackage(root, "packages/hybrid", "@fixture/hybrid-runtime")
    const packageRoot = join(root, "packages/hybrid")
    const hybridManifest = {
      name: "@fixture/hybrid-runtime",
      version: "0.1.0",
      private: false,
      type: "module",
      exports: {
        ".": "./src/index.ts",
        "./node": "./src/node.ts"
      },
      dependencies: {},
      license: "MIT",
      files: ["dist"]
    }
    await writeJson(join(packageRoot, "package.json"), hybridManifest)
    const nodeRuntimeRow = {
      runtime: "node",
      lane: "current",
      minimumVersion: "26.5.0",
      testedVersions: ["26.5.0"],
      terminalObservability: "not-applicable"
    }
    const denoRuntimeRow = {
      runtime: "deno",
      lane: "exact",
      minimumVersion: "2.9.4",
      testedVersions: ["2.9.4"],
      terminalObservability: "not-applicable"
    }
    await writeJson(join(packageRoot, "capability.json"), {
      schemaVersion: 2,
      package: "@fixture/hybrid-runtime",
      packageKind: "hybrid",
      stability: "provisional",
      releaseBlocking: true,
      exports: {
        ".": {
          kind: "portable",
          residency: "non-resident",
          ownerResources: [],
          capabilities: ["web"],
          runtimes: [denoRuntimeRow]
        },
        "./node": {
          kind: "integration",
          residency: "non-resident",
          ownerResources: [],
          capabilities: ["server"],
          runtimes: [nodeRuntimeRow]
        }
      }
    })
    await Bun.write(
      join(packageRoot, "src/index.ts"),
      'export { portableValue } from "./portable"\n'
    )
    await Bun.write(
      join(packageRoot, "src/portable.ts"),
      "export function portableValue(): number { return 1 }\n"
    )
    await Bun.write(
      join(packageRoot, "src/node.ts"),
      "export function nodeValue(): number { return 2 }\n"
    )
    await Bun.write(
      join(packageRoot, "dist/index.js"),
      'export { portableValue } from "./portable.js"\n'
    )
    await Bun.write(
      join(packageRoot, "dist/index.d.ts"),
      'export { portableValue } from "./portable.js"\n'
    )
    await Bun.write(
      join(packageRoot, "dist/portable.js"),
      "export function portableValue() { return 1 }\n"
    )
    await Bun.write(
      join(packageRoot, "dist/portable.d.ts"),
      "export declare function portableValue(): number\n"
    )
    await Bun.write(join(packageRoot, "dist/node.js"), "export function nodeValue() { return 2 }\n")
    await Bun.write(
      join(packageRoot, "dist/node.d.ts"),
      "export declare function nodeValue(): number\n"
    )
    await writeJson(
      join(packageRoot, "dist/package.json"),
      distPackageManifest(hybridManifest, new Map())
    )
    await prepareFixtureLock(root)
    const inventory = await discoverPublishedPackages(root)
    await writePublishedBuildStamp(root, inventory)
    const subject = inventory.byName.get("@fixture/hybrid-runtime")
    if (subject === undefined) throw new Error("hybrid runtime fixture was not discovered")
    const rootRuntime = [
      'import { portableValue } from "@fixture/hybrid-runtime"',
      "export async function run() {",
      '  if (portableValue() !== 1) throw new Error("portable export failed")',
      "}",
      ""
    ].join("\n")
    const nodeRuntime = [
      'import { nodeValue } from "@fixture/hybrid-runtime/node"',
      "export async function run() {",
      '  if (nodeValue() !== 2) throw new Error("node export failed")',
      "}",
      ""
    ].join("\n")
    const result = await runPublishedRuntimePackage(root, inventory, subject, {
      package: "@fixture/hybrid-runtime",
      exports: [".", "./node"],
      runtimeModule: rootRuntime,
      typeConsumer: [
        'import { portableValue } from "@fixture/hybrid-runtime"',
        'import { nodeValue } from "@fixture/hybrid-runtime/node"',
        "void [portableValue, nodeValue]",
        ""
      ].join("\n"),
      runtimeModules: { ".": rootRuntime, "./node": nodeRuntime }
    })

    expect(result.expectedRows).toBe(2)
    expect(result.checkedRows).toBe(2)
    expect(
      result.evidence.map((entry) => [entry.export, entry.runtime, entry.passed, entry.detail])
    ).toEqual([
      [".", "deno", true, null],
      ["./node", "node", true, null]
    ])
    expect(result.passed).toBe(true)
  })

  test("packs and npm-installs only publish files for the complete workspace dependency closure", async () => {
    const root = await rootFixture()
    await writePackage(root, "packages/dependency", "@likego/dependency")
    await writePackage(root, "packages/target", "@likego/target", {
      "@likego/dependency": "workspace:*"
    })
    await writePackage(root, "examples/not-published", "@likego/example-not-published")
    await prepareFixtureLock(root)
    const inventory = await discoverPublishedPackages(root)
    await writePublishedBuildStamp(root, inventory)
    const stage = await stagePublishedPackage(root, inventory, "@likego/target")
    roots.push(stage.root)

    expect((await stat(join(stage.root, "node_modules/@likego/target/index.js"))).isFile()).toBe(
      true
    )
    expect(
      (await stat(join(stage.root, "node_modules/@likego/dependency/index.js"))).isFile()
    ).toBe(true)
    expect(
      await Bun.file(join(stage.root, "node_modules/@likego/target/src/index.ts")).exists()
    ).toBe(false)
    const installedManifest: unknown = await Bun.file(
      join(stage.root, "node_modules/@likego/target/package.json")
    ).json()
    expect(installedManifest).toMatchObject({
      dependencies: { "@likego/dependency": "0.1.0" }
    })
    expect(await Bun.file(join(stage.root, "node_modules/@likego/target/LICENSE")).text()).toBe(
      "MIT fixture license\n"
    )
    expect(stage.workspacePackages).toEqual(["@likego/dependency", "@likego/target"])
    expect(inventory.byName.has("@likego/example-not-published")).toBe(false)
  })

  test("real parent tarballs exclude config registry and transport child workspaces", async () => {
    const root = await rootFixture()
    await writeJson(join(root, "package.json"), {
      name: "likego-published-fixture",
      private: true,
      packageManager: "bun@1.3.14",
      workspaces: [
        "packages/*",
        "packages/config/consul",
        "packages/registry/mdns",
        "packages/transport/http"
      ]
    })
    const subjects = [
      {
        parentRoot: "packages/config",
        parentName: "@likego/config",
        childRoot: "packages/config/consul",
        childName: "@likego/config-consul",
        childDirectory: "consul"
      },
      {
        parentRoot: "packages/registry",
        parentName: "@likego/registry",
        childRoot: "packages/registry/mdns",
        childName: "@likego/registry-mdns",
        childDirectory: "mdns"
      },
      {
        parentRoot: "packages/transport",
        parentName: "@likego/transport",
        childRoot: "packages/transport/http",
        childName: "@likego/transport-http",
        childDirectory: "http"
      }
    ]
    for (const subject of subjects) {
      await writePackage(root, subject.parentRoot, subject.parentName)
      await writePackage(root, subject.childRoot, subject.childName)
    }
    await prepareFixtureLock(root)
    const inventory = await discoverPublishedPackages(root)
    await writePublishedBuildStamp(root, inventory)

    for (const subject of subjects) {
      const stage = await stagePublishedPackage(root, inventory, subject.parentName)
      roots.push(stage.root)
      const installedRoot = join(
        stage.root,
        "node_modules",
        subject.parentName,
        subject.childDirectory
      )
      expect(await Bun.file(join(installedRoot, "package.json")).exists()).toBe(false)
      expect(await Bun.file(join(installedRoot, "src/index.ts")).exists()).toBe(false)
      expect(await Bun.file(join(installedRoot, "test/containment-sentinel.ts")).exists()).toBe(
        false
      )
      expect(await Bun.file(join(installedRoot, "dist/index.js")).exists()).toBe(false)
    }
  })

  test("creates a Deno-visible publish mirror without exposing workspace source", async () => {
    const root = await rootFixture()
    await writePackage(root, "packages/dependency", "@likego/dependency")
    await writePackage(root, "packages/target", "@likego/target", {
      "@likego/dependency": "workspace:*"
    })
    await prepareFixtureLock(root)
    const inventory = await discoverPublishedPackages(root)
    await writePublishedBuildStamp(root, inventory)
    const stage = await stagePublishedPackage(root, inventory, "@likego/target")
    roots.push(stage.root)

    const importMapPath = await prepareDenoPackageStage(stage)
    const importMap: unknown = await Bun.file(importMapPath).json()

    expect(importMap).toEqual({
      imports: {
        "@likego/dependency": "./deno_modules/@likego/dependency/index.js",
        "@likego/target": "./deno_modules/@likego/target/index.js"
      }
    })
    expect(
      await Bun.file(join(stage.root, "deno_modules/@likego/target/src/index.ts")).exists()
    ).toBe(false)
  })

  test("rejects stale build output before staging", async () => {
    const root = await rootFixture()
    await writePackage(root, "packages/stale", "@likego/stale")
    await prepareFixtureLock(root)
    const inventory = await discoverPublishedPackages(root)
    await writePublishedBuildStamp(root, inventory)
    await new Promise((resolve) => setTimeout(resolve, 5))
    await Bun.write(join(root, "packages/stale/src/index.ts"), "export const value = 2\n")
    await expect(stagePublishedPackage(root, inventory, "@likego/stale")).rejects.toThrow(
      "build inputs changed"
    )
  })

  test("binds explicitly nested workspace sources into the shared build stamp", async () => {
    const root = await rootFixture()
    await writeJson(join(root, "package.json"), {
      name: "likego-published-fixture",
      private: true,
      packageManager: "bun@1.3.14",
      workspaces: ["packages/*", "packages/config/consul"]
    })
    await writePackage(root, "packages/config", "@likego/config")
    await writePackage(root, "packages/config/consul", "@likego/config-consul")
    await prepareFixtureLock(root)
    const inventory = await discoverPublishedPackages(root)
    await writePublishedBuildStamp(root, inventory)
    await new Promise((resolve) => setTimeout(resolve, 5))
    await Bun.write(join(root, "packages/config/consul/src/index.ts"), "export const value = 2\n")

    await expect(stagePublishedPackage(root, inventory, "@likego/config")).rejects.toThrow(
      "build inputs changed"
    )
  })

  test("rejects every root bundler input drift after a successful build", async () => {
    const root = await rootFixture()
    await writePackage(root, "packages/target", "@likego/target")
    await prepareFixtureLock(root)
    const inventory = await discoverPublishedPackages(root)
    const paths = [
      "tsconfig.base.json",
      "bun.lock",
      "scripts/annotate-dist.ts",
      "scripts/package-dist.ts",
      "tools/workspaces/discovery.ts",
      "tsconfig.tsdown.json",
      "tsdown.config.ts"
    ]
    for (const path of paths) {
      const absolutePath = join(root, path)
      const original = await Bun.file(absolutePath).text()
      await writePublishedBuildStamp(root, inventory)
      await Bun.write(absolutePath, `${original}\n`)
      await expect(stagePublishedPackage(root, inventory, "@likego/target")).rejects.toThrow(
        "build inputs changed"
      )
      await Bun.write(absolutePath, original)
    }
  })

  test("rejects package documentation input drift after a successful build", async () => {
    const root = await rootFixture()
    await writePackage(root, "packages/target", "@likego/target")
    await prepareFixtureLock(root)
    const inventory = await discoverPublishedPackages(root)

    for (const path of ["packages/target/README.md", "packages/target/LICENSE"]) {
      const absolutePath = join(root, path)
      const original = await Bun.file(absolutePath).text()
      await writePublishedBuildStamp(root, inventory)
      await Bun.write(absolutePath, `${original}changed\n`)
      await expect(stagePublishedPackage(root, inventory, "@likego/target")).rejects.toThrow(
        "build inputs changed"
      )
      await Bun.write(absolutePath, original)
    }
  })

  test("rejects copied documentation and dist manifest output drift after a successful build", async () => {
    const root = await rootFixture()
    await writePackage(root, "packages/target", "@likego/target")
    await prepareFixtureLock(root)
    const inventory = await discoverPublishedPackages(root)

    for (const path of [
      "packages/target/dist/README.md",
      "packages/target/dist/LICENSE",
      "packages/target/dist/package.json"
    ]) {
      const absolutePath = join(root, path)
      const original = await Bun.file(absolutePath).text()
      await writePublishedBuildStamp(root, inventory)
      await Bun.write(absolutePath, `${original}\n`)
      await expect(stagePublishedPackage(root, inventory, "@likego/target")).rejects.toThrow(
        "stale distribution output"
      )
      await Bun.write(absolutePath, original)
    }
  })
})

describe("native coverage evidence", () => {
  test("adds a declared preload only to Node test commands", () => {
    expect(publishedNodeTestArgs(false, ["--test", "node-case.test.mjs"])).toEqual([
      "node",
      "--test",
      "node-case.test.mjs"
    ])
    expect(publishedNodeTestArgs(true, ["--test", "node-case.test.mjs"])).toEqual([
      "node",
      "--import=./node-preload.mjs",
      "--test",
      "node-case.test.mjs"
    ])
    expect(nodeCoverageArgs("@likego/registry", ".artifacts/node.lcov", false)).toEqual([
      "node",
      "--test",
      "--test-isolation=none",
      "--experimental-test-coverage",
      "--test-coverage-include=node_modules/@likego/registry/**/*.js",
      "--test-reporter=spec",
      "--test-reporter-destination=stdout",
      "--test-reporter=lcov",
      "--test-reporter-destination=.artifacts/node.lcov",
      "node-case.test.mjs"
    ])
  })

  test("preserves a failed coverage command before the inventory mismatch", () => {
    expect(
      publishedCoverageDetail(
        "node-lts published coverage",
        {
          exitCode: 1,
          stdout: "first failing test\n",
          stderr: "failure stack\n"
        },
        "published function inventory is incomplete"
      )
    ).toBe(
      [
        "node-lts published coverage failed with exit 1: first failing test\nfailure stack",
        "published function inventory is incomplete"
      ].join("\n")
    )
  })

  test("reports successful and empty failed coverage commands without inventing output", () => {
    expect(
      publishedCoverageDetail(
        "node-current published coverage",
        { exitCode: 0, stdout: "", stderr: "" },
        null
      )
    ).toBeNull()
    expect(
      publishedCoverageDetail(
        "node-current published coverage",
        { exitCode: 0, stdout: "", stderr: "" },
        "inventory mismatch"
      )
    ).toBe("inventory mismatch")
    expect(
      publishedCoverageDetail(
        "node-current published coverage",
        { exitCode: 1, stdout: "", stderr: "" },
        null
      )
    ).toBe("node-current published coverage failed with exit 1")
  })

  test("parses Node and Deno metric order without confusing branches and functions", () => {
    expect(parseNodeCoverage("all files | 91.25 | 82.50 | 73.75 |\n")).toEqual({
      lines: 91.25,
      functions: 73.75,
      branches: 82.5
    })
    expect(parseDenoCoverage("| All files | 82.5 | 73.8 | 91.3 |\n")).toEqual({
      lines: 91.3,
      functions: 73.8,
      branches: 82.5
    })
  })

  test("fails closed on zero subjects while retaining incomplete function evidence", () => {
    expect(() => parseNodeCoverage("no coverage table")).toThrow(
      "zero published-JS coverage subjects"
    )
    const targetDist = "/stage/node_modules/@likego/fixture/dist"
    const report = parsePublishedLcov(
      targetDist,
      [
        `SF:${targetDist}/index.js`,
        "FNF:1000000",
        "FNH:999999",
        "BRF:2",
        "BRH:1",
        "LF:2",
        "LH:1",
        "end_of_record",
        ""
      ].join("\n")
    )
    expect(() =>
      requirePublishedFileInventory(
        "node-current",
        report,
        new Set(["index.js"]),
        new Set(["index.js"])
      )
    ).not.toThrow()
    expect(report.counters.functions).toEqual({ found: 1_000_000, hit: 999_999 })
  })

  test("rejects impossible native LCOV counters before computing percentages", () => {
    const targetDist = "/stage/node_modules/@likego/fixture/dist"
    const lcov = (
      lineFound: number,
      lineHit: number,
      branchFound: number,
      branchHit: number,
      functionFound = 1,
      functionHit = 1
    ) =>
      [
        `SF:${targetDist}/index.js`,
        `FNF:${functionFound}`,
        `FNH:${functionHit}`,
        `BRF:${branchFound}`,
        `BRH:${branchHit}`,
        `LF:${lineFound}`,
        `LH:${lineHit}`,
        "end_of_record",
        ""
      ].join("\n")
    expect(() => parsePublishedLcov(targetDist, lcov(1, 2, 1, 1))).toThrow(
      "line hit count exceeds found count"
    )
    expect(() => parsePublishedLcov(targetDist, lcov(1, 1, 1, 2))).toThrow(
      "branch hit count exceeds found count"
    )
    expect(() => parsePublishedLcov(targetDist, lcov(1, 1, 1, 1, 1, 2))).toThrow(
      "function hit count exceeds found count"
    )
  })

  test("pins the exact Node LTS image and retains non-blocking line and branch evidence", () => {
    expect(nodeLtsImage).toBe(
      "node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d"
    )
    const targetDist = "/stage/node_modules/@likego/fixture/dist"
    const report = parsePublishedLcov(
      targetDist,
      [
        `SF:${targetDist}/index.js`,
        "FNF:1",
        "FNH:1",
        "BRF:2",
        "BRH:1",
        "LF:2",
        "LH:1",
        "end_of_record",
        ""
      ].join("\n")
    )
    expect(() =>
      requirePublishedFileInventory(
        "node-current",
        report,
        new Set(["index.js"]),
        new Set(["index.js"])
      )
    ).not.toThrow()
    expect(report.counters).toEqual({
      lines: { found: 2, hit: 1 },
      functions: { found: 1, hit: 1 },
      branches: { found: 2, hit: 1 }
    })
    expect(report.files[0]?.counters).toEqual(report.counters)
  })
})

describe("published TypeScript exception evidence", () => {
  const h3Diagnostics = [
    "node_modules/h3/dist/index.d.ts(3,49): error TS2591: Cannot find name 'node:http'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node` and then add 'node' to the types field in your tsconfig.",
    "node_modules/h3/dist/index.d.ts(4,94): error TS2591: Cannot find name 'node:http'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node` and then add 'node' to the types field in your tsconfig.",
    "node_modules/h3/dist/index.d.ts(7,26): error TS2591: Cannot find name 'node:stream'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node` and then add 'node' to the types field in your tsconfig.",
    "node_modules/h3/dist/index.d.ts(29,100): error TS2552: Cannot find name 'FetchEvent'. Did you mean 'TouchEvent'?",
    "node_modules/h3/dist/index.d.ts(458,11): error TS2591: Cannot find name 'Buffer'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node` and then add 'node' to the types field in your tsconfig.",
    "node_modules/h3/dist/index.d.ts(477,116): error TS2591: Cannot find name 'Buffer'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node` and then add 'node' to the types field in your tsconfig.",
    "node_modules/h3/dist/index.d.ts(978,31): error TS2591: Cannot find name 'Buffer'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node` and then add 'node' to the types field in your tsconfig."
  ].join("\n")
  const natsDiagnostics = [
    "/store/@nats-io/nats-core/lib/msg.d.ts(3,22): error TS2420: Class 'MsgImpl' incorrectly implements interface 'Msg'.",
    "  Types of property 'headers' are incompatible.",
    "    Type 'MsgHdrs | undefined' is not assignable to type 'MsgHdrs'.",
    "      Type 'undefined' is not assignable to type 'MsgHdrs'.",
    "/store/@nats-io/nats-core/lib/nats.d.ts(4,22): error TS2420: Class 'NatsConnectionImpl' incorrectly implements interface 'NatsConnection'.",
    "  Types of property 'info' are incompatible.",
    "    Type 'ServerInfo | undefined' is not assignable to type 'ServerInfo'.",
    "      Type 'undefined' is not assignable to type 'ServerInfo'."
  ].join("\n")

  test("accepts only the exact H3 1.15.11 upstream lib-check diagnostics", () => {
    expect(() => validateH3LibCheckException("7.0.2", "1.15.11", 1, h3Diagnostics)).not.toThrow()
    expect(() => validateH3LibCheckException("7.0.3", "1.15.11", 1, h3Diagnostics)).toThrow(
      "compiler drift"
    )
    expect(() => validateH3LibCheckException("7.0.2", "1.15.12", 1, h3Diagnostics)).toThrow(
      "SDK drift"
    )
    expect(() => validateH3LibCheckException("7.0.2", "1.15.11", 0, h3Diagnostics)).toThrow(
      "disappeared or changed exit status"
    )
    expect(() =>
      validateH3LibCheckException("7.0.2", "1.15.11", 1, `${h3Diagnostics}\nextra diagnostic`)
    ).toThrow("diagnostics drifted")
  })

  test("rejects weakening each published NATS source, factory, or constructor boundary", async () => {
    const root = await natsBoundaryRoot()
    const coreDeclaration = [
      'import type { Server } from "@likego/core"',
      'import type { Subscription } from "@nats-io/transport-node"',
      "export type NatsCoreSubscriptionFactory = () => Subscription | PromiseLike<Subscription>",
      "export type NatsCoreSubscriptionSource = Subscription | NatsCoreSubscriptionFactory",
      "export interface NatsCoreAlreadyStartedError extends Error { readonly code: string; readonly status: string }",
      "export interface NatsCoreUnexpectedExitError extends Error { readonly cause: Error | null }",
      "export interface NatsCoreDrainTimeoutError extends Error { readonly forced: true }",
      "export declare function natsCoreDrainTimeout(timeoutMs: number): unknown",
      "export declare function newNatsCoreServer(",
      "  source: NatsCoreSubscriptionSource,",
      "  ...options: readonly unknown[]",
      "): Server",
      ""
    ].join("\n")
    const jetStreamDeclaration = [
      'import type { Server } from "@likego/core"',
      'import type { ConsumerMessages } from "@nats-io/jetstream"',
      "export type NatsJetStreamMessagesFactory = () => ConsumerMessages | PromiseLike<ConsumerMessages>",
      "export type NatsJetStreamMessagesSource = ConsumerMessages | NatsJetStreamMessagesFactory",
      "export interface NatsJetStreamAlreadyStartedError extends Error { readonly code: string; readonly status: string }",
      "export interface NatsJetStreamUnexpectedExitError extends Error { readonly cause: Error | null }",
      "export interface NatsJetStreamCloseTimeoutError extends Error { readonly forced: true }",
      "export declare function natsJetStreamCloseTimeout(timeoutMs: number): unknown",
      "export declare function newNatsJetStreamServer(",
      "  source: NatsJetStreamMessagesSource,",
      "  ...options: readonly unknown[]",
      "): Server",
      ""
    ].join("\n")
    await writeDeclarationPackage(
      root,
      "@likego/nats",
      {
        ".": "./index.d.ts",
        "./jetstream": "./jetstream.d.ts"
      },
      {
        "index.d.ts": coreDeclaration,
        "jetstream.d.ts": jetStreamDeclaration
      }
    )
    const natsCase = publishedBusinessCases().get("@likego/nats")
    if (natsCase === null || natsCase.typeConsumers === undefined) {
      throw new Error("published NATS type consumers are missing")
    }
    const coreConsumer = natsCase.typeConsumers["."]
    const jetStreamConsumer = natsCase.typeConsumers["./jetstream"]
    if (coreConsumer === undefined || jetStreamConsumer === undefined) {
      throw new Error("published NATS export type consumers are missing")
    }
    const subjects = [
      {
        path: "index.d.ts",
        declaration: coreDeclaration,
        consumer: coreConsumer,
        mutations: [
          {
            before:
              "export type NatsCoreSubscriptionSource = Subscription | NatsCoreSubscriptionFactory",
            after: "export type NatsCoreSubscriptionSource = unknown"
          },
          {
            before:
              "export type NatsCoreSubscriptionFactory = () => Subscription | PromiseLike<Subscription>",
            after: "export type NatsCoreSubscriptionFactory = () => unknown"
          },
          {
            before: "  source: NatsCoreSubscriptionSource,",
            after: "  source: unknown,"
          }
        ]
      },
      {
        path: "jetstream.d.ts",
        declaration: jetStreamDeclaration,
        consumer: jetStreamConsumer,
        mutations: [
          {
            before:
              "export type NatsJetStreamMessagesSource = ConsumerMessages | NatsJetStreamMessagesFactory",
            after: "export type NatsJetStreamMessagesSource = unknown"
          },
          {
            before:
              "export type NatsJetStreamMessagesFactory = () => ConsumerMessages | PromiseLike<ConsumerMessages>",
            after: "export type NatsJetStreamMessagesFactory = () => unknown"
          },
          {
            before: "  source: NatsJetStreamMessagesSource,",
            after: "  source: unknown,"
          }
        ]
      }
    ]
    for (const subject of subjects) {
      await Bun.write(join(root, "node_modules/@likego/nats", subject.path), subject.declaration)
      const baseline = await runTypeScriptBoundary(root, subject.consumer)
      expect(baseline.exitCode, baseline.output).toBe(0)
      for (const mutation of subject.mutations) {
        const mutated = subject.declaration.replace(mutation.before, mutation.after)
        expect(mutated).not.toBe(subject.declaration)
        await Bun.write(join(root, "node_modules/@likego/nats", subject.path), mutated)
        const result = await runTypeScriptBoundary(root, subject.consumer)
        expect(result.exitCode, `${mutation.after}\n${result.output}`).not.toBe(0)
        expect(result.output).toContain("TS2578")
      }
    }
  })

  test("accepts exact version-bound NATS diagnostics from a neutral declared policy", () => {
    const policy = {
      export: ".",
      directDependency: "@nats-io/transport-node"
    }
    expect(() =>
      validateNatsExactOptionalException(policy, "7.0.2", "3.4.0", "3.4.0", 1, natsDiagnostics)
    ).not.toThrow()
    expect(() =>
      validateNatsExactOptionalException(
        { export: "./jetstream", directDependency: "@nats-io/jetstream" },
        "7.0.2",
        "3.4.0",
        "3.4.0",
        1,
        natsDiagnostics
      )
    ).not.toThrow()
  })

  test("fails closed on package, compiler, SDK, exit, missing, or added diagnostic drift", () => {
    expect(() =>
      validateNatsExactOptionalException(
        { export: ".", directDependency: "@nats-io/unknown" },
        "7.0.2",
        "3.4.0",
        "3.4.0",
        1,
        natsDiagnostics
      )
    ).toThrow("unknown NATS direct dependency policy")
    expect(() =>
      validateNatsExactOptionalException(
        { export: ".", directDependency: "@nats-io/transport-node" },
        "7.0.3",
        "3.4.0",
        "3.4.0",
        1,
        natsDiagnostics
      )
    ).toThrow("compiler drift")
    expect(() =>
      validateNatsExactOptionalException(
        { export: ".", directDependency: "@nats-io/transport-node" },
        "7.0.2",
        "3.4.1",
        "3.4.0",
        1,
        natsDiagnostics
      )
    ).toThrow("SDK drift")
    expect(() =>
      validateNatsExactOptionalException(
        { export: ".", directDependency: "@nats-io/transport-node" },
        "7.0.2",
        "3.4.0",
        "3.4.0",
        0,
        natsDiagnostics
      )
    ).toThrow("disappeared or changed exit status")
    expect(() =>
      validateNatsExactOptionalException(
        { export: ".", directDependency: "@nats-io/transport-node" },
        "7.0.2",
        "3.4.0",
        "3.4.0",
        1,
        natsDiagnostics.split("\n").slice(4).join("\n")
      )
    ).toThrow("diagnostics drifted")
    expect(() =>
      validateNatsExactOptionalException(
        { export: ".", directDependency: "@nats-io/transport-node" },
        "7.0.2",
        "3.4.0",
        "3.4.0",
        1,
        `${natsDiagnostics}\nextra diagnostic`
      )
    ).toThrow("diagnostics drifted")
  })

  test("accepts only dependencies and optionalDependencies as direct production evidence", () => {
    expect(
      requirePublishedProductionDependency(
        {
          dependencies: { "@nats-io/transport-node": "3.4.0" }
        },
        "@nats-io/transport-node",
        "@fixture/nats-compat"
      )
    ).toBe("3.4.0")
    expect(
      requirePublishedProductionDependency(
        {
          optionalDependencies: { "@nats-io/jetstream": "3.4.0" }
        },
        "@nats-io/jetstream",
        "@fixture/nats-compat"
      )
    ).toBe("3.4.0")
    expect(() =>
      requirePublishedProductionDependency(
        {
          devDependencies: { "@nats-io/transport-node": "3.4.0" }
        },
        "@nats-io/transport-node",
        "@fixture/nats-compat"
      )
    ).toThrow("missing exact @nats-io/transport-node dependency evidence")
    expect(() =>
      requirePublishedProductionDependency({}, "@nats-io/transport-node", "@fixture/nats-compat")
    ).toThrow("missing exact @nats-io/transport-node dependency evidence")
  })
})

describe("workspace Bun coverage inventory", () => {
  test("requires complete function and line coverage without package exceptions", async () => {
    const root = await rootFixture()
    await mkdir(join(root, "src"), { recursive: true })
    await writeJson(join(root, "package.json"), {
      name: "@likego/registry-mdns",
      version: "0.0.1"
    })
    await Bun.write(join(root, "src/index.ts"), "export function value() { return 1 }\n")
    const complete = [
      "SF:src/index.ts",
      "FNF:1",
      "FNH:1",
      "LF:1",
      "LH:1",
      "DA:1,1",
      "end_of_record",
      ""
    ].join("\n")
    await expect(validateBunPackageCoverage(root, complete)).resolves.toBeUndefined()
    await expect(
      validateBunPackageCoverage(root, complete.replace("LH:1\nDA:1,1", "LH:0\nDA:1,0"))
    ).rejects.toThrow("unreviewed Bun line-attribution gap")
    await expect(
      validateBunPackageCoverage(root, complete.replace("FNH:1", "FNH:0"))
    ).rejects.toThrow("function coverage is below 100%")
  })

  test("accepts exact source inventory and rejects one missing production file", async () => {
    const root = await rootFixture()
    await mkdir(join(root, "src"), { recursive: true })
    await Bun.write(join(root, "src/index.ts"), "export const value = 1\n")
    await Bun.write(join(root, "src/missing.ts"), "export const missing = 1\n")
    const lcov = ["SF:src/index.ts", "FNF:1", "FNH:1", "LF:1", "LH:1", "end_of_record", ""].join(
      "\n"
    )
    await expect(validateBunPackageCoverage(root, lcov)).rejects.toThrow("missing src/missing.ts")
  })

  test("allows proven type-only source but turns one runtime declaration into an LCOV subject", async () => {
    const root = await rootFixture()
    await mkdir(join(root, "src"), { recursive: true })
    await Bun.write(join(root, "src/index.ts"), "export function value() { return 1 }\n")
    await Bun.write(
      join(root, "src/types.ts"),
      "export interface Value { readonly value: number }\n"
    )
    const lcov = ["SF:src/index.ts", "FNF:1", "FNH:1", "LF:1", "LH:1", "end_of_record", ""].join(
      "\n"
    )
    await expect(validateBunPackageCoverage(root, lcov)).resolves.toBeUndefined()
    await Bun.write(
      join(root, "src/types.ts"),
      [
        "export interface Value { readonly value: number }",
        "export const defaultValue = 1",
        ""
      ].join("\n")
    )
    await expect(validateBunPackageCoverage(root, lcov)).rejects.toThrow("missing src/types.ts")
  })

  test("classifies static barrels explicitly and rejects invalid syntax", () => {
    expect(classifySourceCoverage("src/index.ts", 'export { value } from "./value"\n')).toBe(
      "barrel"
    )
    expect(classifySourceCoverage("src/types.ts", "export type Value = string\n")).toBe("type-only")
    expect(classifySourceCoverage("src/value.ts", "export const value = 1\n")).toBe("executable")
    expect(() => classifySourceCoverage("src/broken.ts", "export const =\n")).toThrow(
      "cannot parse"
    )
  })
})

describe("published tooling source policy", () => {
  test("records external and uniquely labelled Docker ownership before one command", () => {
    const root = "/tmp/likego-published-stage"
    const cidFile = "/tmp/likego-published-docker-owner/node-lts-version.cid"
    const ownerToken = "8d3e724c-fb53-41f1-8a5a-f01bb4f37b03"
    expect(publishedDockerArgs(root, cidFile, ownerToken, ["node", "--version"])).toEqual([
      "docker",
      "run",
      "--rm",
      "--label",
      "com.likego.published=true",
      "--label",
      `com.likego.published.owner=${ownerToken}`,
      "--name",
      `likego-published-${ownerToken}`,
      "--cidfile",
      cidFile,
      "--mount",
      `type=bind,src=${root},dst=/consumer`,
      "--workdir",
      "/consumer",
      nodeLtsImage,
      "node",
      "--version"
    ])
  })

  test("preserves primary Docker command failures across every cleanup outcome", () => {
    const success = Object.freeze({ exitCode: 0, stdout: "ok", stderr: "" })
    const nonzero = Object.freeze({ exitCode: 17, stdout: "before", stderr: "failed" })
    const primary = new Error("primary timeout")
    const cleanup = new Error("cleanup failed")

    expect(publishedDockerOutcome("normal", success, null, null, true)).toBe(success)
    expect(publishedDockerOutcome("nonzero", nonzero, null, null, true)).toBe(nonzero)
    expect(() => publishedDockerOutcome("throw", null, primary, null, false)).toThrow(primary)
    expect(() => publishedDockerOutcome("cleanup", success, null, cleanup, true)).toThrow(cleanup)
    expect(() => publishedDockerOutcome("missing-cid", success, null, null, false)).toThrow(
      "produced no container ID"
    )

    for (const value of [
      Object.freeze({ purpose: "throw-cleanup", result: null, primary }),
      Object.freeze({ purpose: "nonzero-cleanup", result: nonzero, primary: null })
    ]) {
      let failure: unknown = null
      try {
        publishedDockerOutcome(value.purpose, value.result, value.primary, cleanup, true)
      } catch (error) {
        failure = error
      }
      if (!(failure instanceof AggregateError)) {
        throw new Error(`${value.purpose} did not preserve both failures`)
      }
      expect(failure.errors).toHaveLength(2)
      if (value.primary === null) {
        expect(String(failure.errors[0])).toContain("exit 17")
        expect(String(failure.errors[0])).toContain("beforefailed")
      } else {
        expect(failure.errors[0]).toBe(primary)
      }
      expect(failure.errors[1]).toBe(cleanup)
    }
  })

  test("bounds one published command instead of waiting forever", async () => {
    const root = await rootFixture()
    const failure = await runCommand(
      ["node", "-e", 'process.stdout.write("before-timeout\\n"); setTimeout(() => {}, 400)'],
      { cwd: root, timeoutMs: 100 }
    ).then(
      function unexpectedSuccess(): null {
        return null
      },
      function rejected(error): unknown {
        return error
      }
    )

    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).toContain("exceeded 100ms")
    expect(String(failure)).toContain("before-timeout")
  })

  test("terminates descendants when one published command exceeds its budget", async () => {
    const root = await rootFixture()
    const marker = join(root, "descendant-survived")
    const descendant = [
      'const { writeFileSync } = require("node:fs")',
      `setTimeout(() => writeFileSync(${JSON.stringify(marker)}, "survived"), 300)`
    ].join(";")
    const parent = [
      'const { spawn } = require("node:child_process")',
      `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore" })`,
      "child.unref()",
      "setInterval(() => {}, 1_000)"
    ].join(";")

    await expect(runCommand(["node", "-e", parent], { cwd: root, timeoutMs: 100 })).rejects.toThrow(
      "exceeded 100ms"
    )
    await Bun.sleep(400)
    expect(await Bun.file(marker).exists()).toBeFalse()
  })

  test("keeps the command budget active until inherited output pipes close", async () => {
    const root = await rootFixture()
    const marker = join(root, "pipe-descendant-survived")
    const descendant = [
      'const { writeFileSync } = require("node:fs")',
      `setTimeout(() => writeFileSync(${JSON.stringify(marker)}, "survived"), 400)`
    ].join(";")
    const parent = [
      'const { spawn } = require("node:child_process")',
      `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: ["ignore", "inherit", "inherit"] })`,
      "child.unref()"
    ].join(";")
    const startedAt = Date.now()
    const failure = await runCommand(["node", "-e", parent], {
      cwd: root,
      timeoutMs: 100
    }).then(
      function unexpectedSuccess(): null {
        return null
      },
      function rejected(error): unknown {
        return error
      }
    )
    const elapsedMs = Date.now() - startedAt
    await Bun.sleep(400)

    expect(failure).toBeInstanceOf(Error)
    expect(elapsedMs).toBeLessThan(300)
    expect(await Bun.file(marker).exists()).toBeFalse()
  })

  test("contains no explicit any, assertions, non-null assertions, or spread syntax", async () => {
    const issues: string[] = []
    const glob = new Bun.Glob("{scripts/published,test/published}/**/*.ts")
    for await (const path of glob.scan({ cwd: join(import.meta.dir, "../.."), onlyFiles: true })) {
      const file = parse(await Bun.file(join(import.meta.dir, "../..", path)).text(), {
        sourceType: "module",
        sourceFilename: path,
        errorRecovery: false,
        plugins: ["typescript"]
      })
      traverseFast(file, (node) => {
        if (
          node.type === "TSAnyKeyword" ||
          node.type === "TSAsExpression" ||
          node.type === "TSTypeAssertion" ||
          node.type === "TSNonNullExpression" ||
          node.type === "SpreadElement" ||
          node.type === "RestElement"
        ) {
          issues.push(`${path}:${node.type}`)
        }
      })
    }
    expect(issues).toEqual([])
  })

  test("keeps shared published tooling free of legacy LikeGo NATS package identities", async () => {
    const sharedSources = await Promise.all(
      [
        "scripts/published/business-cases.ts",
        "scripts/published/contracts.ts",
        "scripts/published/runner.ts"
      ].map((path) => Bun.file(join(import.meta.dir, "../..", path)).text())
    )
    const source = sharedSources.join("\n")

    expect(source).not.toContain("@likego/nats-core-node")
    expect(source).not.toContain("@likego/nats-jetstream-node")
  })
})
