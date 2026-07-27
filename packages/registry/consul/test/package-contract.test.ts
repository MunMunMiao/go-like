import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { expect, test } from "bun:test"

const Root = join(import.meta.dir, "..")

/** Reads one package JSON artifact without executing it. */
async function json(name: string): Promise<unknown> {
  return JSON.parse(await readFile(join(Root, name), "utf8"))
}

/** Reads one exact Markdown table row without treating formatter padding as contract data. */
function markdownRow(source: string, key: string): readonly string[] {
  const line = source.split("\n").find((candidate) => candidate.includes(key))
  if (line === undefined || !line.startsWith("|") || !line.endsWith("|")) {
    throw new TypeError(`README table row is missing: ${key}`)
  }
  return Object.freeze(
    line
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim())
  )
}

test("package and manifests publish the resident Fetch-only Consul contract", async () => {
  expect(await json("package.json")).toMatchObject({
    name: "@likego/registry-consul",
    type: "module",
    module: "src/index.ts",
    typings: "src/index.ts",
    sideEffects: false,
    files: ["dist"],
    exports: { ".": "./src/index.ts" },
    scripts: {
      build: "bun x --bun tsdown --config-loader native",
      "test:docker": "bun test/integration/consul-docker.ts",
      "test:runtime": "bun run build && bun test/integration/published-runtime.ts"
    },
    dependencies: {
      "@likego/context": expect.any(String),
      "@likego/core": expect.any(String),
      "@likego/registry": expect.any(String)
    }
  })
  expect(await json("capability.json")).toMatchObject({
    schemaVersion: 2,
    package: "@likego/registry-consul",
    packageKind: "portable",
    exports: {
      ".": {
        kind: "portable",
        residency: "resident",
        ownerResources: ["consul-registration", "consul-watcher"],
        capabilities: ["registry", "registry-consul", "service-discovery"]
      }
    }
  })
  expect(await json("owner.json")).toEqual({
    schemaVersion: 1,
    package: "@likego/registry-consul",
    resources: [
      {
        id: "consul-registration",
        owner: "likego-owned",
        exposure: "managed-private",
        stopContract: "likego-owned"
      },
      {
        id: "consul-watcher",
        owner: "likego-owned",
        exposure: "managed-private",
        stopContract: "likego-owned"
      }
    ]
  })
  const readme = await readFile(join(Root, "README.md"), "utf8")
  expect(markdownRow(readme, "`consul-fetch`")).toEqual([
    "`consul-fetch`",
    "应用",
    "仅借用；本包不调用 `close`、`destroy` 或同类能力。"
  ])
  expect(markdownRow(readme, "`consul-process`")).toEqual([
    "`consul-process`",
    "应用/运维",
    "仅通过 HTTP 使用；本包不启动、停止或配置 Consul 进程。"
  ])
  expect(readme).toContain("newConsulRegistry")
  expect(readme).toContain("@likego/registry")
  expect(readme).not.toContain("newConsulDiscovery")
  expect(readme).not.toContain("newConsulRegistrar")
})

test("package source inventory is explicit", async () => {
  const sources: string[] = []
  for await (const file of new Bun.Glob("src/**/*.ts").scan({ cwd: Root, onlyFiles: true }))
    sources.push(file)
  expect(sources.sort()).toEqual([
    "src/codec.ts",
    "src/discovery.ts",
    "src/errors.ts",
    "src/http.ts",
    "src/index.ts",
    "src/options.ts",
    "src/registration.ts",
    "src/runtime.ts",
    "src/types.ts"
  ])
})

test("central published type consumer uses only the unified Consul Registry API", async () => {
  const source = await readFile(join(Root, "../../../test/published/cases/integrations.ts"), "utf8")
  const start = source.indexOf('package: "@likego/registry-consul"')
  const end = source.indexOf("registry.register({", start + 1)
  if (start < 0 || end < 0) throw new Error("central Consul published case is missing")
  const consumer = source.slice(start, end)
  for (const name of [
    "newConsulRegistry",
    "ConsulRegistry",
    "ConsulRegistryOptions",
    "ConsulFetch",
    "ConsulHttpError",
    "ConsulOperation",
    "ConsulTransportError"
  ])
    expect(consumer).toContain(name)
  for (const name of [
    "ConsulDrainTimeoutError",
    "newConsulDiscovery",
    "newConsulRegistrar",
    "ConsulDiscovery",
    "ConsulOptions",
    "ConsulRegistrar",
    "ConsulSchemaError"
  ])
    expect(consumer).not.toContain(name)
})
