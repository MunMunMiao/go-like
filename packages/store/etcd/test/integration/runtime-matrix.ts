import { cp, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const Root = resolve(import.meta.dir, "../../../../..")
const NodeLtsImage = "node@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d"
const Expected = '{"name":"etcd","records":0,"cursor":null,"calls":1,"paths":["/v3/kv/range"]}'
const PackageLocations = Object.freeze({
  context: "packages/context",
  core: "packages/core",
  store: "packages/store",
  "store-etcd": "packages/store/etcd"
})
const Smoke = `
import { background } from "@likego/context"
import { newEtcdStore } from "@likego/store-etcd"

let calls = 0
const paths = []
const store = newEtcdStore({
  address: "http://etcd.internal:2379",
  async fetch(request) {
    if (!(request instanceof Request)) throw new Error("Store did not use standard Request")
    if (request.method !== "POST") throw new Error("Store did not use POST")
    if (request.redirect !== "error") throw new Error("Store redirect policy is not strict")
    if (request.headers.get("content-type") !== "application/json") {
      throw new Error("Store did not use the JSON gateway content type")
    }
    await request.json()
    calls += 1
    paths.push(new URL(request.url).pathname)
    return new Response('{"header":{"revision":"1"}}', {
      headers: { "content-type": "application/json" }
    })
  }
})

const page = await store.list(background())

console.log(JSON.stringify({
  name: store.string(),
  records: page.records.length,
  cursor: page.cursor,
  calls,
  paths
}))
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
  const target = join(stage, "node_modules", "@likego", name)
  await mkdir(target, { recursive: true })
  await cp(join(Root, location, "dist"), target, { recursive: true })
}

/** Validates and records one runtime's package-name-only smoke output. */
function evidence(runtime: string, version: string, output: string): CommandEvidence {
  if (output !== Expected) throw new Error(`${runtime} produced unexpected output: ${output}`)
  return Object.freeze({ runtime, version, output })
}

/** Builds one isolated package stage and executes every declared portable runtime lane. */
async function main(): Promise<void> {
  const stage = await mkdtemp(join(tmpdir(), "likego-store-etcd-runtime-"))
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
