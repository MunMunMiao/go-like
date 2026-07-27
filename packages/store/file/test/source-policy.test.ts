import { readFile } from "node:fs/promises"

import { expect, test } from "bun:test"

test("portable root contains no Node runtime import and Node binding stays in node-host", async () => {
  const root = `${import.meta.dir}/../src`
  for (const name of ["index.ts", "store.ts", "types.ts"]) {
    const source = await readFile(`${root}/${name}`, "utf8")
    expect(source).not.toContain('from "node:')
    expect(source).not.toContain('import("node:')
  }
  const nodeEntry = await readFile(`${root}/node.ts`, "utf8")
  expect(nodeEntry).not.toContain('from "node:')
  expect(nodeEntry).toContain('from "./node-host"')
  const nodeHost = await readFile(`${root}/node-host.ts`, "utf8")
  expect(nodeHost).toContain('from "node:fs/promises"')
  expect(nodeHost).toContain('from "node:path"')
})
