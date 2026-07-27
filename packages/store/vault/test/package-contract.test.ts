import { expect, test } from "bun:test"

const Root = `${import.meta.dir}/..`

async function json(name: string): Promise<unknown> {
  return JSON.parse(await Bun.file(`${Root}/${name}`).text())
}

test("package and manifests publish the portable non-resident Vault Store contract", async () => {
  expect(await json("package.json")).toMatchObject({
    name: "@likego/store-vault",
    version: "0.0.1",
    type: "module",
    module: "src/index.ts",
    typings: "src/index.ts",
    sideEffects: false,
    files: ["dist"],
    exports: { ".": "./src/index.ts" },
    scripts: {
      build: "bun x --bun tsdown --config-loader native",
      "test:docker": "bun test/integration/vault-docker.ts"
    },
    dependencies: {
      "@likego/context": "0.0.1",
      "@likego/core": "0.0.1",
      "@likego/store": "0.0.1"
    }
  })
  expect(await json("capability.json")).toMatchObject({
    schemaVersion: 2,
    package: "@likego/store-vault",
    packageKind: "portable",
    stability: "provisional",
    releaseBlocking: true,
    exports: {
      ".": {
        kind: "portable",
        residency: "non-resident",
        ownerResources: [],
        capabilities: ["store", "store-vault"],
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
    package: "@likego/store-vault",
    resources: []
  })
})

test("README states physical isolation, exact delete, cursor, and verified Docker boundaries", async () => {
  const readme = await Bun.file(`${Root}/README.md`).text()
  expect(readme).toContain("UTF-8 编码，再转换为无 padding 的 base64url 单层物理 key")
  expect(readme).toContain("只 soft-delete 调用开始时真实读取到的 exact version")
  expect(readme).toContain("后续 cursor 不再访问 Vault")
  expect(readme).toContain("test/integration/vault-2.0.3-report.md")
  expect(readme).toContain(
    "sha256:a296a888b118615dc01d5f1a6846e6d4a7277946caaed5b447008fff5fe06b54"
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
