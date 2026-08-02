import { expect, test } from "bun:test"
import { mkdir, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { discoverExampleExecutionInputs, ExampleInputError } from "../e2e/examples"
import { createTempDirectory, removeTempDirectory } from "../e2e/harness/temp"

async function writeExample(
  root: string,
  id: string,
  manifest: Readonly<Record<string, unknown>>
): Promise<string> {
  const directory = join(root, "examples", id)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(join(directory, "package.json"), `${JSON.stringify(manifest)}\n`, {
    mode: 0o600
  })
  return directory
}

function manifest(id: string, script = "bun scenario.ts"): Readonly<Record<string, unknown>> {
  return Object.freeze({
    name: `@likego/example-${id}`,
    private: true,
    scripts: Object.freeze({ "test:e2e": script })
  })
}

test("dynamic example input discovers only immediate real directories in stable ID order", async () => {
  const fixture = await createTempDirectory("likego-example-input-")
  try {
    await mkdir(join(fixture.path, "examples"), { mode: 0o700 })
    await writeExample(fixture.path, "zebra-service", manifest("zebra-service"))
    await writeExample(fixture.path, "alpha-service", manifest("alpha-service"))
    await writeFile(join(fixture.path, "examples", "ignored.txt"), "ignored", { mode: 0o600 })
    await mkdir(join(fixture.path, "outside"), { mode: 0o700 })
    if (process.platform !== "win32") {
      await symlink(
        join(fixture.path, "outside"),
        join(fixture.path, "examples", "linked-service"),
        "dir"
      )
    }

    const inputs = await discoverExampleExecutionInputs(fixture.path)
    expect(inputs.map((input) => input.id)).toEqual(["alpha-service", "zebra-service"])
    expect(inputs.map((input) => input.packageName)).toEqual([
      "@likego/example-alpha-service",
      "@likego/example-zebra-service"
    ])
    expect(inputs.every((input) => input.scriptName === "test:e2e")).toBe(true)
    expect(Object.isFrozen(inputs)).toBe(true)
  } finally {
    await removeTempDirectory(fixture)
  }
})

test("dynamic example input classifies a missing script before any command can spawn", async () => {
  const fixture = await createTempDirectory("likego-example-script-")
  try {
    await mkdir(join(fixture.path, "examples"), { mode: 0o700 })
    await writeExample(fixture.path, "missing-script", {
      name: "@likego/example-missing-script",
      private: true,
      scripts: {}
    })
    let failure: unknown = null
    try {
      await discoverExampleExecutionInputs(fixture.path)
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(ExampleInputError)
    expect(failure).toMatchObject({ code: "example-script-missing", exampleId: "missing-script" })
  } finally {
    await removeTempDirectory(fixture)
  }
})

test("dynamic example input rejects mismatched identity, visibility, and malformed manifests", async () => {
  const cases: readonly {
    readonly id: string
    readonly value: string | Readonly<Record<string, unknown>>
    readonly code: string
  }[] = [
    {
      id: "wrong-name",
      value: { ...manifest("wrong-name"), name: "@likego/example-other" },
      code: "example-name-mismatch"
    },
    {
      id: "public-package",
      value: { ...manifest("public-package"), private: false },
      code: "example-not-private"
    },
    { id: "broken-json", value: "{", code: "example-manifest-invalid" }
  ]
  for (const selected of cases) {
    const fixture = await createTempDirectory("likego-example-negative-")
    try {
      const directory = join(fixture.path, "examples", selected.id)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await writeFile(
        join(directory, "package.json"),
        typeof selected.value === "string" ? selected.value : JSON.stringify(selected.value),
        { mode: 0o600 }
      )
      let failure: unknown = null
      try {
        await discoverExampleExecutionInputs(fixture.path)
      } catch (error) {
        failure = error
      }
      expect(failure).toMatchObject({ code: selected.code })
    } finally {
      await removeTempDirectory(fixture)
    }
  }
})

test("repository dynamic input matches every current immediate example manifest", async () => {
  const inputs = await discoverExampleExecutionInputs(join(import.meta.dir, ".."))
  const immediateDirectories = (
    await Array.fromAsync(new Bun.Glob("*/package.json").scan("examples"))
  )
    .map((path) => path.split("/")[0])
    .filter((id): id is string => id !== undefined)
  expect(new Set(inputs.map((input) => input.id))).toEqual(new Set(immediateDirectories))
  expect(inputs).toHaveLength(immediateDirectories.length)
})
