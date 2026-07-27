import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { expect, test } from "bun:test"

const root = join(import.meta.dir, "..")

/** Reads one package artifact as JSON. */
async function json(name: string): Promise<unknown> {
  return JSON.parse(await readFile(join(root, name), "utf8"))
}

test("package and manifests publish one Fetch-only watcher owner", async () => {
  expect(await json("package.json")).toMatchObject({
    name: "@likego/registry-kubernetes",
    type: "module",
    module: "src/index.ts",
    typings: "src/index.ts",
    sideEffects: false,
    files: ["dist"],
    exports: { ".": "./src/index.ts" },
    scripts: {
      build: "bun x --bun tsdown --config-loader native",
      "test:docker": "bun test/integration/k3s-docker.ts"
    },
    dependencies: {
      "@likego/context": expect.any(String),
      "@likego/core": expect.any(String),
      "@likego/registry": expect.any(String)
    }
  })
  expect(await json("capability.json")).toMatchObject({
    schemaVersion: 2,
    package: "@likego/registry-kubernetes",
    exports: {
      ".": {
        residency: "resident",
        ownerResources: ["kubernetes-watcher"],
        capabilities: ["registry", "registry-kubernetes", "service-discovery"]
      }
    }
  })
  expect(await json("owner.json")).toEqual({
    schemaVersion: 1,
    package: "@likego/registry-kubernetes",
    resources: [
      {
        id: "kubernetes-watcher",
        owner: "likego-owned",
        exposure: "managed-private",
        stopContract: "likego-owned"
      }
    ]
  })
})

test("README and source inventory contain no legacy owner-handle or drain-timeout API", async () => {
  const readme = await readFile(join(root, "README.md"), "utf8")
  expect(readme).toContain("newKubernetesRegistry")
  expect(readme).toContain("ServiceInstance")
  expect(readme).toContain("AbortSignal")
  for (const legacy of [
    "RegistrationHandle",
    "hardDrainTimeoutMs",
    "KubernetesDrainTimeoutError",
    "handle.done",
    "handle.stop",
    "capabilities()"
  ]) {
    expect(readme).not.toContain(legacy)
  }

  const sources: string[] = []
  for await (const file of new Bun.Glob("src/**/*.ts").scan({ cwd: root, onlyFiles: true })) {
    sources.push(file)
  }
  expect(sources.sort()).toEqual([
    "src/codec.ts",
    "src/discovery.ts",
    "src/errors.ts",
    "src/http.ts",
    "src/index.ts",
    "src/options.ts",
    "src/protocol.ts",
    "src/records.ts",
    "src/registration.ts",
    "src/runtime.ts",
    "src/types.ts"
  ])
})
