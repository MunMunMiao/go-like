import { expect, test } from "bun:test"
import { cp, unlink } from "node:fs/promises"
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
  filename = "go-like-context-0.0.1.tgz"
): string {
  return JSON.stringify([
    {
      name: "@go-like/context",
      filename,
      files: files.map((file) => ({ ...file, mode: file.mode ?? 0o644 }))
    }
  ])
}

test("authoring check depends only on its committed wildcard stub", async () => {
  const directory = await createTempDirectory("go-like-published-authoring-")
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
      timeoutMs: 65_000,
      environment: { NODE_OPTIONS: undefined, NODE_PATH: undefined }
    })
    expect(positive.timedOut).toBe(false)
    expect(positive.termination).toBe("exit")
    expect(positive.cleanupFailures).toHaveLength(0)
    expect(positive.exitCode).toBe(0)
    await unlink(join(directory.path, "authoring-stubs/go-like.d.ts"))
    await verifyTempDirectory(directory)
    const negative = await runCommand(process.cwd(), {
      cwd: directory.path,
      command,
      timeoutMs: 65_000,
      environment: { NODE_OPTIONS: undefined, NODE_PATH: undefined }
    })
    expect(negative.timedOut).toBe(false)
    expect(negative.termination).toBe("exit")
    expect(negative.cleanupFailures).toHaveLength(0)
    expect(negative.exitCode).not.toBe(0)
  } finally {
    await removeTempDirectory(directory)
  }
}, 75_000)

test("npm pack JSON accepts a complete safe inventory and rejects archive escapes", () => {
  const valid = [
    { path: "package.json" },
    { path: "index.js" },
    { path: "index.d.ts" },
    { path: "index.js.map" }
  ]
  expect(parseNpmPackOutput(packOutput(valid), "@go-like/context")).toBe(
    "go-like-context-0.0.1.tgz"
  )
  expect(() =>
    parseNpmPackOutput(packOutput([...valid, { path: "../escape" }]), "@go-like/context")
  ).toThrow("unsafe entry")
  expect(() =>
    parseNpmPackOutput(packOutput([...valid, { path: "index.js" }]), "@go-like/context")
  ).toThrow("duplicate entry")
  expect(() =>
    parseNpmPackOutput(packOutput([{ path: "package.json" }]), "@go-like/context")
  ).toThrow("incomplete runtime contract")
  expect(() => parseNpmPackOutput(packOutput(valid, "..\\escape.tgz"), "@go-like/context")).toThrow(
    "unsafe filename"
  )
})

test("published trace accepts only staged resolutions and requires every public package", () => {
  const stage = "/tmp/go-like-published-trace"
  const valid = [
    "======== Module name '@go-like/context' was successfully resolved to '/tmp/go-like-published-trace/node_modules/@go-like/context/index.d.ts'. ========",
    "======== Module name '@go-like/core' was successfully resolved to '/tmp/go-like-published-trace/node_modules/@go-like/core/index.d.ts'. ========"
  ].join("\n")
  expect(() =>
    validatePublishedTrace(valid, stage, ["@go-like/context", "@go-like/core"])
  ).not.toThrow()
  expect(() =>
    validatePublishedTrace(
      valid.replace(
        "/tmp/go-like-published-trace/node_modules/@go-like/context",
        `${process.cwd()}/packages/context/src`
      ),
      stage,
      ["@go-like/context", "@go-like/core"]
    )
  ).toThrow("escaped staged node_modules")
  expect(() =>
    validatePublishedTrace(valid, stage, ["@go-like/context", "@go-like/server"])
  ).toThrow("missed public packages")
})

test("Node emit rewrites relative TS imports and preserves package specifiers", () => {
  expect(() =>
    validateNodeEmit(
      'import * as context from "@go-like/context"',
      'import * as core from "@go-like/core"\nimport { runPortable } from "./portable.js"'
    )
  ).not.toThrow()
  expect(() =>
    validateNodeEmit(
      'import * as context from "@go-like/context"',
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
