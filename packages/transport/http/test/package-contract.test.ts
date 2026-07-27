import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { expect, test } from "bun:test"

const Root = join(import.meta.dir, "..")

/** Reads one package-owned JSON contract without executing package code. */
async function json(name: string): Promise<unknown> {
  return JSON.parse(await readFile(join(Root, name), "utf8"))
}

test("publishes the hybrid HTTP transport package contract", async () => {
  expect(await json("package.json")).toMatchObject({
    name: "@likego/transport-http",
    version: expect.any(String),
    type: "module",
    module: "src/index.ts",
    typings: "src/index.ts",
    sideEffects: false,
    files: ["dist"],
    exports: {
      ".": "./src/index.ts",
      "./node": "./src/node.ts"
    },
    dependencies: {
      "@likego/context": expect.any(String),
      "@likego/metadata": expect.any(String),
      "@likego/transport": expect.any(String),
      "@types/node": "26.1.1"
    }
  })
  expect(await json("capability.json")).toMatchObject({
    schemaVersion: 2,
    package: "@likego/transport-http",
    packageKind: "hybrid",
    stability: "provisional",
    releaseBlocking: true,
    exports: {
      ".": {
        kind: "portable",
        residency: "non-resident",
        ownerResources: [],
        capabilities: ["http", "transport"]
      },
      "./node": {
        kind: "integration",
        residency: "resident",
        ownerResources: ["http-listener"],
        capabilities: ["http", "transport"]
      }
    }
  })
})

test("Task 6 production source inventory is explicit", async () => {
  const sources: string[] = []
  for await (const file of new Bun.Glob("src/**/*.ts").scan({ cwd: Root, onlyFiles: true })) {
    sources.push(file)
  }
  expect(sources.sort()).toEqual([
    "src/address.ts",
    "src/client.ts",
    "src/errors.ts",
    "src/headers.ts",
    "src/index.ts",
    "src/listener.ts",
    "src/node-client.ts",
    "src/node-host.ts",
    "src/node.ts",
    "src/options.ts",
    "src/socket.ts",
    "src/transport-info.ts",
    "src/transport.ts",
    "src/types.ts"
  ])
})
