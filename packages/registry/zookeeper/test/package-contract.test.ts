import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { expect, test } from "bun:test"

const root = join(import.meta.dir, "..")

/** Reads one package JSON artifact without executing it. */
async function json(name: string): Promise<unknown> {
  return JSON.parse(await readFile(join(root, name), "utf8"))
}

test("package and manifests publish the Node/Bun resident ZooKeeper contract", async () => {
  expect(await json("package.json")).toMatchObject({
    name: "@likego/registry-zookeeper",
    version: "0.0.1",
    type: "module",
    module: "src/index.ts",
    typings: "src/index.ts",
    sideEffects: false,
    files: ["dist"],
    exports: { ".": "./src/index.ts" },
    scripts: {
      build: "bun x --bun tsdown --config-loader native",
      "test:docker": "bun test/integration/zookeeper-docker.ts",
      "test:runtime": "bun run build && bun test/integration/published-runtime.ts"
    },
    dependencies: {
      "@likego/context": "0.0.1",
      "@likego/core": "0.0.1",
      "@likego/registry": "0.0.1",
      "node-zookeeper-client": "1.1.3"
    },
    devDependencies: {
      "@types/node-zookeeper-client": "1.1.0"
    }
  })
  expect(await json("capability.json")).toMatchObject({
    schemaVersion: 2,
    package: "@likego/registry-zookeeper",
    packageKind: "integration",
    stability: "provisional",
    releaseBlocking: true,
    exports: {
      ".": {
        kind: "integration",
        residency: "resident",
        ownerResources: ["zookeeper-registration-session", "zookeeper-watcher-session"],
        capabilities: ["registry", "registry-zookeeper", "service-discovery"]
      }
    }
  })
  expect(await json("owner.json")).toEqual({
    schemaVersion: 1,
    package: "@likego/registry-zookeeper",
    resources: [
      {
        id: "zookeeper-registration-session",
        owner: "likego-owned",
        exposure: "managed-private",
        stopContract: "likego-owned"
      },
      {
        id: "zookeeper-watcher-session",
        owner: "likego-owned",
        exposure: "managed-private",
        stopContract: "likego-owned"
      }
    ]
  })
  const readme = await readFile(join(root, "README.md"), "utf8")
  expect(readme).toContain("newZookeeperRegistry")
  expect(readme).toContain("session expiration")
  expect(readme).toContain("one-shot")
  expect(readme).toContain("`zookeeper-process`")
  expect(readme).toContain("replacement snapshot")
  expect(readme).not.toContain("newZookeeperDiscovery")
  expect(readme).not.toContain("newZookeeperRegistrar")
  expect(readme).not.toContain("hardDrainTimeoutMs")
  expect(readme).not.toContain("ZookeeperDrainTimeoutError")
  expect(readme).not.toContain("RegistrationHandle")
  expect(readme).not.toContain("capabilities()")
})

test("package source inventory is explicit", async () => {
  const sources: string[] = []
  for await (const file of new Bun.Glob("src/**/*.ts").scan({ cwd: root, onlyFiles: true })) {
    sources.push(file)
  }
  expect(sources.sort()).toEqual([
    "src/changes.ts",
    "src/codec.ts",
    "src/discovery.ts",
    "src/errors.ts",
    "src/index.ts",
    "src/native.ts",
    "src/options.ts",
    "src/records.ts",
    "src/registration.ts",
    "src/runtime.ts",
    "src/tree.ts",
    "src/types.ts"
  ])
})
