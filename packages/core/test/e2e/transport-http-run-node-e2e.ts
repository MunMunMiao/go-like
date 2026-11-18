import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join, resolve } from "node:path"

const packageRoot = resolve(import.meta.dir, "../..")
const artifactRoot = join(packageRoot, ".artifacts")
await mkdir(artifactRoot, { recursive: true })
const stage = await mkdtemp(join(artifactRoot, "node-host-e2e-"))

try {
  // Bundle the test, the private Node host, and core so this Node process loads one copy.
  const built = await Bun.build({
    entrypoints: [join(packageRoot, "test/e2e/transport-http-node-e2e.ts")],
    outdir: stage,
    naming: "[name].mjs",
    format: "esm",
    target: "node"
  })
  if (!built.success) {
    throw new Error(`private Node host E2E build failed: ${built.logs.join("\n")}`)
  }

  const environment: Record<string, string | undefined> = {}
  for (const [name, value] of Object.entries(process.env)) environment[name] = value
  const noProxy = [environment.NO_PROXY, environment.no_proxy, "127.0.0.1", "localhost", "::1"]
    .filter(Boolean)
    .join(",")
  environment.NO_PROXY = noProxy
  environment.no_proxy = noProxy

  /** Runs one child process and returns its exact exit status. */
  async function run(argv: readonly string[]): Promise<number> {
    const child = Bun.spawn(Array.from(argv), {
      cwd: packageRoot,
      env: environment,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit"
    })
    return await child.exited
  }

  const standardExit = await run(["node", join(stage, "transport-http-node-e2e.mjs")])
  process.exitCode =
    standardExit === 0
      ? await run(["bun", "x", "tsx", "test/e2e/transport-http-node-secure-e2e.ts"])
      : standardExit
} finally {
  await rm(stage, { recursive: true, force: true })
}
