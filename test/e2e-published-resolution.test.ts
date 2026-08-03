import { expect, test } from "bun:test"
import { cp, readFile, readdir, unlink } from "node:fs/promises"
import { join, resolve } from "node:path"

import { runCommand } from "../e2e/harness/process"
import { createTempDirectory, removeTempDirectory, verifyTempDirectory } from "../e2e/harness/temp"
import {
  parseNpmPackOutput,
  publishedEnvironment,
  validateNodeEmit,
  validatePublishedTrace
} from "../e2e/published"

const Fixture = resolve("e2e/fixtures/published-consumer")

function packOutput(
  files: readonly { readonly path: string; readonly mode?: number }[],
  filename = "likego-context-0.0.1.tgz"
): string {
  return JSON.stringify([
    {
      name: "@likego/context",
      filename,
      files: files.map((file) => ({ ...file, mode: file.mode ?? 0o644 }))
    }
  ])
}

test("published fixtures are committed TypeScript with explicit runtime boundaries", async () => {
  const files = await readdir(Fixture, { recursive: true })
  expect(files.some((path) => path.endsWith(".mjs"))).toBe(false)
  expect(files).toEqual(
    expect.arrayContaining([
      "portable.ts",
      "node.ts",
      "bun.ts",
      "deno.ts",
      "tsconfig.authoring.json",
      "tsconfig.types.json",
      "tsconfig.node.json",
      "authoring-stubs/likego.d.ts"
    ])
  )
  const authoring = JSON.parse(await readFile(join(Fixture, "tsconfig.authoring.json"), "utf8"))
  expect(authoring.extends).toBeUndefined()
  expect(authoring.compilerOptions.paths).toEqual({
    "@likego/*": ["./authoring-stubs/likego.d.ts"]
  })
  const runner = await readFile(resolve("e2e/published.ts"), "utf8")
  expect(runner).toContain('"--no-install"')
  expect(runner).toContain('"--no-prompt"')
  expect(runner).not.toContain("--allow-all")
})

test("authoring check depends only on its committed wildcard stub", async () => {
  const directory = await createTempDirectory("likego-published-authoring-")
  try {
    await cp(Fixture, directory.path, { recursive: true })
    await verifyTempDirectory(directory)
    const command = [
      resolve("node_modules/.bin/tsc"),
      "-p",
      "tsconfig.authoring.json",
      "--pretty",
      "false"
    ]
    const positive = await runCommand(process.cwd(), {
      cwd: directory.path,
      command,
      timeoutMs: 30_000,
      environment: { NODE_OPTIONS: undefined, NODE_PATH: undefined }
    })
    expect(positive.timedOut).toBe(false)
    expect(positive.termination).toBe("exit")
    expect(positive.cleanupFailures).toHaveLength(0)
    expect(positive.exitCode).toBe(0)
    await unlink(join(directory.path, "authoring-stubs/likego.d.ts"))
    await verifyTempDirectory(directory)
    const negative = await runCommand(process.cwd(), {
      cwd: directory.path,
      command,
      timeoutMs: 30_000,
      environment: { NODE_OPTIONS: undefined, NODE_PATH: undefined }
    })
    expect(negative.timedOut).toBe(false)
    expect(negative.termination).toBe("exit")
    expect(negative.cleanupFailures).toHaveLength(0)
    expect(negative.exitCode).not.toBe(0)
  } finally {
    await removeTempDirectory(directory)
  }
})

test("npm pack JSON accepts a complete safe inventory and rejects archive escapes", () => {
  const valid = [
    { path: "package.json" },
    { path: "index.js" },
    { path: "index.d.ts" },
    { path: "index.js.map" }
  ]
  expect(parseNpmPackOutput(packOutput(valid), "@likego/context")).toBe("likego-context-0.0.1.tgz")
  expect(() =>
    parseNpmPackOutput(packOutput([...valid, { path: "../escape" }]), "@likego/context")
  ).toThrow("unsafe entry")
  expect(() =>
    parseNpmPackOutput(packOutput([...valid, { path: "index.js" }]), "@likego/context")
  ).toThrow("duplicate entry")
  expect(() =>
    parseNpmPackOutput(packOutput([{ path: "package.json" }]), "@likego/context")
  ).toThrow("incomplete runtime contract")
  expect(() => parseNpmPackOutput(packOutput(valid, "..\\escape.tgz"), "@likego/context")).toThrow(
    "unsafe filename"
  )
})

test("published trace accepts only staged resolutions and requires every public package", () => {
  const stage = "/tmp/likego-published-trace"
  const valid = [
    "======== Module name '@likego/context' was successfully resolved to '/tmp/likego-published-trace/node_modules/@likego/context/index.d.ts'. ========",
    "======== Module name '@likego/core' was successfully resolved to '/tmp/likego-published-trace/node_modules/@likego/core/index.d.ts'. ========"
  ].join("\n")
  expect(() =>
    validatePublishedTrace(valid, stage, ["@likego/context", "@likego/core"])
  ).not.toThrow()
  expect(() =>
    validatePublishedTrace(
      valid.replace(
        "/tmp/likego-published-trace/node_modules/@likego/context",
        `${process.cwd()}/packages/context/src`
      ),
      stage,
      ["@likego/context", "@likego/core"]
    )
  ).toThrow("escaped staged node_modules")
  expect(() => validatePublishedTrace(valid, stage, ["@likego/context", "@likego/server"])).toThrow(
    "missed public packages"
  )
})

test("Node emit rewrites relative TS imports and preserves package specifiers", () => {
  expect(() =>
    validateNodeEmit(
      'import * as context from "@likego/context"',
      'import * as core from "@likego/core"\nimport { runPortable } from "./portable.js"'
    )
  ).not.toThrow()
  expect(() =>
    validateNodeEmit(
      'import * as context from "@likego/context"',
      'import { runPortable } from "./portable.ts"'
    )
  ).toThrow("did not rewrite")
})

test("published environment clears ambient module and tool configuration", () => {
  const environment = publishedEnvironment("/stage", {
    PATH: "/bin",
    HOME: "/ambient",
    NODE_PATH: "/ambient/node_modules",
    NODE_OPTIONS: "--require=/ambient/preload.js",
    node_path: "/ambient/lowercase-node-modules",
    NPM_CONFIG_PREFIX: "/ambient/npm",
    npm_config_registry: "https://ambient.invalid",
    BUN_OPTIONS: "--preload=/ambient/preload.ts",
    DENO_AUTH_TOKENS: "secret"
  })
  expect(environment.HOME).toBe("/stage/home")
  expect(environment.NODE_PATH).toBeUndefined()
  expect(environment.NODE_OPTIONS).toBeUndefined()
  expect(environment.node_path).toBeUndefined()
  expect(environment.NPM_CONFIG_PREFIX).toBeUndefined()
  expect(environment.npm_config_registry).toBeUndefined()
  expect(environment.BUN_OPTIONS).toBeUndefined()
  expect(environment.DENO_AUTH_TOKENS).toBeUndefined()
  expect(environment.npm_config_cache).toBe("/stage/cache/npm")
  expect(environment.BUN_INSTALL_CACHE_DIR).toBe("/stage/cache/bun")
  expect(environment.DENO_DIR).toBe("/stage/cache/deno")
  expect(Object.hasOwn(environment, "PATH")).toBe(false)
})
