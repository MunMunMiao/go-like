import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"
import process from "node:process"

import { expect, test } from "bun:test"

import { packageVersion, runCLI } from "../src/cli-run"
import { main } from "../src/cli"

/** Runs one CLI case with isolated output buffers. */
async function run(arguments_: readonly string[]): Promise<{
  readonly code: number
  readonly output: string
  readonly error: string
}> {
  let output = ""
  let error = ""
  const code = await runCLI(
    arguments_,
    "0.0.1",
    (value) => {
      output += value
    },
    (value) => {
      error += value
    }
  )
  return Object.freeze({ code, output, error })
}

test("accepts only help, version, or one target directory", async () => {
  expect(await run(["--help"])).toEqual({
    code: 0,
    output: expect.stringContaining("Usage: create-likego <project-directory>"),
    error: ""
  })
  expect(await run(["--version"])).toEqual({ code: 0, output: "0.0.1\n", error: "" })

  for (const arguments_ of [[], ["--unknown"], ["one", "two"]] as const) {
    const result = await run(arguments_)
    expect(result.code).toBe(1)
    expect(result.output).toBe("")
    expect(result.error).toContain("requires exactly one target directory")
  }
})

test("reports successful creation and filesystem failures without terminating the process", async () => {
  const root = await mkdtemp(join(tmpdir(), "likego-create-cli-"))
  try {
    const target = join(root, "billing-service")
    const created = await run([target])
    expect(created).toEqual({
      code: 0,
      output: expect.stringContaining(
        `Created billing-service in ${target}\n\n` +
          `Next:\n  cd ${target}\n  bun install\n  bun run start\n`
      ),
      error: ""
    })
    const rejected = await run([target])
    expect(rejected.code).toBe(1)
    expect(rejected.output).toBe("")
    expect(rejected.error).toContain("target directory already exists")
    expect(rejected.error).toContain("其中可能保留部分文件；请检查后手动处理")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("reads package versions from source and built-style layouts and fails closed", async () => {
  expect(await packageVersion(new URL("../src/cli.ts", import.meta.url).href)).toBe("0.0.1")

  const root = await mkdtemp(join(tmpdir(), "likego-create-version-"))
  try {
    const valid = JSON.stringify({ name: "@likego/create", version: "9.8.7" })
    await writeFile(join(root, "package.json"), valid)
    expect(await packageVersion(pathToFileURL(join(root, "cli.js")).href)).toBe("9.8.7")

    const nested = join(root, "src")
    await mkdir(nested)
    expect(await packageVersion(pathToFileURL(join(nested, "cli.ts")).href)).toBe("9.8.7")

    await writeFile(join(root, "package.json"), JSON.stringify({ name: "@likego/create" }))
    await expect(packageVersion(pathToFileURL(join(root, "cli.js")).href)).rejects.toThrow(
      "@likego/create package version is unavailable"
    )

    const invalid = join(root, "invalid")
    await mkdir(invalid)
    await writeFile(join(invalid, "package.json"), "{")
    await expect(
      packageVersion(pathToFileURL(join(invalid, "cli.js")).href)
    ).rejects.toBeInstanceOf(SyntaxError)

    const missing = join(root, "missing", "nested")
    await mkdir(missing, { recursive: true })
    await expect(packageVersion(pathToFileURL(join(missing, "cli.js")).href)).rejects.toThrow(
      "@likego/create package manifest is unavailable"
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("executes the shebang entry with the package version", async () => {
  const expectedVersion = await packageVersion(new URL("../src/cli.ts", import.meta.url).href)
  const child = Bun.spawn({
    cmd: ["bun", join(import.meta.dir, "../src/cli.ts"), "--version"],
    stdout: "pipe",
    stderr: "pipe"
  })
  const [code, output, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ])
  expect({ code, output, error }).toEqual({
    code: 0,
    output: `${expectedVersion}\n`,
    error: ""
  })
})

test("imports the guarded entry without executing it and invokes main explicitly", async () => {
  const originalWrite = process.stdout.write
  let output = ""
  Reflect.set(process.stdout, "write", (value: unknown) => {
    output += String(value)
    return true
  })
  try {
    expect(await main(["--version"])).toBe(0)
    expect(output).toBe(`${await packageVersion(new URL("../src/cli.ts", import.meta.url).href)}\n`)
  } finally {
    Reflect.set(process.stdout, "write", originalWrite)
  }
})
