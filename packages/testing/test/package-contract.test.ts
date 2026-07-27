import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { expect, test } from "bun:test"

const Root = join(import.meta.dir, "..")

async function json(name: string): Promise<unknown> {
  return JSON.parse(await readFile(join(Root, name), "utf8"))
}

test("keeps testing helpers private to the repository", async () => {
  expect(await json("package.json")).toMatchObject({
    name: "@likego/testing",
    private: true,
    type: "module",
    module: "src/index.ts",
    typings: "src/index.ts",
    sideEffects: false,
    exports: {
      ".": "./src/index.ts",
      "./server": "./src/server.ts",
      "./listener": "./src/listener.ts"
    },
    dependencies: {
      "@likego/context": expect.any(String),
      "@likego/core": expect.any(String)
    }
  })
})

test("production source inventory is explicit", async () => {
  const sources: string[] = []
  for await (const file of new Bun.Glob("src/**/*.ts").scan({ cwd: Root, onlyFiles: true })) {
    sources.push(file)
  }
  expect(sources.sort()).toEqual(["src/index.ts", "src/listener.ts", "src/server.ts"])
})
