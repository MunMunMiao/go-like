import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { expect, test } from "bun:test"

const Root = join(import.meta.dir, "..")

/** Reads one package JSON artifact without executing it. */
async function json(name: string): Promise<unknown> {
  return JSON.parse(await readFile(join(Root, name), "utf8"))
}

test("portable package source inventory is explicit", async () => {
  const sources: string[] = []
  for await (const file of new Bun.Glob("src/**/*.ts").scan({ cwd: Root, onlyFiles: true })) {
    sources.push(file)
  }
  expect(sources.sort()).toEqual([
    "src/base32.ts",
    "src/cache.ts",
    "src/canonical.ts",
    "src/codec.ts",
    "src/dns.ts",
    "src/errors.ts",
    "src/index.ts",
    "src/node-host.ts",
    "src/node.ts",
    "src/options.ts",
    "src/registration.ts",
    "src/registry.ts",
    "src/testing.ts",
    "src/token-stack.ts",
    "src/types.ts",
    "src/watcher.ts"
  ])
})

test("package exports isolate the portable root from the Node host", async () => {
  expect(await json("package.json")).toMatchObject({
    name: "@likego/registry-mdns",
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
      "@likego/core": expect.any(String),
      "@likego/registry": expect.any(String)
    }
  })
})

test("public constructor declares the provider-specific Registry result", async () => {
  const source = await readFile(join(Root, "src/registry.ts"), "utf8")
  expect(source).toMatch(/import type \{[^}]*\bMDNSRegistry\b[^}]*\} from "\.\/types"/)
  expect(source).toMatch(/export function newMDNSRegistry\([\s\S]*?\): MDNSRegistry \{/)
})

test("runtime declarations use lower camel case", async () => {
  const violations: string[] = []
  for await (const file of new Bun.Glob("src/**/*.ts").scan({ cwd: Root, onlyFiles: true })) {
    const source = await readFile(join(Root, file), "utf8")
    for (const match of source.matchAll(/^\s*(?:const|let|function)\s+([A-Z][A-Za-z0-9_]*)/gm)) {
      violations.push(`${file}:${match[1]}`)
    }
  }
  expect(violations).toEqual([])
})
