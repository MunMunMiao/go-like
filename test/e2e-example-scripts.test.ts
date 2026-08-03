import { expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import { join } from "node:path"

import { discoverExampleExecutionInputs } from "../e2e/examples"

const Root = join(import.meta.dir, "..")
const WrapperPrefix = "bun ../../e2e/example-task.ts -- "
const AllowedScenarioCommands = new Set([
  "bun ../../e2e/example.ts",
  "bun e2e/docker.ts",
  "bun test/e2e/docker-e2e.ts",
  "bunx --no-install tsx test/e2e/docker-e2e.ts",
  "tsx test/node-e2e.ts"
])

interface Manifest {
  readonly scripts?: Readonly<Record<string, unknown>>
}

test("every current example script enters the wrapper and preserves an owning scenario", async () => {
  const inputs = await discoverExampleExecutionInputs(Root)
  const observed = new Set<string>()
  for (const input of inputs) {
    const manifest: Manifest = await Bun.file(join(input.cwdRealpath, "package.json")).json()
    const script = manifest.scripts?.["test:e2e"]
    expect(typeof script).toBe("string")
    if (typeof script !== "string") continue
    expect(script.startsWith(WrapperPrefix)).toBe(true)
    const scenario = script.slice(WrapperPrefix.length)
    expect(AllowedScenarioCommands.has(scenario)).toBe(true)
    expect(scenario).not.toContain("example-task.ts")
    observed.add(input.id)
  }

  const immediate = (await readdir(join(Root, "examples"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
  expect(observed).toEqual(new Set(immediate))
})
