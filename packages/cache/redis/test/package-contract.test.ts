import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

import { expect, test } from "bun:test"

test("Redis Cache package manifest and ownership are exact", async () => {
  const root = join(import.meta.dir, "..")
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"))
  const capability = JSON.parse(await readFile(join(root, "capability.json"), "utf8"))
  const owner = JSON.parse(await readFile(join(root, "owner.json"), "utf8"))
  expect(manifest).toMatchObject({
    name: "@likego/cache-redis",
    version: "0.0.1",
    module: "src/index.ts",
    typings: "src/index.ts",
    exports: { ".": "./src/index.ts" },
    dependencies: { "@redis/client": "6.1.0" }
  })
  expect(capability).toMatchObject({
    package: "@likego/cache-redis",
    packageKind: "integration",
    exports: {
      ".": {
        residency: "resident",
        ownerResources: ["redis-client"],
        capabilities: ["cache", "cache-redis"]
      }
    }
  })
  expect(owner).toEqual({
    schemaVersion: 1,
    package: "@likego/cache-redis",
    resources: [
      {
        id: "redis-client",
        owner: "likego-owned",
        exposure: "managed-private",
        stopContract: "likego-owned"
      }
    ]
  })
})

test("Redis Cache package shell source and test inventories are exact", async () => {
  const root = join(import.meta.dir, "..")
  const shell = (await readdir(root))
    .filter((entry) => !entry.startsWith(".") && entry !== "dist" && entry !== "node_modules")
    .sort()
  expect(shell).toEqual([
    "LICENSE",
    "README.md",
    "bunfig.toml",
    "capability.json",
    "owner.json",
    "package.json",
    "src",
    "test",
    "tsconfig.json",
    "tsconfig.test.json"
  ])
  expect((await readdir(join(root, "src"))).sort()).toEqual([
    "cache.ts",
    "codec.ts",
    "connection.ts",
    "errors.ts",
    "index.ts",
    "options.ts",
    "types.ts"
  ])
  expect((await readdir(join(root, "test"))).sort()).toEqual([
    "cache.test.ts",
    "codec.test.ts",
    "connection.test.ts",
    "coverage-contract.ts",
    "helpers.ts",
    "integration",
    "options-errors.test.ts",
    "package-contract.test.ts",
    "public-api.test.ts",
    "public-types.ts",
    "source-policy.test.ts"
  ])
  const readme = await readFile(join(root, "README.md"), "utf8")
  expect(readme).toContain(
    "redis:8.8.1-alpine@sha256:8096655e437712b07503796fb64d81359256cfcff0ab29d95a7da72863786efb"
  )
  expect(readme).toContain(
    "https://github.com/MunMunMiao/likego/blob/main/packages/cache/redis/test/integration/redis-8.8.1-report.md"
  )
  const integration = await readFile(join(root, "test/integration/redis-docker.ts"), "utf8")
  expect(integration).toContain('const RedisVersion = "8.8.1"')
  expect(integration).toContain("redisVersion !== RedisVersion")
})
