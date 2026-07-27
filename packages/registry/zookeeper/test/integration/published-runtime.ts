import { resolve } from "node:path"

const nodeLtsImage =
  "node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d"
const packageRoot = resolve(import.meta.dir, "../..")
const repositoryRoot = resolve(packageRoot, "../../..")
const script = resolve(import.meta.dir, "published-behavior.ts")
const containerName = `likego-registry-zookeeper-runtime-${Date.now()}`
const marker = "LIKEGO_REGISTRY_ZOOKEEPER_PUBLISHED_RUNTIME="

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

/** Requires the stable public behavior marker from one runtime lane. */
async function behavior(command: readonly string[], cwd: string): Promise<CommandResult> {
  const result = await run(command, cwd)
  if (!result.stdout.includes(marker)) {
    throw new Error(`${command[0] ?? "runtime"} omitted the published behavior marker`)
  }
  return result
}

const bunVersion = (await run(["bun", "--version"], packageRoot)).stdout
const nodeVersion = (await run(["node", "--version"], packageRoot)).stdout
await behavior(["bun", script], packageRoot)
await behavior(["node", "--experimental-strip-types", script], packageRoot)
let dockerMarker = false
try {
  const docker = await behavior(
    [
      "docker",
      "run",
      "--rm",
      "--name",
      containerName,
      "--label",
      "likego.suite=registry-zookeeper-runtime",
      "-v",
      `${repositoryRoot}:/workspace`,
      "-w",
      "/workspace/packages/registry/zookeeper",
      nodeLtsImage,
      "node",
      "--experimental-strip-types",
      "test/integration/published-behavior.ts"
    ],
    packageRoot
  )
  dockerMarker = docker.stdout.includes(marker)
} finally {
  Bun.spawnSync(["docker", "rm", "-f", containerName], {
    cwd: packageRoot,
    stdout: "ignore",
    stderr: "ignore"
  })
}
const remaining = Bun.spawnSync(["docker", "inspect", containerName], {
  cwd: packageRoot,
  stdout: "pipe",
  stderr: "pipe"
})
if (remaining.exitCode === 0 && remaining.stdout.toString().trim() !== "[]") {
  throw new Error("published runtime Docker lane left a test-owned container")
}
if (!dockerMarker) throw new Error("published runtime Docker lane did not complete")
console.log(
  `LIKEGO_REGISTRY_ZOOKEEPER_RUNTIME_RESULT=${JSON.stringify({
    valid: true,
    bunVersion,
    nodeVersion,
    nodeLtsImage,
    dockerMarker,
    remainingContainers: 0,
    deno: { supported: false, tested: false }
  })}`
)
