import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const packageRoot = resolve(import.meta.dir, "../..")
const artifactRoot = join(packageRoot, ".artifacts")
await mkdir(artifactRoot, { recursive: true })
const stage = await mkdtemp(join(artifactRoot, "node-host-e2e-"))

try {
  const built = await Bun.build({
    entrypoints: [join(packageRoot, "src/node-host.ts")],
    outdir: stage,
    naming: "node-host.js",
    format: "esm",
    target: "node",
    external: ["@go-like/*"]
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
  environment.GO_LIKE_TRANSPORT_HTTP_NODE_HOST_E2E_MODULE = pathToFileURL(
    join(stage, "node-host.js")
  ).href

  /** Runs one real Node E2E script and stops at its exact exit status. */
  async function run(script: string): Promise<number> {
    const child = Bun.spawn(["bun", "x", "tsx", script], {
      cwd: packageRoot,
      env: environment,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit"
    })
    return await child.exited
  }

  const standardExit = await run("test/e2e/node-e2e.ts")
  process.exitCode = standardExit === 0 ? await run("test/e2e/node-secure-e2e.ts") : standardExit
} finally {
  await rm(stage, { recursive: true, force: true })
}
