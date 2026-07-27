import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { expect, test } from "bun:test"

const PackageRoot = join(import.meta.dir, "../..")

/** Reads one package JSON artifact without executing it. */
async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(join(PackageRoot, path), "utf8"))
}

test("package shell publishes the Node host through final Web subpaths", async () => {
  expect(await json("package.json")).toMatchObject({
    name: "@likego/web",
    version: expect.any(String),
    type: "module",
    module: "src/index.ts",
    typings: "src/index.ts",
    sideEffects: false,
    files: ["dist"],
    exports: {
      "./node": "./src/node.ts"
    },
    scripts: {
      "smoke:bun": "bun test/runtime/portable-runtime.ts",
      "smoke:node": "tsx test/runtime/portable-runtime.ts && tsx test/node/smoke/dist-smoke.ts",
      "smoke:deno":
        "deno run --sloppy-imports --config ../../deno.json test/runtime/portable-runtime.ts",
      "e2e:node": "tsx test/e2e/native-e2e.ts"
    },
    dependencies: {
      "@hono/node-server": "2.0.11",
      "@likego/context": expect.any(String),
      "@likego/core": expect.any(String),
      "@likego/health": expect.any(String),
      "@types/node": "26.1.1"
    },
    devDependencies: { "@likego/testing": expect.any(String) }
  })
})

test("manifests bind the Node subpaths to the final hybrid package identity", async () => {
  expect(await json("capability.json")).toMatchObject({
    schemaVersion: 2,
    package: "@likego/web",
    packageKind: "hybrid",
    stability: "provisional",
    releaseBlocking: true,
    exports: {
      "./node": {
        kind: "integration",
        residency: "resident",
        ownerResources: ["node-server"],
        capabilities: ["server", "web"]
      }
    }
  })
  expect(await json("owner.json")).toEqual({
    schemaVersion: 1,
    package: "@likego/web",
    resources: [
      {
        id: "node-server",
        owner: "likego-owned",
        exposure: "managed-private",
        stopContract: "likego-owned"
      }
    ]
  })
})

test("Node source and runtime shell inventory is explicit", async () => {
  const sourceFiles: string[] = []
  for await (const file of new Bun.Glob("node*.ts").scan({
    cwd: join(PackageRoot, "src"),
    onlyFiles: true
  })) {
    sourceFiles.push(`src/${file}`)
  }
  sourceFiles.sort()
  expect(sourceFiles).toEqual(["src/node-errors.ts", "src/node-server.ts", "src/node.ts"])

  const runtimeScripts: string[] = []
  for (const root of ["test/e2e", "test/node/smoke", "test/runtime"]) {
    for await (const file of new Bun.Glob("**/*").scan({
      cwd: join(PackageRoot, root),
      onlyFiles: true
    })) {
      runtimeScripts.push(`${root}/${file}`)
    }
  }
  runtimeScripts.sort()
  expect(runtimeScripts).toEqual([
    "test/e2e/native-e2e.ts",
    "test/node/smoke/dist-smoke.ts",
    "test/runtime/portable-runtime.ts"
  ])

  const smoke = await readFile(join(PackageRoot, "test/node/smoke/dist-smoke.ts"), "utf8")
  const e2e = await readFile(join(PackageRoot, "test/e2e/native-e2e.ts"), "utf8")
  expect(smoke).toContain('import("@likego/web/node")')
  expect(e2e).toContain('import("@likego/web/node")')
  expect(smoke).toContain('["context", "core", "web"]')
  expect(e2e).toContain('["context", "core", "web"]')
  expect(smoke).not.toContain('["context", "core", "fetch"]')
  expect(e2e).not.toContain('["context", "core", "fetch"]')
  expect(smoke).not.toContain("@likego/fetch")
  expect(e2e).not.toContain("@likego/fetch")
  expect(smoke).not.toContain('"packages", "fetch"')
  expect(e2e).not.toContain('"packages", "fetch"')
  expect(smoke).not.toContain("../../dist/index.js")
  expect(e2e).not.toContain("../../dist/index.js")
})
