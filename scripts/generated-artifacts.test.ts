import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"
import { annotateDist } from "./annotate-dist"
import { cleanGenerated } from "./clean-generated"
import { verifyDist } from "./verify-dist"
import { distPackageManifest } from "./package-dist"

const Roots: string[] = []
const InventoryCliPath = fileURLToPath(new URL("./generate-file-inventory.cli.ts", import.meta.url))

afterEach(async () => {
  for (const root of Roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

/** Creates one isolated workspace-shaped directory for generated-artifact contract tests. */
async function workspaceFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "likego-generated-"))
  Roots.push(root)
  await mkdir(join(root, "packages"), { recursive: true })
  await mkdir(join(root, "adapters"), { recursive: true })
  await mkdir(join(root, "examples"), { recursive: true })
  await Bun.write(
    join(root, "package.json"),
    `${JSON.stringify({
      name: "likego-generated-fixture",
      private: true,
      workspaces: ["packages/*", "adapters/*", "examples/*"]
    })}\n`
  )
  return root
}

/** Writes UTF-8 fixture content while creating its parent directories. */
async function writeFixture(root: string, path: string, content: string): Promise<void> {
  const absolute = join(root, path)
  await mkdir(join(absolute, ".."), { recursive: true })
  await Bun.write(absolute, content)
}

/** Writes the source and dist metadata shared by one bundled package fixture. */
async function writePackageShell(
  root: string,
  location: string,
  outputs = true,
  bin?: string | Readonly<Record<string, string>>
): Promise<void> {
  const name = `@likego/${location.split("/").at(-1)}`
  const manifest: Record<string, unknown> = {
    name,
    version: "0.1.0",
    type: "module",
    publishConfig: { directory: "dist", access: "public" },
    exports: {
      ".": "./src/index.ts"
    }
  }
  if (bin !== undefined) manifest.bin = bin
  await writeFixture(root, `${location}/package.json`, `${JSON.stringify(manifest)}\n`)
  await writeFixture(root, `${location}/README.md`, `# ${name}\n`)
  await writeFixture(root, `${location}/LICENSE`, "MIT\n")
  await writeFixture(root, `${location}/dist/README.md`, `# ${name}\n`)
  await writeFixture(root, `${location}/dist/LICENSE`, "MIT\n")
  await writeFixture(
    root,
    `${location}/dist/package.json`,
    `${JSON.stringify(distPackageManifest(manifest, new Map()))}\n`
  )
  if (!outputs) return
  await writeFixture(
    root,
    `${location}/dist/index.js`,
    '// @ts-self-types="./index.d.ts"\nexport {}\n'
  )
  await writeFixture(root, `${location}/dist/index.d.ts`, "export {}\n")
}

/** Runs the inventory CLI against one isolated repository-shaped fixture. */
async function runInventory(root: string, arguments_: readonly string[]) {
  const subprocess = Bun.spawn({
    cmd: [process.execPath, InventoryCliPath, ...arguments_],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe"
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text()
  ])
  return { exitCode, stdout, stderr }
}

test("file inventory check fails closed on drift without rewriting the reviewed artifact", async () => {
  const root = await workspaceFixture()
  await mkdir(join(root, "docs"), { recursive: true })
  await writeFixture(root, "README.md", "fixture\n")
  await writeFixture(root, "packages/fixture/package.json", '{"name":"@likego/fixture"}\n')

  const generated = await runInventory(root, [])
  expect(generated.exitCode).toBe(0)
  expect(generated.stdout).toContain('"mode":"write","valid":true')
  const reviewed = await Bun.file(join(root, "docs/file-inventory.md")).text()

  const checked = await runInventory(root, ["--check"])
  expect(checked.exitCode).toBe(0)
  expect(checked.stdout).toContain('"mode":"check","valid":true')

  await writeFixture(root, "new-source.ts", "export const value = 1\n")
  const drifted = await runInventory(root, ["--check"])
  expect(drifted.exitCode).toBe(1)
  expect(drifted.stderr).toBe("LIKEGO_FILE_INVENTORY_DRIFT docs/file-inventory.md\n")
  expect(await Bun.file(join(root, "docs/file-inventory.md")).text()).toBe(reviewed)
})

test("cleanGenerated removes only transient publish and compiler state", async () => {
  const root = await workspaceFixture()
  await writeFixture(root, "packages/README.md", "not a workspace\n")
  await writeFixture(root, "packages/one/package.json", '{"name":"@likego/one"}\n')
  await writeFixture(root, "adapters/host/package.json", '{"name":"@likego/host"}\n')
  await writeFixture(
    root,
    "examples/fetch/package.json",
    '{"name":"@likego/example-fetch","private":true}\n'
  )
  await writeFixture(root, "packages/one/src/index.ts", "export const value = 1\n")
  await writeFixture(root, "packages/one/dist/index.js", "export const value = 1\n")
  await writeFixture(root, "packages/one/.artifacts/tsconfig.tsbuildinfo", "stale\n")
  await writeFixture(root, "packages/one/.artifacts/evidence.txt", "keep\n")
  await writeFixture(root, "adapters/host/dist/index.js", "export {}\n")
  await writeFixture(root, "examples/fetch/dist/index.js", "export {}\n")
  await writeFixture(root, "test-build/consumer/package.json", "{}\n")

  await cleanGenerated(root)

  expect(await Bun.file(join(root, "packages/one/src/index.ts")).exists()).toBe(true)
  expect(await Bun.file(join(root, "packages/one/.artifacts/evidence.txt")).exists()).toBe(true)
  expect(await Bun.file(join(root, "packages/one/dist/index.js")).exists()).toBe(false)
  expect(await Bun.file(join(root, "packages/one/.artifacts/tsconfig.tsbuildinfo")).exists()).toBe(
    false
  )
  expect(await Bun.file(join(root, "adapters/host/dist/index.js")).exists()).toBe(false)
  expect(await Bun.file(join(root, "examples/fetch/dist/index.js")).exists()).toBe(false)
  expect(await Bun.file(join(root, "test-build/consumer/package.json")).exists()).toBe(false)
})

test("cleanGenerated follows root workspaces into explicit nested packages", async () => {
  const root = await workspaceFixture()
  await writeFixture(
    root,
    "package.json",
    `${JSON.stringify({
      name: "likego-generated-fixture",
      private: true,
      workspaces: ["packages/*", "packages/config/consul"]
    })}\n`
  )
  await writeFixture(
    root,
    "packages/config/package.json",
    `${JSON.stringify({
      name: "@likego/config",
      private: false
    })}\n`
  )
  await writeFixture(
    root,
    "packages/config/consul/package.json",
    `${JSON.stringify({
      name: "@likego/config-consul",
      private: false
    })}\n`
  )
  await writeFixture(root, "packages/config/dist/index.js", "export const parent = true\n")
  await writeFixture(root, "packages/config/consul/dist/index.js", "export const child = true\n")
  await writeFixture(root, "packages/config/consul/.artifacts/tsconfig.tsbuildinfo", "stale\n")
  await writeFixture(root, "packages/config/consul/.artifacts/evidence.txt", "keep\n")

  await cleanGenerated(root)

  expect(await Bun.file(join(root, "packages/config/dist/index.js")).exists()).toBe(false)
  expect(await Bun.file(join(root, "packages/config/consul/dist/index.js")).exists()).toBe(false)
  expect(
    await Bun.file(join(root, "packages/config/consul/.artifacts/tsconfig.tsbuildinfo")).exists()
  ).toBe(false)
  expect(await Bun.file(join(root, "packages/config/consul/.artifacts/evidence.txt")).text()).toBe(
    "keep\n"
  )
})

test("annotateDist binds every emitted JavaScript module to its adjacent declaration idempotently", async () => {
  const root = await workspaceFixture()
  const workspace = join(root, "packages/one")
  await writeFixture(root, "packages/one/dist/index.js", "export const value = 1\n")
  await writeFixture(root, "packages/one/dist/index.d.ts", "export declare const value: number\n")
  await writeFixture(
    root,
    "packages/one/dist/nested/worker.js",
    '// @ts-self-types="./wrong.d.ts"\nexport {}\n'
  )
  await writeFixture(root, "packages/one/dist/nested/worker.d.ts", "export {}\n")

  await annotateDist(workspace)
  await annotateDist(workspace)

  expect(await Bun.file(join(workspace, "dist/index.js")).text()).toBe(
    '// @ts-self-types="./index.d.ts"\nexport const value = 1\n'
  )
  expect(await Bun.file(join(workspace, "dist/nested/worker.js")).text()).toBe(
    '// @ts-self-types="./worker.d.ts"\nexport {}\n'
  )
})

test("annotateDist rejects JavaScript without an adjacent declaration", async () => {
  const root = await workspaceFixture()
  const workspace = join(root, "adapters/one")
  await writeFixture(root, "adapters/one/dist/index.js", "export {}\n")

  await expect(annotateDist(workspace)).rejects.toThrow(
    `generated JavaScript declaration is missing: ${join(workspace, "dist/index.d.ts")}`
  )
})

test("annotateDist leaves declaration-free shared chunks untouched", async () => {
  const root = await workspaceFixture()
  const workspace = join(root, "packages/one")
  await writeFixture(root, "packages/one/dist/index.js", "export {}\n")
  await writeFixture(root, "packages/one/dist/index.d.ts", "export {}\n")
  await writeFixture(root, "packages/one/dist/chunk-shared.js", "export const value = 1\n")

  await annotateDist(workspace, ["index.js"])

  expect(await Bun.file(join(workspace, "dist/index.js")).text()).toStartWith(
    '// @ts-self-types="./index.d.ts"\n'
  )
  expect(await Bun.file(join(workspace, "dist/chunk-shared.js")).text()).toBe(
    "export const value = 1\n"
  )
})

test("verifyDist accepts rewritten JavaScript and declaration targets without rewriting bare packages", async () => {
  const root = await workspaceFixture()
  await writePackageShell(root, "packages/good")
  await writeFixture(
    root,
    "packages/good/dist/index.js",
    ['// @ts-self-types="./index.d.ts"', 'export { background } from "@likego/context"', ""].join(
      "\n"
    )
  )
  await writeFixture(
    root,
    "packages/good/dist/index.d.ts",
    'export { background } from "@likego/context"\n'
  )

  await expect(verifyDist(root)).resolves.toBeUndefined()
})

test("verifyDist ignores import-like text held inside generated source strings", async () => {
  const root = await workspaceFixture()
  await writePackageShell(root, "packages/generator")
  await writeFixture(
    root,
    "packages/generator/dist/index.js",
    [
      '// @ts-self-types="./index.d.ts"',
      'export const generated = `import { value } from "./generated-source.ts"`',
      ""
    ].join("\n")
  )

  await expect(verifyDist(root)).resolves.toBeUndefined()
})

test("verifyDist accepts a published bin only with its shebang above the self-types header", async () => {
  const root = await workspaceFixture()
  await writePackageShell(root, "packages/cli", true, {
    "likego-cli": "./dist/cli.js"
  })
  await writeFixture(root, "packages/cli/dist/cli.d.ts", "export {}\n")
  await writeFixture(
    root,
    "packages/cli/dist/cli.js",
    '#!/usr/bin/env node\n// @ts-self-types="./cli.d.ts"\nexport {}\n'
  )

  await expect(verifyDist(root)).resolves.toBeUndefined()

  await writeFixture(
    root,
    "packages/cli/dist/cli.js",
    '#!/usr/bin/env node\nexport {}\n// @ts-self-types="./cli.d.ts"\n'
  )
  await expect(verifyDist(root)).rejects.toThrow(
    "packages/cli/dist/cli.js: Deno self-types header is missing or incorrect"
  )
})

test("verifyDist rejects a stale dist version before accepting the regenerated publish manifest", async () => {
  const root = await workspaceFixture()
  await writePackageShell(root, "packages/versioned")
  const source = await Bun.file(join(root, "packages/versioned/package.json")).json()
  const stale = distPackageManifest({ ...source, version: "0.0.1" }, new Map())
  await writeFixture(root, "packages/versioned/dist/package.json", `${JSON.stringify(stale)}\n`)

  await expect(verifyDist(root)).rejects.toThrow(
    "packages/versioned/dist/package.json: generated package manifest drifted"
  )

  await writeFixture(
    root,
    "packages/versioned/dist/package.json",
    `${JSON.stringify(distPackageManifest(source, new Map()))}\n`
  )
  await expect(verifyDist(root)).resolves.toBeUndefined()
})

test("verifyDist rejects a minified lane even when its declaration is complete", async () => {
  const root = await workspaceFixture()
  await writePackageShell(root, "packages/min")
  await writeFixture(
    root,
    "packages/min/dist/index.min.js",
    '// @ts-self-types="./index.min.d.ts"\nexport {}\n'
  )
  await writeFixture(root, "packages/min/dist/index.min.d.ts", "export {}\n")

  await expect(verifyDist(root)).rejects.toThrow("unexpected distribution file: index.min.js")
})

test("verifyDist accepts only an exact type companion for declaration-only chunks", async () => {
  const root = await workspaceFixture()
  await writePackageShell(root, "packages/type-chunk")
  await writeFixture(
    root,
    "packages/type-chunk/dist/index.d.ts",
    'export { type Shared } from "./shared-BuildHash.js"\n'
  )
  await writeFixture(
    root,
    "packages/type-chunk/dist/shared-BuildHash.d.ts",
    "export interface Shared { readonly value: string }\n"
  )

  await expect(verifyDist(root)).rejects.toThrow(
    "packages/type-chunk/dist/shared-BuildHash.d.ts: adjacent generated JavaScript is missing"
  )

  await writeFixture(
    root,
    "packages/type-chunk/dist/shared-BuildHash.js",
    '// @ts-self-types="./shared-BuildHash.d.ts"\nexport {}\n'
  )
  await expect(verifyDist(root)).resolves.toBeUndefined()

  await writeFixture(
    root,
    "packages/type-chunk/dist/shared-BuildHash.js",
    '// @ts-self-types="./shared-BuildHash.d.ts"\nexport const leakedRuntime = true\n'
  )
  await expect(verifyDist(root)).rejects.toThrow(
    "packages/type-chunk/dist/shared-BuildHash.js: type-only companion content is invalid"
  )
})

test("verifyDist requires both runtime and declaration targets for declaration imports", async () => {
  const root = await workspaceFixture()
  await writePackageShell(root, "packages/missing-type-target")
  await writeFixture(
    root,
    "packages/missing-type-target/dist/index.js",
    '// @ts-self-types="./index.d.ts"\nexport { shared } from "./shared.js"\n'
  )
  await writeFixture(
    root,
    "packages/missing-type-target/dist/index.d.ts",
    'export { shared } from "./shared.js"\n'
  )
  await writeFixture(
    root,
    "packages/missing-type-target/dist/shared.js",
    "export const shared = 1\n"
  )

  await expect(verifyDist(root)).rejects.toThrow(
    "packages/missing-type-target/dist/index.d.ts: relative generated declaration target is missing: ./shared.js"
  )
})

test("verifyDist reports missing output and every unsafe generated relative target", async () => {
  const root = await workspaceFixture()
  await writePackageShell(root, "packages/empty", false)
  await rm(join(root, "packages/empty/dist"), { recursive: true, force: true })
  await writePackageShell(root, "packages/extension")
  await writeFixture(
    root,
    "packages/extension/dist/index.js",
    '// @ts-self-types="./index.d.ts"\nexport { value } from "./value"\n'
  )
  await writePackageShell(root, "packages/missing")
  await writeFixture(
    root,
    "packages/missing/dist/index.js",
    '// @ts-self-types="./index.d.ts"\nexport { value } from "./absent.js"\n'
  )
  await writePackageShell(root, "adapters/escape")
  await writeFixture(
    root,
    "adapters/escape/dist/index.js",
    '// @ts-self-types="./index.d.ts"\nexport { value } from "../outside.js"\n'
  )
  await writePackageShell(root, "packages/unpaired-js", false)
  await writeFixture(root, "packages/unpaired-js/dist/index.js", "export {}\n")
  await writePackageShell(root, "packages/unpaired-types", false)
  await writeFixture(root, "packages/unpaired-types/dist/index.d.ts", "export {}\n")

  await expect(verifyDist(root)).rejects.toThrow(
    [
      "generated distribution verification failed:",
      "adapters/escape/dist/index.js: relative generated import escapes dist: ../outside.js",
      "packages/empty/package.json: distribution output is missing",
      "packages/extension/dist/index.js: relative generated import must end in .js: ./value",
      "packages/missing/dist/index.js: relative generated import target is missing: ./absent.js",
      "packages/unpaired-js/dist/index.d.ts: required distribution file is missing",
      "packages/unpaired-js/dist/index.js: adjacent generated declaration is missing",
      "packages/unpaired-types/dist/index.d.ts: adjacent generated JavaScript is missing",
      "packages/unpaired-types/dist/index.js: required distribution file is missing"
    ].join("\n")
  )
})
