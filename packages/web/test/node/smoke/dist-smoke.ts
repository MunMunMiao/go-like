import { mkdir, symlink } from "node:fs/promises"
import { createServer } from "node:http"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const repoRoot = resolve(packageRoot, "../..")

/** Reports whether an unknown failure exposes a string error code. */
function hasErrorCode(value: unknown): value is { readonly code: string } {
  return (
    typeof value === "object" && value !== null && "code" in value && typeof value.code === "string"
  )
}

/** Ensures Node can resolve workspace dependencies in an isolated package mount. */
async function ensureWorkspaceLinks(): Promise<void> {
  const scope = resolve(packageRoot, "node_modules/@likego")
  await mkdir(scope, { recursive: true })
  for (const name of ["context", "core", "web"]) {
    const link = resolve(scope, name)
    const target = resolve(repoRoot, "packages", name)
    try {
      await symlink(target, link, "dir")
    } catch (error: unknown) {
      if (!hasErrorCode(error) || error.code !== "EEXIST") throw error
    }
  }
}

await ensureWorkspaceLinks()

const context = await import("@likego/context")
const api = await import("@likego/web/node")

const keys = Object.keys(api).sort()
if (
  JSON.stringify(keys) !==
  JSON.stringify(["hostname", "newNodeServer", "nodeShutdownTimeout", "port"])
) {
  throw new Error(`unexpected runtime exports: ${keys.join(",")}`)
}

const probe = createServer()
await new Promise<void>((resolveListen, rejectListen) => {
  probe.once("error", rejectListen)
  probe.listen(0, "127.0.0.1", resolveListen)
})
const probeAddress = probe.address()
if (probeAddress === null || typeof probeAddress === "string")
  throw new Error("smoke port probe did not bind TCP")
await new Promise<void>((resolveClose, rejectClose) => {
  probe.close((error) => {
    if (error === undefined) resolveClose()
    else rejectClose(error)
  })
})

const server = api.newNodeServer(
  () => new Response("ok"),
  api.port(probeAddress.port),
  api.nodeShutdownTimeout(0)
)
const running = server.start(context.background())
let response: Response | null = null
const deadline = Date.now() + 2_000
while (response === null && Date.now() < deadline) {
  try {
    response = await fetch(`http://127.0.0.1:${probeAddress.port}/smoke`)
  } catch {
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 5))
  }
}
if (response === null) throw new Error("smoke listener did not become ready")
if (response.status !== 200) throw new Error(`unexpected smoke status: ${response.status}`)
if ((await response.text()) !== "ok") throw new Error("unexpected smoke body")
await server.stop(context.background())
const terminal = await running.catch((error: unknown) => error)
if (
  terminal !== undefined &&
  (!hasErrorCode(terminal) || terminal.code !== "LIKEGO_NODE_SERVER_FORCE_CLOSE")
) {
  throw new Error("smoke server did not report its configured native force boundary")
}
console.log(`dist-smoke ok ${process.version}`)
