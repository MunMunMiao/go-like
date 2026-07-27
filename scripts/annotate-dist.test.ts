import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { annotateDist } from "./annotate-dist"

const Roots: string[] = []

afterEach(async () => {
  for (const root of Roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "likego-annotate-dist-"))
  Roots.push(root)
  await mkdir(join(root, "dist"), { recursive: true })
  return root
}

async function write(root: string, path: string, content: string): Promise<void> {
  const absolute = join(root, "dist", path)
  await mkdir(join(absolute, ".."), { recursive: true })
  await Bun.write(absolute, content)
}

test("annotates a public entry with its adjacent declaration", async () => {
  const root = await fixture()
  await write(root, "index.js", "export const value = 1\n")
  await write(root, "index.d.ts", "export declare const value: number\n")

  await annotateDist(root, ["index.js"])

  expect(await Bun.file(join(root, "dist/index.js")).text()).toBe(
    '// @ts-self-types="./index.d.ts"\nexport const value = 1\n'
  )
})

test("preserves an executable shebang above the self-types header idempotently", async () => {
  const root = await fixture()
  await write(
    root,
    "cli.js",
    '#!/usr/bin/env node\n// @ts-self-types="./wrong.d.ts"\nexport const value = 1\n'
  )
  await write(root, "cli.d.ts", "export declare const value: number\n")

  await annotateDist(root, ["cli.js"])
  await annotateDist(root, ["cli.js"])

  expect(await Bun.file(join(root, "dist/cli.js")).text()).toBe(
    '#!/usr/bin/env node\n// @ts-self-types="./cli.d.ts"\nexport const value = 1\n'
  )
})

test("rejects a public entry without an adjacent declaration", async () => {
  const root = await fixture()
  await write(root, "index.js", "export {}\n")

  await expect(annotateDist(root, ["index.js"])).rejects.toThrow(
    `generated JavaScript declaration is missing: ${join(root, "dist/index.d.ts")}`
  )
})

test("leaves a declaration-free non-entry chunk unannotated", async () => {
  const root = await fixture()
  await write(root, "index.js", "export {}\n")
  await write(root, "index.d.ts", "export {}\n")
  await write(root, "chunk-shared.js", "export const shared = true\n")

  await annotateDist(root, ["index.js"])

  expect(await Bun.file(join(root, "dist/chunk-shared.js")).text()).toBe(
    "export const shared = true\n"
  )
})

test("uses an adjacent relative declaration for a nested public entry", async () => {
  const root = await fixture()
  await write(root, "node/testing.js", "export const testing = true\n")
  await write(root, "node/testing.d.ts", "export declare const testing: true\n")

  await annotateDist(root, ["node/testing.js"])

  expect(await Bun.file(join(root, "dist/node/testing.js")).text()).toBe(
    '// @ts-self-types="./testing.d.ts"\nexport const testing = true\n'
  )
})

test("creates an exact companion for a reachable declaration-only chunk", async () => {
  const root = await fixture()
  await write(root, "index.js", "export {}\n")
  await write(root, "index.d.ts", 'export { type Shared } from "./shared-BuildHash.js"\n')
  await write(root, "shared-BuildHash.d.ts", "export interface Shared { readonly value: string }\n")

  await annotateDist(root, ["index.js"])

  expect(await Bun.file(join(root, "dist/shared-BuildHash.js")).text()).toBe(
    '// @ts-self-types="./shared-BuildHash.d.ts"\nexport {}\n'
  )
})
