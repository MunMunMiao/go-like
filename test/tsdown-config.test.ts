import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { distPackageManifest, packageEntries } from "../tsdown.config"

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
