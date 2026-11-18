import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  distPackageManifest,
  packageEntries,
  stripDistNodeSideEffectImports,
  stripNodeSideEffectImports
} from "../tsdown.config"

const source = {
  name: "@go-like/example",
  version: "0.0.1",
  private: true,
  type: "module",
  files: ["dist"],
  scripts: { build: "tsdown" },
  publishConfig: { directory: "dist", access: "public" },
  exports: {
    ".": "./src/index.ts",
    "./node": "./src/node.ts"
  }
}

test("builds every public export and writes a minimal dist manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "go-like-dist-manifest-"))
  try {
    expect(packageEntries(source)).toEqual({ index: "src/index.ts", node: "src/node.ts" })
    const manifest = await distPackageManifest(source, root)
    expect(manifest).toMatchObject({
      name: "@go-like/example",
      version: "0.0.1",
      main: "./index.js",
      module: "./index.js",
      types: "./index.d.ts",
      typings: "./index.d.ts",
      exports: {
        ".": { types: "./index.d.ts", import: "./index.js", default: "./index.js" },
        "./node": { types: "./node.d.ts", import: "./node.js", default: "./node.js" },
        "./package.json": "./package.json"
      },
      publishConfig: { access: "public" }
    })
    expect(manifest).not.toHaveProperty("scripts")
    expect(manifest).not.toHaveProperty("files")
    expect(manifest).not.toHaveProperty("private")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("rejects exports outside src", () => {
  expect(() => packageEntries({ ...source, exports: { ".": "../index.ts" } })).toThrow(
    "package export must target"
  )
})

test("builds a subpath-only package without root manifest fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "go-like-dist-manifest-"))
  try {
    const subpath = {
      ...source,
      name: "@go-like/pino",
      main: "./src/log.ts",
      module: "./src/log.ts",
      types: "./src/log.ts",
      typings: "./src/log.ts",
      exports: {
        "./log": "./src/log.ts",
        "./package.json": "./package.json"
      }
    }
    expect(packageEntries(subpath)).toEqual({ log: "src/log.ts" })
    const manifest = await distPackageManifest(subpath, root)
    expect(manifest.exports).toEqual({
      "./log": { types: "./log.d.ts", import: "./log.js", default: "./log.js" },
      "./package.json": "./package.json"
    })
    expect(manifest).not.toHaveProperty("main")
    expect(manifest).not.toHaveProperty("module")
    expect(manifest).not.toHaveProperty("types")
    expect(manifest).not.toHaveProperty("typings")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("rejects invalid export keys", () => {
  for (const key of ["./Log", "./*", "./foo/", "./foo/../bar", "./", "log", "./foo//bar"]) {
    expect(() => packageEntries({ ...source, exports: { [key]: "./src/index.ts" } })).toThrow(
      `package export key is invalid: ${key}`
    )
  }
})

test("rejects a manifest with no public exports", () => {
  expect(() => packageEntries({ ...source, exports: {} })).toThrow(
    "package exports must declare a public entry"
  )
  expect(() =>
    packageEntries({ ...source, exports: { "./package.json": "./package.json" } })
  ).toThrow("package exports must declare a public entry")
})

test("drops side-effect node imports and leaves every other declaration byte identical", () => {
  const source = [
    'import { g as Context } from "../index-F_JSxQLM.js";',
    'import "@go-like/core/context";',
    'import "node:http";',
    'import "node:http2";',
    'import { Discovery, Selector } from "@go-like/core/registry";',
    'import "@connectrpc/connect-node";',
    'import "../index-DeSJDZGk.js";',
    "export declare function hostname(value: string): string;",
    'declare module "node:worker_threads" {',
    "  type TransferListItem = Transferable;",
    "}",
    ""
  ].join("\n")
  const expected = [
    'import { g as Context } from "../index-F_JSxQLM.js";',
    'import "@go-like/core/context";',
    'import { Discovery, Selector } from "@go-like/core/registry";',
    'import "../index-DeSJDZGk.js";',
    "export declare function hostname(value: string): string;",
    'declare module "node:worker_threads" {',
    "  type TransferListItem = Transferable;",
    "}",
    ""
  ].join("\n")
  expect(stripNodeSideEffectImports(source, "node.d.ts")).toBe(expected)
})

test("keeps named node imports and import types that are not side effects", () => {
  const named = 'import { Server } from "node:http";\nexport type NodeServer = Server;\n'
  const multiline =
    'import {\n  Server,\n  type IncomingMessage as Message\n} from "node:http";\nexport type NodeServer = Server;\n'
  const query =
    'type Official = ReturnType<typeof import("pino").destination>;\nexport type Ready = Official;\n'
  const keywordAlias =
    'import { D as source, t as Config } from "../config-DVpnJTbQ.js";\nexport type Ready = Config;\n'
  expect(stripNodeSideEffectImports(named)).toBe(named)
  expect(stripNodeSideEffectImports(multiline)).toBe(multiline)
  expect(stripNodeSideEffectImports(query)).toBe(query)
  expect(stripNodeSideEffectImports(keywordAlias)).toBe(keywordAlias)
})

test("drops an empty node import and a redundant side-effect import when the name is bound elsewhere", () => {
  expect(
    stripNodeSideEffectImports(
      'import {} from "node:http";\nexport declare function ready(): void;\n'
    )
  ).toBe("export declare function ready(): void;\n")
  const source =
    'import { Buffer } from "./buffer.js";\nimport "node:buffer";\nexport declare function encode(value: Buffer): Uint8Array;\n'
  const expected =
    'import { Buffer } from "./buffer.js";\nexport declare function encode(value: Buffer): Uint8Array;\n'
  expect(stripNodeSideEffectImports(source)).toBe(expected)
  const parameter = 'import "node:buffer";\nexport declare function f(Buffer: string): void;\n'
  expect(stripNodeSideEffectImports(parameter)).toBe(
    "export declare function f(Buffer: string): void;\n"
  )
  const property = 'import "node:buffer";\nexport interface Options { readonly Buffer: string }\n'
  expect(stripNodeSideEffectImports(property)).toBe(
    "export interface Options { readonly Buffer: string }\n"
  )
})

test("fails when a removed module is still referenced by an exported type", () => {
  expect(() =>
    stripNodeSideEffectImports(
      'import "node:http";\nexport type Message = import("node:http").IncomingMessage;\n',
      "node.d.ts"
    )
  ).toThrow('node.d.ts still references "node:http"')
  expect(() =>
    stripNodeSideEffectImports(
      'import "node:http";\nimport type { Server } from "node:http";\nexport type NodeServer = Server;\n',
      "node.d.ts"
    )
  ).toThrow('node.d.ts still references "node:http"')
  expect(() =>
    stripNodeSideEffectImports(
      'import "node:http";\ndeclare module "node:http" {\n  interface IncomingMessage {}\n}\n',
      "node.d.ts"
    )
  ).toThrow('node.d.ts still references "node:http"')
  expect(() =>
    stripNodeSideEffectImports(
      'import "node:buffer";\nexport declare function encode(value: Buffer): Uint8Array;\n',
      "node.d.ts"
    )
  ).toThrow("node.d.ts uses Node type Buffer")
  expect(() =>
    stripNodeSideEffectImports(
      'import "node:buffer";\nexport declare function encode(value: BufferEncoding): Uint8Array;\n',
      "node.d.ts"
    )
  ).toThrow("node.d.ts uses Node type BufferEncoding")
  expect(() =>
    stripNodeSideEffectImports(
      'import "@connectrpc/connect-node";\nexport declare function serve(error: NodeJS.ErrnoException): void;\n',
      "node.d.ts"
    )
  ).toThrow("node.d.ts uses Node type NodeJS")
  expect(() =>
    stripNodeSideEffectImports(
      '/// <reference types="node" />\nimport "node:http";\nexport declare function ready(): void;\n',
      "node.d.ts"
    )
  ).toThrow("node.d.ts still references Node types")
})

test("writes stripped declarations only after every file passes", async () => {
  const root = await mkdtemp(join(tmpdir(), "go-like-dts-"))
  try {
    const good = join(root, "good.d.ts")
    const nested = join(root, "nested")
    const bad = join(nested, "bad.d.ts")
    const kept = join(root, "kept.d.ts")
    await mkdir(nested)
    const goodSource = 'import "node:http";\nexport declare function ready(): void;\n'
    const badSource =
      'import "node:net";\nexport declare function serve(error: NodeJS.ErrnoException): void;\n'
    const keptSource = 'import "@go-like/core/context";\nexport declare function ready(): void;\n'
    await writeFile(good, goodSource)
    await writeFile(bad, badSource)
    await writeFile(kept, keptSource)
    expect(() => stripDistNodeSideEffectImports(root)).toThrow("uses Node type NodeJS")
    expect(await readFile(good, "utf8")).toBe(goodSource)
    expect(await readFile(bad, "utf8")).toBe(badSource)
    expect(await readFile(kept, "utf8")).toBe(keptSource)

    await rm(bad)
    stripDistNodeSideEffectImports(root)
    expect(await readFile(good, "utf8")).toBe("export declare function ready(): void;\n")
    expect(await readFile(kept, "utf8")).toBe(keptSource)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
