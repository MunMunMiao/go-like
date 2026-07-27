import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { expect, test } from "bun:test"

const Root = join(import.meta.dir, "..")

/** Reads one package JSON artifact without executing it. */
async function json(name: string): Promise<unknown> {
  return JSON.parse(await readFile(join(Root, name), "utf8"))
}

/** Reads one exact Markdown ownership row without formatter padding. */
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

test("package and manifests publish the portable non-resident Fetch-only Store contract", async () => {
  expect(await json("package.json")).toMatchObject({
    name: "@likego/store-consul",
    version: "0.0.1",
    type: "module",
    module: "src/index.ts",
    typings: "src/index.ts",
    sideEffects: false,
    files: ["dist"],
    exports: { ".": "./src/index.ts" },
    scripts: {
      build: "bun x --bun tsdown --config-loader native",
      "test:docker": "bun test/integration/consul-docker.ts"
    },
    dependencies: {
      "@likego/context": "0.0.1",
      "@likego/core": "0.0.1",
      "@likego/store": "0.0.1"
    }
  })
  expect(await json("capability.json")).toMatchObject({
    schemaVersion: 2,
    package: "@likego/store-consul",
    packageKind: "portable",
    stability: "provisional",
    releaseBlocking: true,
    exports: {
      ".": {
        kind: "portable",
        residency: "non-resident",
        ownerResources: [],
        capabilities: ["store", "store-consul"]
      }
    }
  })
  expect(await json("owner.json")).toEqual({
    schemaVersion: 1,
    package: "@likego/store-consul",
    resources: []
  })
  const capability = (await json("capability.json")) as {
    exports: { ".": { runtimes: Array<{ runtime: string }> } }
  }
  expect(capability.exports["."].runtimes.map((row) => row.runtime)).toEqual([
    "bun",
    "node",
    "node",
    "deno"
  ])
})

test("README fixes borrowed Fetch and record-owned TTL boundaries", async () => {
  const readme = await readFile(join(Root, "README.md"), "utf8")
  expect(markdownRow(readme, "`consul-fetch`")).toEqual([
    "`consul-fetch`",
    "应用",
    "仅借用；本包不调用 `close`、`destroy` 或同类能力"
  ])
  expect(markdownRow(readme, "TTL KV/Session")).toEqual([
    "TTL KV/Session",
    "对应 record",
    "到期由 Consul behavior-delete 清理；显式 delete 提前销毁 exact Session"
  ])
  expect(readme).toContain("Conflicting flags: acquire=<session>&cas=<ModifyIndex>")
  expect(readme).toContain("`root` 默认是 `likego/store`")
  expect(readme).toContain("不同 `root` 完全隔离")
  expect(readme).toContain("root 外的 Consul KV 不会进入结果")
  expect(readme).toContain(
    "sha256:7dcf35d6b2682831094f1680aa58be214134969505acce0a9b280249581aa7d2"
  )
})

test("package source inventory is explicit", async () => {
  const sources: string[] = []
  for await (const file of new Bun.Glob("src/**/*.ts").scan({ cwd: Root, onlyFiles: true })) {
    sources.push(file)
  }
  expect(sources.sort()).toEqual([
    "src/codec.ts",
    "src/errors.ts",
    "src/http.ts",
    "src/index.ts",
    "src/options.ts",
    "src/store.ts",
    "src/types.ts"
  ])
})
