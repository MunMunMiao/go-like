import { resolve } from "node:path"

import { dockerObjectExists } from "./docker-cleanup"

const Image =
  "node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d"
const PackageRoot = resolve(import.meta.dir, "../..")
const RepositoryRoot = resolve(PackageRoot, "../../..")
const Script = resolve(import.meta.dir, "published-behavior.ts")
const ContainerName = `likego-registry-consul-runtime-${Date.now()}`

interface CommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly code: number
}

/** Runs one command and captures its complete diagnostic streams. */
async function runCommand(command: readonly string[], cwd: string): Promise<CommandResult> {
  const child = Bun.spawn(Array.from(command), { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ])
  if (code !== 0) throw new Error(`${command[0] ?? "runtime"} failed: ${stderr.trim()}`)
  return Object.freeze({ stdout: stdout.trim(), stderr: stderr.trim(), code })
}

/** Runs one published behavior lane and requires its stable success marker. */
async function runBehavior(command: readonly string[], cwd: string): Promise<CommandResult> {
  const result = await runCommand(command, cwd)
  const stdout = result.stdout
  if (!stdout.includes("LIKEGO_REGISTRY_CONSUL_PUBLISHED_RUNTIME=")) {
    throw new Error(`${command[0] ?? "runtime"} omitted the published behavior marker`)
  }
  return result
}

const bunVersion = (await runCommand(["bun", "--version"], PackageRoot)).stdout
const nodeVersion = (await runCommand(["node", "--version"], PackageRoot)).stdout
const denoVersion =
  (await runCommand(["deno", "--version"], PackageRoot)).stdout.split("\n")[0] ?? ""
await runBehavior(["bun", Script], PackageRoot)
await runBehavior(["node", "--experimental-strip-types", Script], PackageRoot)
await runBehavior(
  ["deno", "run", "--config", resolve(RepositoryRoot, "deno.json"), Script],
  PackageRoot
)
let docker: CommandResult | null = null
try {
  docker = await runBehavior(
    [
      "docker",
      "run",
      "--rm",
      "--name",
      ContainerName,
      "--label",
      "likego.suite=registry-consul-runtime",
      "-v",
      `${RepositoryRoot}:/workspace`,
      "-w",
      "/workspace/packages/registry/consul",
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
if (
  dockerObjectExists({
    exitCode: remaining.exitCode,
    stdout: remaining.stdout.toString()
  })
) {
  throw new Error("published runtime Docker lane left a test-owned container")
}
if (docker === null) throw new Error("published runtime Docker lane did not execute")
console.log(
  `LIKEGO_REGISTRY_CONSUL_RUNTIME_RESULT=${JSON.stringify({
    valid: true,
    bunVersion,
    nodeVersion,
    denoVersion,
    dockerImage: Image,
    dockerMarker: docker.stdout.includes("LIKEGO_REGISTRY_CONSUL_PUBLISHED_RUNTIME="),
    remainingContainers: 0
  })}`
)
