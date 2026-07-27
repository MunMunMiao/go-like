import { afterEach, expect, test } from "bun:test"
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

const repositoryRoot = join(import.meta.dir, "..")
const configPath = join(repositoryRoot, ".oxfmtrc.json")
const oxfmtPath = join(repositoryRoot, "node_modules/.bin/oxfmt")
const roots: string[] = []

const expectedIgnorePatterns = [
  "**/node_modules/**",
  "**/dist/**",
  "**/coverage/**",
  "**/.artifacts/**",
  "**/reports/**",
  "**/test-build/**",
  ".git/**",
  ".idea/**",
  ".vscode/**",
  "**/.omo/**",
  "**/evidence/**",
  "docs/superpowers/**",
  "**/fixtures/**",
  "**/probes/**",
  "tmp/**",
  "temp/**",
  "vendor/**",
  "external/**",
  "**/*.tmp",
  "**/*.tmp.*",
  "**/*.temp",
  "**/*.temp.*",
  "**/*-report.md",
  "docs/file-inventory.md"
] as const

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function write(root: string, path: string): Promise<void> {
  const absolute = join(root, path)
  await mkdir(join(absolute, ".."), { recursive: true })
  await Bun.write(absolute, "export const value={nested:[1,2,3]}\n")
}

test("oxfmt scope formats engineering sources and excludes generated or external material", async () => {
  const config: unknown = await Bun.file(configPath).json()
  expect(config).toEqual({
    $schema: "./node_modules/oxfmt/configuration_schema.json",
    printWidth: 100,
    proseWrap: "preserve",
    semi: false,
    singleQuote: false,
    sortPackageJson: false,
    trailingComma: "none",
    ignorePatterns: [...expectedIgnorePatterns]
  })

  const root = await mkdtemp(join(tmpdir(), "likego-oxfmt-scope-"))
  roots.push(root)
  await copyFile(configPath, join(root, ".oxfmtrc.json"))
  await write(root, "src/index.ts")
  for (const path of [
    "node_modules/pkg/index.ts",
    "packages/fixture/dist/index.ts",
    "packages/fixture/coverage/index.ts",
    "packages/fixture/.artifacts/evidence.ts",
    "reports/result.ts",
    "test-build/result.ts",
    ".git/hooks/result.ts",
    ".idea/result.ts",
    ".vscode/result.ts",
    "packages/fixture/.omo/evidence/result.ts",
    "e2e/evidence/generated.ts",
    "docs/superpowers/plans/result.ts",
    "tools/family/fixtures/result.ts",
    "tools/family/probes/result.ts",
    "tmp/result.ts",
    "temp/result.ts",
    "vendor/result.ts",
    "external/result.ts",
    "integration/runtime-matrix-report.md",
    "scratch/result.tmp.ts",
    "scratch/result.temp.ts"
  ])
    await write(root, path)
  await Bun.write(join(root, "docs/file-inventory.md"), "#generated")

  const child = Bun.spawn(
    [oxfmtPath, "--config", join(root, ".oxfmtrc.json"), "--list-different", root],
    { cwd: root, stdout: "pipe", stderr: "pipe" }
  )
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ])
  expect(exitCode).toBe(1)
  expect(stderr).toBe("")
  const different = stdout
    .trim()
    .split(/\r?\n/)
    .filter((path) => path.length > 0)
  expect(different).toHaveLength(1)
  expect(different[0]?.replaceAll("\\", "/")).toEndWith("/src/index.ts")
})
