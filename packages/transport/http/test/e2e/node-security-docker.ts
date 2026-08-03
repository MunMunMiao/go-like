import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join, resolve } from "node:path"

const packageRoot = resolve(import.meta.dir, "../..")
const artifactRoot = join(packageRoot, ".artifacts")
const fixtures = join(packageRoot, "test/fixtures/tls")
const owner = process.env.LIKEGO_E2E_OWNER
if (owner === undefined || !/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(owner)) {
  throw new Error("invalid LIKEGO_E2E_OWNER")
}
const label = `io.likego.e2e.owner=${owner}`
const payloadVolume = `${owner}-payload`
const payloadContainer = `${owner}-stager`
const lanes = Object.freeze([
  Object.freeze({
    name: "node24-lts",
    image:
      "node:24.18.1-bookworm-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7",
    runtime: "Node.js 24.18.1"
  }),
  Object.freeze({
    name: "node26-current",
    image:
      "node:26.5.1-bookworm-slim@sha256:9e6f9357d371591e32ab6f2d8a26d63bdd0d17c29eee3f4f3e7e454d9634bf73",
    runtime: "Node.js 26.5.1"
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

/** Returns every volume still owned by this invocation. */
async function ownedVolumes(): Promise<readonly string[]> {
  const result = await docker("volume", "ls", "--quiet", "--filter", `label=${label}`)
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
  const stagingImage = lanes[0]?.image
  if (stagingImage === undefined) throw new Error("Node security E2E has no staging image")

  await docker("volume", "create", "--label", label, payloadVolume)
  await docker(
    "run",
    "--rm",
    "--network",
    "none",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--label",
    label,
    "--mount",
    `type=volume,src=${payloadVolume},dst=/payload`,
    stagingImage,
    "mkdir",
    "-p",
    "/payload/work",
    "/payload/tls"
  )
  await docker(
    "create",
    "--name",
    payloadContainer,
    "--network",
    "none",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--label",
    label,
    "--mount",
    `type=volume,src=${payloadVolume},dst=/payload`,
    stagingImage
  )
  await docker("cp", `${stage}/.`, `${payloadContainer}:/payload/work/`)
  await docker("cp", `${fixtures}/.`, `${payloadContainer}:/payload/tls/`)
  await docker("rm", "--force", payloadContainer)

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
      "--mount",
      `type=volume,src=${payloadVolume},dst=/payload,readonly`,
      "--env",
      "LIKEGO_TRANSPORT_HTTP_TLS_E2E_ROOT=file:///payload/tls/",
      lane.image,
      "node",
      "/payload/work/node-secure-e2e.mjs"
    )
    if (!result.stdout.includes(`"runtime":"${lane.runtime}"`)) {
      throw new Error(`${lane.name} did not report the expected runtime: ${result.stdout}`)
    }
    if (!result.stdout.includes("LIKEGO_NODE_HTTP_HOST_SECURE_E2E_V1=")) {
      throw new Error(`${lane.name} omitted the secure-host evidence marker`)
    }
  }
} catch (error) {
  primary = error
} finally {
  const residual = await ownedContainers().catch(() => Object.freeze([]))
  if (residual.length > 0) await command(["docker", "rm", "--force", ...residual])
  const volumes = await ownedVolumes().catch(() => Object.freeze([]))
  if (volumes.length > 0) await command(["docker", "volume", "rm", "--force", ...volumes])
  await rm(stage, { recursive: true, force: true })
}

if (primary !== null) throw primary
const remaining = await ownedContainers()
if (remaining.length !== 0) throw new Error(`Docker cleanup left ${remaining.length} containers`)
const remainingVolumes = await ownedVolumes()
if (remainingVolumes.length !== 0) {
  throw new Error(`Docker cleanup left ${remainingVolumes.length} volumes`)
}
