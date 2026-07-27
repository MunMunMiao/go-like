import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { expect, test } from "bun:test"

const root = join(import.meta.dir, "..")
const allowedImports = new Set([
  "@likego/context",
  "@likego/core/lifecycle",
  "@likego/registry",
  "@likego/registry/provider",
  "node-zookeeper-client"
])

/** Extracts every static module specifier from production source text. */
function imports(source: string): readonly string[] {
  const result: string[] = []
  const pattern = /(?:from\s+|import\s*)["']([^"']+)["']/g
  for (const match of source.matchAll(pattern)) {
    const value = match[1]
    if (value !== undefined) result.push(value)
  }
  return Object.freeze(result)
}

test("production source remains Node/Bun-only and dependency-closed", async () => {
  const violations: string[] = []
  for await (const file of new Bun.Glob("src/**/*.ts").scan({ cwd: root, onlyFiles: true })) {
    const source = await readFile(join(root, file), "utf8")
    if (/@ts-(?:ignore|expect-error|nocheck)\b/.test(source)) {
      violations.push(`${file}:ts-suppression`)
    }
    if (/\b(?:eval|Function)\s*\(/.test(source)) violations.push(`${file}:dynamic-code`)
    if (/\b(?:document|window|navigator|localStorage)\b/.test(source)) {
      violations.push(`${file}:frontend-global`)
    }
    for (const specifier of imports(source)) {
      if (!specifier.startsWith(".") && !allowedImports.has(specifier)) {
        violations.push(`${file}:module:${specifier}`)
      }
      if (specifier.startsWith("node:")) violations.push(`${file}:node-module:${specifier}`)
    }
  }
  expect(violations).toEqual([])
})
