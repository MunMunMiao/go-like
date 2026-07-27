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
    name: "@likego/store-etcd",
    version: "0.0.1",
    type: "module",
    module: "src/index.ts",
    typings: "src/index.ts",
    sideEffects: false,
    files: ["dist"],
    exports: { ".": "./src/index.ts" },
    scripts: {
      build: "bun x --bun tsdown --config-loader native",
      "test:docker": "bun test/integration/etcd-docker.ts",
      "test:runtime": "bun test/integration/runtime-matrix.ts"
    },
    dependencies: {
      "@likego/context": "0.0.1",
      "@likego/core": "0.0.1",
      "@likego/store": "0.0.1"
    }
  })
  expect(await json("capability.json")).toMatchObject({
    schemaVersion: 2,
    package: "@likego/store-etcd",
    packageKind: "portable",
    stability: "provisional",
    releaseBlocking: true,
    exports: {
      ".": {
        kind: "portable",
        residency: "non-resident",
        ownerResources: [],
        capabilities: ["store", "store-etcd", "etcd-json-gateway"],
        runtimes: [
          { runtime: "bun" },
          { runtime: "node" },
          { runtime: "node" },
          { runtime: "deno" }
        ]
      }
    }
  })
  expect(await json("owner.json")).toEqual({
    schemaVersion: 1,
    package: "@likego/store-etcd",
    resources: []
  })
})

test("README fixes borrowed Fetch, record-owned TTL, and Docker evidence", async () => {
  const readme = await readFile(join(Root, "README.md"), "utf8")
  expect(markdownRow(readme, "`etcd-fetch`")).toEqual([
    "`etcd-fetch`",
    "应用",
    "仅借用；本包不调用 `close`、`destroy` 或同类能力"
  ])
  expect(markdownRow(readme, "TTL KV/Lease")).toEqual([
    "TTL KV/Lease",
    "对应 record",
    "到期由 etcd 清理；显式 delete 或覆盖提前撤销 exact lease"
  ])
  expect(readme).toContain("不依赖 Node API、gRPC client 或 Protobuf runtime")
  expect(readme).toContain(
    "sha256:a9983dd6d9283138ab926daa307c6c25623636703ecf5645d5df4d666ce9eba2"
  )
  expect(readme).toContain(
    "https://github.com/MunMunMiao/likego/blob/main/packages/store/etcd/test/integration/etcd-3.7.1-report.md"
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
    "src/protocol.ts",
    "src/store.ts",
    "src/types.ts"
  ])
})
