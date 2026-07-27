import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { expect, test } from "bun:test"

const PackageRoot = join(import.meta.dir, "..")

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(join(PackageRoot, path), "utf8"))
}

test("publishes a non-resident Node metrics adapter", async () => {
  expect(await json("package.json")).toMatchObject({
    name: "@likego/prometheus",
    description:
      "Application-owned prom-client registries and explicit LikeGo request instrumentation.",
    type: "module",
    module: "src/index.ts",
    typings: "src/index.ts",
    sideEffects: false,
    files: ["dist"],
    exports: { ".": "./src/index.ts" },
    dependencies: {
      "@likego/broker": expect.any(String),
      "@likego/client": expect.any(String),
      "@likego/context": expect.any(String),
      "@likego/server": expect.any(String),
      "@likego/transport": expect.any(String),
      "@likego/web": expect.any(String),
      "prom-client": "15.1.3"
    }
  })
  expect(await json("capability.json")).toMatchObject({
    schemaVersion: 2,
    package: "@likego/prometheus",
    packageKind: "integration",
    releaseBlocking: true,
    exports: {
      ".": {
        kind: "integration",
        residency: "non-resident",
        ownerResources: [],
        capabilities: ["broker", "client", "metrics", "prometheus", "server", "web"]
      }
    }
  })
  expect(await json("owner.json")).toEqual({
    schemaVersion: 1,
    package: "@likego/prometheus",
    resources: []
  })
  const readme = await readFile(join(PackageRoot, "README.md"), "utf8")
  expect(readme).toContain("`createPrometheusHandler()` 非驻留")
  expect(readme).toContain("`newRequestMetrics(registry)`")
  expect(readme).toContain("Broker topic 会直接成为 label")
  expect(readme).not.toContain("createPrometheusFetch")
})

test("production source inventory is explicit", async () => {
  const sources: string[] = []
  for await (const file of new Bun.Glob("src/**/*.ts").scan({
    cwd: PackageRoot,
    onlyFiles: true
  })) {
    sources.push(file)
  }
  expect(sources.sort()).toEqual(["src/index.ts"])
})
