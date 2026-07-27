import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join, resolve } from "node:path"

const packageRoot = resolve(import.meta.dir, "../..")
const artifactRoot = join(packageRoot, ".artifacts")
const fixtures = join(packageRoot, "test/fixtures/tls")
const owner = `transport-http-security-${crypto.randomUUID()}`
const label = `io.likego.e2e.owner=${owner}`
const lanes = Object.freeze([
  Object.freeze({
    name: "node24-lts",
    image:
      "node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d",
    runtime: "Node.js 24.18.0"
  }),
  Object.freeze({
    name: "node26-current",
    image:
      "node:26.5.0-bookworm-slim@sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb",
    runtime: "Node.js 26.5.0"
  })
])

interface CommandResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** Runs one command and retains its complete terminal result. */
async function command(argv: readonly string[]): Promise<CommandResult> {
  const child = Bun.spawn(Array.from(argv), {
    cwd: packageRoot,
    stdout: "pipe",
    stderr: "pipe"
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ])
  return Object.freeze({ code, stdout: stdout.trim(), stderr: stderr.trim() })
}

/** Requires one successful Docker command. */
async function docker(...args: readonly string[]): Promise<CommandResult> {
  const result = await command(["docker", ...args])
  if (result.code !== 0) {
    throw new Error(`docker ${args[0] ?? "command"} failed: ${result.stderr}`)
  }
  return result
}

/** Returns every container still owned by this invocation. */
async function ownedContainers(): Promise<readonly string[]> {
  const result = await docker("ps", "--all", "--quiet", "--filter", `label=${label}`)
  return Object.freeze(result.stdout.length === 0 ? [] : result.stdout.split(/\s+/))
}

await mkdir(artifactRoot, { recursive: true })
const stage = await mkdtemp(join(artifactRoot, "node-security-"))
let primary: unknown = null

try {
  const build = await Bun.build({
    entrypoints: [join(packageRoot, "test/e2e/node-secure-e2e.ts")],
    outdir: stage,
    naming: "[name].mjs",
    format: "esm",
    target: "node"
  })
  if (!build.success) throw new Error(`Node security E2E build failed: ${build.logs.join("\n")}`)

  for (const lane of lanes) {
    const result = await docker(
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=16m",
      "--label",
      label,
      "--volume",
      `${stage}:/work:ro`,
      "--volume",
      `${fixtures}:/tls:ro`,
      "--env",
      "LIKEGO_TRANSPORT_HTTP_TLS_E2E_ROOT=file:///tls/",
      lane.image,
      "node",
      "/work/node-secure-e2e.mjs"
    )
    if (!result.stdout.includes(`"runtime":"${lane.runtime}"`)) {
      throw new Error(`${lane.name} did not report the expected runtime: ${result.stdout}`)
    }
    if (!result.stdout.includes("LIKEGO_NODE_HTTP_HOST_SECURE_E2E_V1=")) {
      throw new Error(`${lane.name} omitted the secure-host evidence marker`)
    }
    console.log(`${lane.name}: ${result.stdout}`)
  }
} catch (error) {
  primary = error
} finally {
  const residual = await ownedContainers().catch(() => Object.freeze([]))
  if (residual.length > 0) await command(["docker", "rm", "--force", ...residual])
  await rm(stage, { recursive: true, force: true })
}

if (primary !== null) throw primary
const remaining = await ownedContainers()
if (remaining.length !== 0) throw new Error(`Docker cleanup left ${remaining.length} containers`)

console.log(
  `LIKEGO_TRANSPORT_HTTP_NODE_SECURITY_DOCKER_V1=${JSON.stringify({
    valid: true,
    lanes: lanes.map((lane) => lane.name),
    secureHost: true,
    fixedDigests: true,
    containersRemaining: remaining.length
  })}`
)
