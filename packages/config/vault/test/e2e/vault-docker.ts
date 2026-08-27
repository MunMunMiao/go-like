import { background, withTimeout } from "@go-like/context"
import { waitForContext } from "@go-like/core/lifecycle"

import { vaultSource, type VaultFetch } from "../../src/index"

const Image =
  "hashicorp/vault:2.0.3@sha256:a296a888b118615dc01d5f1a6846e6d4a7277946caaed5b447008fff5fe06b54"
const Version = "2.0.3"
const Token = "go-like-integration-root"
const RunId = crypto.randomUUID()
const Name = `go-like-config-vault-${RunId}`
const Label = `go-like.config-vault.integration=${RunId}`
const DockerOwner = process.env.GO_LIKE_E2E_OWNER
if (DockerOwner === undefined || !/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(DockerOwner)) {
  throw new Error("invalid GO_LIKE_E2E_OWNER")
}
const DockerOwnerLabel = `io.go-like.e2e.owner=${DockerOwner}`

interface CommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

/** Runs one argv-safe Docker command and captures its complete result. */
async function command(args: readonly string[], allowFailure = false): Promise<CommandResult> {
  const argv = ["docker"]
  for (const argument of args) argv.push(argument)
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" })
  const stdoutPromise = new Response(child.stdout).text()
  const stderrPromise = new Response(child.stderr).text()
  const exitCode = await child.exited
  const stdout = (await stdoutPromise).trim()
  const stderr = (await stderrPromise).trim()
  if (exitCode !== 0 && !allowFailure) {
    throw new Error(`docker command failed (${exitCode}): ${stderr}`)
  }
  return Object.freeze({ stdout, stderr, exitCode })
}

/** Reserves and releases one operating-system-selected loopback port. */
function availablePort(): number {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      /** Ignores data during the port-reservation window. */
      data() {}
    }
  })
  const port = listener.port
  listener.stop(true)
  return port
}

/** Waits for one short readiness interval. */
function pause(timeoutMs: number): Promise<void> {
  return new Promise<void>(function wait(resolve) {
    setTimeout(resolve, timeoutMs)
  })
}

/** Waits until the real Vault dev server reports its exact pinned version. */
async function waitForVault(address: string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${address}/v1/sys/health`)
      if (response.ok) {
        const payload: unknown = await response.json()
        if (payload !== null && typeof payload === "object") {
          const descriptor = Object.getOwnPropertyDescriptor(payload, "version")
          if (descriptor !== undefined && "value" in descriptor && descriptor.value === Version) {
            return
          }
        }
      }
    } catch {
      // Connection refusal is expected while the fresh container starts.
    }
    await pause(100)
  }
  throw new Error("Vault container did not become ready within 30 seconds")
}

/** Writes one complete real KV v2 data object through Vault's HTTP API. */
async function writeSecret(address: string, release: number): Promise<number> {
  const response = await fetch(`${address}/v1/secret/data/applications/orders/config`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Vault-Token": Token
    },
    body: JSON.stringify({ data: { release, feature: { enabled: release > 1 } } })
  })
  if (!response.ok) {
    await response.arrayBuffer()
    throw new Error(`Vault KV v2 write failed with HTTP ${response.status}`)
  }
  const payload: unknown = await response.json()
  if (payload === null || typeof payload !== "object") {
    throw new Error("Vault KV v2 write omitted its version")
  }
  const data = Object.getOwnPropertyDescriptor(payload, "data")?.value
  if (data === null || typeof data !== "object") {
    throw new Error("Vault KV v2 write omitted its version")
  }
  const version = Object.getOwnPropertyDescriptor(data, "version")?.value
  if (!Number.isSafeInteger(version) || Number(version) < 1) {
    throw new Error("Vault KV v2 write returned an invalid version")
  }
  return Number(version)
}

/** Permanently removes one real KV v2 key's metadata and complete version history. */
async function deleteSecretMetadata(address: string): Promise<void> {
  const response = await fetch(`${address}/v1/secret/metadata/applications/orders/config`, {
    method: "DELETE",
    headers: { "X-Vault-Token": Token }
  })
  await response.arrayBuffer()
  if (!response.ok) {
    throw new Error(`Vault KV v2 metadata delete failed with HTTP ${response.status}`)
  }
}

/** Runs the isolated real-container KV v2 load, poll, change, and owner-drain scenario. */
async function main(): Promise<void> {
  const port = availablePort()
  const address = `http://127.0.0.1:${port}`
  let primary: unknown = null
  const cleanup: unknown[] = []
  const baseline = await command(["ps", "--all", "--quiet", "--filter", `label=${Label}`])
  if (baseline.stdout !== "") throw new Error("Vault integration label was not initially clean")
  try {
    await command([
      "run",
      "--detach",
      "--name",
      Name,
      "--label",
      Label,
      "--label",
      DockerOwnerLabel,
      "--tmpfs",
      "/vault/file:rw,noexec,nosuid,size=64m",
      "--env",
      `VAULT_DEV_ROOT_TOKEN_ID=${Token}`,
      "--publish",
      `127.0.0.1:${port}:8200`,
      Image,
      "server",
      "-dev",
      "-dev-listen-address=0.0.0.0:8200"
    ])
    await waitForVault(address)
    if ((await writeSecret(address, 1)) !== 1) {
      throw new Error("initial Vault KV v2 version was not one")
    }

    const requests: string[] = []
    const webFetch: VaultFetch = async function fetchVault(request) {
      requests.push(`${request.method} ${new URL(request.url).pathname}`)
      return fetch(request)
    }
    const source = vaultSource({
      fetch: webFetch,
      address,
      mount: "secret",
      path: "applications/orders/config",
      token: Token,
      pollIntervalMs: 10,
      retryInitialMs: 10,
      retryMaximumMs: 100
    })
    const rejectedSource = vaultSource({
      fetch: webFetch,
      address,
      mount: "secret",
      path: "applications/orders/config",
      token: "wrong-token"
    })
    let rejectedCode: string | null = null
    try {
      await rejectedSource.load(background())
    } catch (error) {
      if (error !== null && typeof error === "object" && "code" in error) {
        const code = error.code
        if (typeof code === "string") rejectedCode = code
      }
    }
    if (rejectedCode !== "GO_LIKE_VAULT_HTTP") {
      throw new Error("invalid Vault token did not fail through the HTTP boundary")
    }
    const first = await source.load(background())
    if (first.revision === null || first.value.release !== 1) {
      throw new Error("initial real Vault KV v2 snapshot was incorrect")
    }
    if (source.watch === undefined) throw new Error("Vault source watch capability is missing")
    const watch = await source.watch(background(), first.revision)
    const [nextContext, cancelNext] = withTimeout(background(), 10_000)
    try {
      const next = watch.next(nextContext)
      await deleteSecretMetadata(address)
      if ((await writeSecret(address, 2)) !== 1) {
        throw new Error("recreated Vault KV v2 metadata did not reset to version one")
      }
      await waitForContext(nextContext, next)
    } finally {
      cancelNext()
    }
    const recreated = await source.load(background())
    if (
      recreated.revision === null ||
      recreated.revision === first.revision ||
      recreated.value.release !== 2
    ) {
      throw new Error("same-version recreated Vault KV v2 snapshot was not detected")
    }
    await watch.stop(background())

    const ordinaryWatch = await source.watch(background(), recreated.revision)
    const [ordinaryContext, cancelOrdinary] = withTimeout(background(), 10_000)
    try {
      const next = ordinaryWatch.next(ordinaryContext)
      if ((await writeSecret(address, 3)) !== 2) {
        throw new Error("ordinary Vault KV v2 update did not advance to version two")
      }
      await waitForContext(ordinaryContext, next)
    } finally {
      cancelOrdinary()
    }
    const second = await source.load(background())
    if (
      second.revision === null ||
      second.revision === recreated.revision ||
      second.value.release !== 3
    ) {
      throw new Error("ordinary updated real Vault KV v2 snapshot was incorrect")
    }
    await ordinaryWatch.stop(background())
  } catch (error) {
    primary = error
  } finally {
    const removed = await command(["rm", "--force", "--volumes", Name], true)
    if (removed.exitCode !== 0 && !removed.stderr.includes("No such container")) {
      cleanup.push(new Error(`Vault container cleanup failed: ${removed.stderr}`))
    }
    const residual = await command(["ps", "--all", "--quiet", "--filter", `label=${Label}`], true)
    if (residual.exitCode !== 0 || residual.stdout !== "") {
      cleanup.push(new Error("Vault integration left a residual labeled container"))
    }
  }
  if (primary !== null && cleanup.length > 0) {
    const failures: unknown[] = [primary]
    for (const failure of cleanup) failures.push(failure)
    throw new AggregateError(failures, "Vault integration and cleanup failed")
  }
  if (primary !== null) throw primary
  if (cleanup.length > 0) throw new AggregateError(cleanup, "Vault integration cleanup failed")
}

await main()
