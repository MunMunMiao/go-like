import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { readdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import { runFrameworkDistConsumer } from "../e2e/harness/framework-stage"
import {
  canonicalTempRoot,
  createTempDirectory,
  createTempSubdirectory,
  removeTempDirectory
} from "../e2e/harness/temp"

async function matchingTempEntries(prefix: string): Promise<readonly string[]> {
  return (await readdir(await canonicalTempRoot())).filter((entry) => entry.startsWith(prefix))
}

test("framework staging rejects source exports and removes its failed invocation stage", async () => {
  const fixture = await createTempDirectory("likego-stage-fixture-")
  const packageDist = await createTempSubdirectory(fixture, ["packages", "web", "dist"])
  await writeFile(
    join(packageDist, "package.json"),
    JSON.stringify({
      name: "@likego/web",
      type: "module",
      exports: { ".": "./src/index.ts" }
    })
  )
  const prefix = `likego-stage-negative-${randomUUID()}-`
  try {
    await expect(
      runFrameworkDistConsumer({
        root: fixture.path,
        prefix,
        consumer: resolve("packages/web/test/e2e/fixtures/bridge-dist-consumer.mjs"),
        builtPackages: ["@likego/web"],
        vendorPackages: []
      })
    ).rejects.toThrow("dist exports workspace source")
    expect(await matchingTempEntries(prefix)).toEqual([])
  } finally {
    await removeTempDirectory(fixture)
  }
})

test("framework staging removes its stage after the committed consumer fails", async () => {
  const fixture = await createTempDirectory("likego-stage-consumer-")
  const packageDist = await createTempSubdirectory(fixture, ["packages", "web", "dist"])
  await writeFile(
    join(packageDist, "package.json"),
    JSON.stringify({ name: "@likego/web", type: "module", exports: { ".": "./index.js" } })
  )
  await writeFile(join(packageDist, "index.js"), "export const staged = true\n")
  const consumer = join(fixture.path, "consumer.mjs")
  await writeFile(consumer, "throw new Error('expected consumer failure')\n")
  const prefix = `likego-consumer-negative-${randomUUID()}-`
  try {
    await expect(
      runFrameworkDistConsumer({
        root: fixture.path,
        prefix,
        consumer,
        builtPackages: ["@likego/web"],
        vendorPackages: []
      })
    ).rejects.toThrow("framework dist consumer exited 1")
    expect(await matchingTempEntries(prefix)).toEqual([])
  } finally {
    await removeTempDirectory(fixture)
  }
})

test("framework staging aborts its Node consumer and removes the stage", async () => {
  const fixture = await createTempDirectory("likego-stage-abort-")
  const packageDist = await createTempSubdirectory(fixture, ["packages", "web", "dist"])
  await writeFile(
    join(packageDist, "package.json"),
    JSON.stringify({ name: "@likego/web", type: "module", exports: { ".": "./index.js" } })
  )
  await writeFile(join(packageDist, "index.js"), "export const staged = true\n")
  const consumer = join(fixture.path, "consumer.mjs")
  await writeFile(consumer, "setInterval(() => {}, 1_000)\n")
  const prefix = `likego-abort-negative-${randomUUID()}-`
  const controller = new AbortController()
  const abort = setTimeout(() => controller.abort(new Error("expected staging abort")), 100)
  try {
    await expect(
      runFrameworkDistConsumer({
        root: fixture.path,
        prefix,
        consumer,
        builtPackages: ["@likego/web"],
        vendorPackages: [],
        signal: controller.signal
      })
    ).rejects.toThrow("expected staging abort")
    expect(await matchingTempEntries(prefix)).toEqual([])
  } finally {
    clearTimeout(abort)
    await removeTempDirectory(fixture)
  }
})

test("framework staging rejects vendor packages that resolve into workspace packages", async () => {
  const fixture = await createTempDirectory("likego-stage-vendor-")
  const vendor = await createTempSubdirectory(fixture, ["packages", "vendor"])
  await writeFile(
    join(vendor, "package.json"),
    JSON.stringify({ name: "vendor", version: "1.0.0" })
  )
  const consumer = join(fixture.path, "consumer.mjs")
  await writeFile(consumer, "throw new Error('consumer must not run')\n")
  const prefix = `likego-vendor-negative-${randomUUID()}-`
  try {
    await expect(
      runFrameworkDistConsumer({
        root: fixture.path,
        prefix,
        consumer,
        builtPackages: [],
        vendorPackages: [{ name: "vendor", source: vendor }]
      })
    ).rejects.toThrow("vendor source resolved into the workspace packages tree")
    expect(await matchingTempEntries(prefix)).toEqual([])
  } finally {
    await removeTempDirectory(fixture)
  }
})
