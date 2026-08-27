import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const runner = join(import.meta.dir, "../scripts/test-unit-variants.ts")
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(
  workspaceScript = "bun test --isolate --no-orphans test/*.test.ts"
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "go-like-test-variants-"))
  roots.push(root)
  await Promise.all([
    mkdir(join(root, "test"), { recursive: true }),
    mkdir(join(root, "packages/example/test"), { recursive: true })
  ])
  await Promise.all([
    writeFile(join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*"] })),
    writeFile(
      join(root, "test/root.test.ts"),
      'import { expect, test } from "bun:test"\n' +
        'test("root", () => { console.log("ROOT_VARIANT_RUN"); expect(true).toBe(true) })\n'
    ),
    writeFile(
      join(root, "packages/example/package.json"),
      JSON.stringify({ scripts: { "test:unit": workspaceScript } })
    ),
    writeFile(join(root, "packages/example/failure.ts"), "process.exit(7)\n"),
    writeFile(
      join(root, "packages/example/test/example.test.ts"),
      'import { expect, test } from "bun:test"\n' +
        'test("workspace", () => { console.log("WORKSPACE_VARIANT_RUN"); expect(true).toBe(true) })\n'
    )
  ])
  return root
}

async function run(root: string, mode: "parallel" | "stability") {
  const child = Bun.spawn([process.execPath, runner, mode], {
    cwd: root,
    stderr: "pipe",
    stdout: "pipe"
  })
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text()
  ])
  return { exitCode, output: stdout + stderr }
}

test("randomizes and repeats root and workspace unit tests with reproducible seeds", async () => {
  const result = await run(await fixture(), "stability")

  expect(result.exitCode).toBe(0)
  expect(result.output.match(/ROOT_VARIANT_RUN/g)).toHaveLength(2)
  expect(result.output.match(/WORKSPACE_VARIANT_RUN/g)).toHaveLength(2)
  expect(result.output.match(/--seed=\d+/g)).toHaveLength(2)
  expect(result.output).toContain("[stability] root")
  expect(result.output).toContain("[stability] packages/example")
})

test("runs root and workspace unit files with two isolated workers", async () => {
  const result = await run(await fixture(), "parallel")

  expect(result.exitCode).toBe(0)
  expect(result.output.match(/ROOT_VARIANT_RUN/g)).toHaveLength(1)
  expect(result.output.match(/WORKSPACE_VARIANT_RUN/g)).toHaveLength(1)
  expect(result.output).not.toContain("--seed=")
  expect(result.output).toContain("[parallel] root")
  expect(result.output).toContain("[parallel] packages/example")
})

test("propagates the exact workspace failure exit code", async () => {
  const result = await run(await fixture("bun failure.ts"), "parallel")

  expect(result.exitCode).toBe(7)
  expect(result.output).toContain("[parallel] root")
  expect(result.output).toContain("[parallel] packages/example")
})
