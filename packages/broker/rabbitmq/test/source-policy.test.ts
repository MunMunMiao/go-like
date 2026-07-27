import { expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

test("production source avoids prohibited complexity", async () => {
  const sourceRoot = join(import.meta.dir, "..", "src")
  const violations: string[] = []
  for (const name of await readdir(sourceRoot)) {
    if (!name.endsWith(".ts")) continue
    const source = await readFile(join(sourceRoot, name), "utf8")
    if (/\bclass\s/.test(source)) violations.push(`${name}:class`)
    if (/\bas\s+(?:const|unknown|never|[A-Z])/.test(source)) violations.push(`${name}:assertion`)
    if (/\.\.\./.test(source)) violations.push(`${name}:spread`)
    if (/Object\.assign/.test(source)) violations.push(`${name}:Object.assign`)
    if (/@ts-(?:ignore|expect-error|nocheck)/.test(source)) violations.push(`${name}:suppression`)
  }
  expect(violations).toEqual([])
})
