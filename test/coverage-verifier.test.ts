import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const verifier = join(import.meta.dir, "../scripts/verify-coverage.ts")
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(lcov: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "go-like-coverage-"))
  roots.push(root)
  await mkdir(join(root, "packages/example/src"), { recursive: true })
  await mkdir(join(root, "packages/example/.artifacts/coverage"), { recursive: true })
  await mkdir(join(root, "examples/app/src"), { recursive: true })
  await Promise.all([
    writeFile(
      join(root, "package.json"),
      JSON.stringify({ workspaces: ["packages/*", "examples/*"] })
    ),
    writeFile(
      join(root, "packages/example/package.json"),
      JSON.stringify({ scripts: { "test:unit:coverage": "bun test --coverage" } })
    ),
    writeFile(join(root, "packages/example/src/index.ts"), "export const answer = 42\n"),
    writeFile(
      join(root, "packages/example/src/types.ts"),
      "export interface Answer { value: number }\n"
    ),
    writeFile(
      join(root, "examples/app/package.json"),
      JSON.stringify({ scripts: { "test:e2e": "bun src/main.ts" } })
    ),
    writeFile(join(root, "examples/app/src/main.ts"), "console.log('app')\n"),
    writeFile(join(root, "packages/example/.artifacts/coverage/lcov.info"), lcov)
  ])
  return root
}

async function verify(root: string): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const child = Bun.spawn([process.execPath, verifier, root], { stderr: "pipe", stdout: "pipe" })
  return {
    exitCode: await child.exited,
    stderr: await new Response(child.stderr).text(),
    stdout: await new Response(child.stdout).text()
  }
}

test("accepts a complete one-to-one coverage inventory", async () => {
  const root = await fixture("SF:src/index.ts\nFNF:1\nFNH:1\nLF:1\nLH:1\nend_of_record\n")

  expect(await verify(root)).toEqual({
    exitCode: 0,
    stderr: "",
    stdout:
      "Coverage verified: 1 executable module, 1 type-only module, 1 example composition root across 1 report.\n"
  })
})

test("rejects an executable module missing from the expected workspace report", async () => {
  const root = await fixture("SF:src/index.ts\nFNF:1\nFNH:1\nLF:1\nLH:1\nend_of_record\n")
  await writeFile(join(root, "packages/example/src/missing.ts"), "export const missing = true\n")

  const result = await verify(root)
  expect(result.exitCode).toBe(1)
  expect(result.stderr).toBe("missing executable modules:\n- packages/example/src/missing.ts\n")
})

test("requires exactly one composition root per example workspace", async () => {
  const root = await fixture("SF:src/index.ts\nFNF:1\nFNH:1\nLF:1\nLH:1\nend_of_record\n")
  await mkdir(join(root, "examples/empty"), { recursive: true })
  await writeFile(
    join(root, "examples/empty/package.json"),
    JSON.stringify({ scripts: { "test:e2e": "bun src/main.ts" } })
  )

  const result = await verify(root)
  expect(result.exitCode).toBe(1)
  expect(result.stderr).toBe(
    "examples/empty/package.json requires exactly one src/main.ts composition root\n"
  )
})

test("rejects an LCOV record without its record terminator", async () => {
  const root = await fixture("SF:src/index.ts\nFNF:1\nFNH:1\nLF:1\nLH:1\n")

  const result = await verify(root)
  expect(result.exitCode).toBe(1)
  expect(result.stderr).toContain("contains an incomplete LCOV record")
})

test("rejects duplicate source records", async () => {
  const record = "SF:src/index.ts\nFNF:1\nFNH:1\nLF:1\nLH:1\nend_of_record\n"
  const root = await fixture(record + record)

  const result = await verify(root)
  expect(result.exitCode).toBe(1)
  expect(result.stderr).toBe("duplicate LCOV source record: packages/example/src/index.ts\n")
})

test.each([
  ["an empty", "LF", ""],
  ["a non-decimal", "LF", "+0"],
  ["an empty", "LH", ""],
  ["a non-decimal", "LH", "+0"],
  ["an empty", "FNF", ""],
  ["a non-decimal", "FNF", "+0"],
  ["an empty", "FNH", ""],
  ["a non-decimal", "FNH", "+0"]
])("rejects %s numeric %s summary", async (_kind, field, value) => {
  const summaries = { LF: "0", LH: "0", FNF: "0", FNH: "0", [field]: value }
  const root = await fixture(
    `SF:src/index.ts\nFNF:${summaries.FNF}\nFNH:${summaries.FNH}\nLF:${summaries.LF}\nLH:${summaries.LH}\nend_of_record\n`
  )

  const result = await verify(root)
  expect(result.exitCode).toBe(1)
  expect(result.stderr).toBe(
    "packages/example/.artifacts/coverage/lcov.info contains malformed LF/LH/FNF/FNH summaries\n"
  )
})

test.each([
  ["line", "FNF:1\nFNH:1\nLF:2\nLH:1", "LF=2 LH=1 FNF=1 FNH=1"],
  ["function", "FNF:2\nFNH:1\nLF:1\nLH:1", "LF=1 LH=1 FNF=2 FNH=1"]
])("rejects an uncovered %s summary", async (_kind, summary, expected) => {
  const root = await fixture(`SF:src/index.ts\n${summary}\nend_of_record\n`)

  const result = await verify(root)
  expect(result.exitCode).toBe(1)
  expect(result.stderr).toBe(`packages/example/src/index.ts is not fully covered: ${expected}\n`)
})
