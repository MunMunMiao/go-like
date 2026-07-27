import { cp, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const Root = resolve(import.meta.dir, "../../../../..")
const NodeLtsImage = "node@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d"
const Expected = '{"env":{"http":{"port":"8080"}},"file":{"enabled":true},"consul":{"release":2}}'
const PackageLocations = Object.freeze({
  context: "packages/context",
  core: "packages/core",
  config: "packages/config",
  "config-consul": "packages/config/consul"
})
const Smoke = `
import { background } from "@likego/context"
import { envSource } from "@likego/config/env"
import { fileSource } from "@likego/config/file"
import { consulSource } from "@likego/config-consul"

const ctx = background()
const env = await envSource({ APP_HTTP__PORT: "8080" }, { prefix: "APP_" }).load(ctx)
const file = await fileSource({
  async read() { return { text: '{"enabled":true}', revision: "1" } }
}, "config.json").load(ctx)
const consul = await consulSource({
  async fetch(request) {
    if (request.redirect !== "error") throw new Error("Consul redirect policy is missing")
    return new Response('{"release":2}', { headers: { "X-Consul-Index": "2" } })
  },
  address: "http://consul",
  key: "app/config"
}).load(ctx)

console.log(JSON.stringify({ env: env.value, file: file.value, consul: consul.value }))
`

interface CommandEvidence {
  readonly runtime: string
  readonly version: string
  readonly output: string
}

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
  const source = join(Root, location)
  const target = join(stage, "node_modules", "@likego", name)
  await mkdir(target, { recursive: true })
  await copyFile(join(source, "package.json"), join(target, "package.json"))
  await cp(join(source, "dist"), join(target, "dist"), { recursive: true })
}

/** Validates and records one runtime's package-name-only smoke output. */
function evidence(runtime: string, version: string, output: string): CommandEvidence {
  if (output !== Expected) throw new Error(`${runtime} produced unexpected output: ${output}`)
  return Object.freeze({ runtime, version, output })
}

/** Builds one isolated package stage and executes every declared portable runtime lane. */
async function main(): Promise<void> {
  const stage = await mkdtemp(join(tmpdir(), "likego-config-runtime-"))
  const runtimes: CommandEvidence[] = []
  try {
    for (const [name, location] of Object.entries(PackageLocations)) {
      await stagePackage(stage, name, location)
    }

    const bunVersion = await command(["bun", "--version"], stage)
    runtimes.push(evidence("bun", bunVersion, await command(["bun", "--eval", Smoke], stage)))

    const nodeVersion = await command(["node", "--version"], stage)
    runtimes.push(
      evidence(
        "node-current",
        nodeVersion,
        await command(["node", "--input-type=module", "--eval", Smoke], stage)
      )
    )

    const denoVersion = (await command(["deno", "--version"], stage)).split("\n")[0] ?? "missing"
    runtimes.push(
      evidence(
        "deno",
        denoVersion,
        await command(["deno", "eval", "--node-modules-dir=manual", Smoke], stage)
      )
    )

    const mount = `type=bind,src=${stage},dst=/work,readonly`
    const nodeLtsVersion = await command(
      [
        "docker",
        "run",
        "--rm",
        "--mount",
        mount,
        "--workdir",
        "/work",
        NodeLtsImage,
        "node",
        "--version"
      ],
      Root
    )
    const nodeLtsOutput = await command(
      [
        "docker",
        "run",
        "--rm",
        "--mount",
        mount,
        "--workdir",
        "/work",
        NodeLtsImage,
        "node",
        "--input-type=module",
        "--eval",
        Smoke
      ],
      Root
    )
    runtimes.push(evidence("node-lts", `${nodeLtsVersion} ${NodeLtsImage}`, nodeLtsOutput))
  } finally {
    await rm(stage, { recursive: true })
  }

  console.log(JSON.stringify({ ok: true, runtimes, temporaryStageCleaned: true }))
}

await main()
