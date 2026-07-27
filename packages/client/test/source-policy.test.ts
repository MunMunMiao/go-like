import { readdir, readFile } from "node:fs/promises"

import { expect, test } from "bun:test"

test("portable client source has no runtime-specific imports or globals", async () => {
  const sourceRoot = `${import.meta.dir}/../src`
  for (const name of await readdir(sourceRoot)) {
    if (!name.endsWith(".ts")) continue
    const source = await readFile(`${sourceRoot}/${name}`, "utf8")
    expect(source).not.toContain('from "node:')
    expect(source).not.toContain('import("node:')
    expect(source).not.toMatch(/\b(?:AsyncLocalStorage|Bun|Deno|process)\b/)
  }
})
