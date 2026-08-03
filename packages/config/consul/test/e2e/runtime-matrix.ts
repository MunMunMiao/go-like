import { cp, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const Root = resolve(import.meta.dir, "../../../../..")
const Expected = '{"env":{"http":{"port":"8080"}},"file":{"enabled":true},"consul":{"release":2}}'
const Fixture = resolve(import.meta.dir, "../runtime-matrix.fixture.ts")
const StagedFixture = "runtime-matrix.mjs"
const PackageLocations = Object.freeze({
  context: "packages/context",
  core: "packages/core",
  config: "packages/config",
  "config-consul": "packages/config/consul"
})
/** Runs one argv-safe command and returns its trimmed standard output. */
async function command(args: readonly string[], cwd: string): Promise<string> {
  const process = Bun.spawn([...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const stdoutPromise = new Response(process.stdout).text()
  const stderrPromise = new Response(process.stderr).text()
  const exitCode = await process.exited
  const stdout = (await stdoutPromise).trim()
  const stderr = (await stderrPromise).trim()
  if (exitCode !== 0) throw new Error(`${args[0] ?? "command"} failed (${exitCode}): ${stderr}`)
  return stdout
}

/** Copies one built workspace package into an isolated publish-shaped node_modules tree. */
async function stagePackage(stage: string, name: string, location: string): Promise<void> {
  const target = join(stage, "node_modules", "@likego", name)
  await mkdir(target, { recursive: true })
  await cp(join(Root, location, "dist"), target, { recursive: true })
}

/** Validates one runtime's package-name-only output. */
function validate(runtime: string, output: string): void {
  if (output !== Expected) throw new Error(`${runtime} produced unexpected output: ${output}`)
}

/** Builds one isolated package stage and executes every declared portable runtime lane. */
async function main(): Promise<void> {
  const stage = await mkdtemp(join(tmpdir(), "likego-config-runtime-"))
  try {
    for (const [name, location] of Object.entries(PackageLocations)) {
      await stagePackage(stage, name, location)
    }
    await copyFile(Fixture, join(stage, StagedFixture))

    validate("bun", await command(["bun", StagedFixture], stage))
    validate("node", await command(["node", StagedFixture], stage))
    validate(
      "deno",
      await command(["deno", "run", "--node-modules-dir=manual", StagedFixture], stage)
    )
  } finally {
    await rm(stage, { recursive: true })
  }
}

await main()
