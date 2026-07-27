import { resolve } from "node:path"

const Image =
  "node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d"
const PackageRoot = resolve(import.meta.dir, "../..")
const RepositoryRoot = resolve(PackageRoot, "../../..")
const Script = resolve(import.meta.dir, "published-behavior.ts")
const ContainerName = `likego-registry-etcd-runtime-${Date.now()}`

interface CommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly code: number
}

/** Runs one command and captures complete diagnostic streams. */
async function run(command: readonly string[], cwd: string): Promise<CommandResult> {
  const child = Bun.spawn(Array.from(command), { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ])
  if (code !== 0) throw new Error(`${command[0] ?? "runtime"} failed: ${stderr.trim()}`)
  return Object.freeze({ stdout: stdout.trim(), stderr: stderr.trim(), code })
}

/** Requires the stable published behavior marker from one runtime lane. */
async function behavior(command: readonly string[], cwd: string): Promise<CommandResult> {
  const result = await run(command, cwd)
  if (!result.stdout.includes("LIKEGO_REGISTRY_ETCD_PUBLISHED_RUNTIME=")) {
    throw new Error(`${command[0] ?? "runtime"} omitted the published behavior marker`)
  }
  return result
}

const bunVersion = (await run(["bun", "--version"], PackageRoot)).stdout
const nodeVersion = (await run(["node", "--version"], PackageRoot)).stdout
const denoVersion = (await run(["deno", "--version"], PackageRoot)).stdout.split("\n")[0] ?? ""
await behavior(["bun", Script], PackageRoot)
await behavior(["node", "--experimental-strip-types", Script], PackageRoot)
await behavior(
  ["deno", "run", "--config", resolve(RepositoryRoot, "deno.json"), Script],
  PackageRoot
)
let docker: CommandResult | null = null
try {
  docker = await behavior(
    [
      "docker",
      "run",
      "--rm",
      "--name",
      ContainerName,
      "--label",
      "likego.suite=registry-etcd-runtime",
      "-v",
      `${RepositoryRoot}:/workspace`,
      "-w",
      "/workspace/packages/registry/etcd",
      Image,
      "node",
      "--experimental-strip-types",
      "test/integration/published-behavior.ts"
    ],
    PackageRoot
  )
} finally {
  Bun.spawnSync(["docker", "rm", "-f", ContainerName], {
    cwd: PackageRoot,
    stdout: "ignore",
    stderr: "ignore"
  })
}
const remaining = Bun.spawnSync(["docker", "inspect", ContainerName], {
  cwd: PackageRoot,
  stdout: "pipe",
  stderr: "pipe"
})
if (remaining.exitCode === 0 && remaining.stdout.toString().trim() !== "[]") {
  throw new Error("published runtime Docker lane left a test-owned container")
}
if (docker === null) throw new Error("published runtime Docker lane did not execute")
console.log(
  `LIKEGO_REGISTRY_ETCD_RUNTIME_RESULT=${JSON.stringify({
    valid: true,
    bunVersion,
    nodeVersion,
    denoVersion,
    dockerImage: Image,
    remainingContainers: 0
  })}`
)
