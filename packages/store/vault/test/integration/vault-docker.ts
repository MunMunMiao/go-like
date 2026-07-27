import { background } from "@likego/context"
import { cursor, expiresIn, ifRevision, limit } from "@likego/store"

import { physicalKey } from "../../src/codec"
import { newVaultStore, type VaultFetch, type VaultStore } from "../../src/index"

const Image =
  "hashicorp/vault:2.0.3@sha256:a296a888b118615dc01d5f1a6846e6d4a7277946caaed5b447008fff5fe06b54"
const RunId = crypto.randomUUID()
const Name = `likego-store-vault-${RunId}`
const Label = `likego.store-vault.integration=${RunId}`
const DockerOwner = process.env.LIKEGO_E2E_OWNER
if (DockerOwner === undefined || !/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(DockerOwner)) {
  throw new Error("invalid LIKEGO_E2E_OWNER")
}
const DockerOwnerLabel = `io.likego.e2e.owner=${DockerOwner}`
const Token = `likego-vault-token-${RunId}`
const WrongToken = `wrong-${RunId}`
const Root = `likego/store-vault/${RunId}/primary`
const IsolatedRoot = `likego/store-vault/${RunId}/isolated`
const ResultMarker = "LIKEGO_STORE_VAULT_E2E_RESULT"

interface CommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

/** Runs one argv-safe Docker command and redacts both test tokens. */
async function docker(args: readonly string[], allowFailure = false): Promise<CommandResult> {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" })
  const stdoutPromise = new Response(child.stdout).text()
  const stderrPromise = new Response(child.stderr).text()
  const exitCode = await child.exited
  const redact = function redact(value: string): string {
    return value.replaceAll(Token, "<redacted>").replaceAll(WrongToken, "<redacted>")
  }
  const stdout = redact((await stdoutPromise).trim())
  const stderr = redact((await stderrPromise).trim())
  if (exitCode !== 0 && !allowFailure) {
    throw new Error(`docker ${args.map(redact).join(" ")} failed (${exitCode}): ${stderr}`)
  }
  return Object.freeze({ stdout, stderr, exitCode })
}

/** Waits one bounded readiness polling interval. */
function pause(timeoutMs: number): Promise<void> {
  return new Promise<void>(function wait(resolve): void {
    setTimeout(resolve, timeoutMs)
  })
}

/** Starts one isolated Vault 2.0.3 dev server on an OS-selected loopback port. */
async function startVault(): Promise<string> {
  await docker([
    "run",
    "--detach",
    "--name",
    Name,
    "--label",
    Label,
    "--label",
    DockerOwnerLabel,
    "--cap-add",
    "IPC_LOCK",
    "--tmpfs",
    "/vault/file:rw,noexec,nosuid,size=64m",
    "--publish",
    "127.0.0.1::8200",
    "--env",
    `VAULT_DEV_ROOT_TOKEN_ID=${Token}`,
    "--env",
    "VAULT_DEV_LISTEN_ADDRESS=0.0.0.0:8200",
    Image,
    "server",
    "-dev"
  ])
  const port = await docker(["port", Name, "8200/tcp"])
  const match = /:([0-9]+)$/u.exec(port.stdout.split("\n")[0] ?? "")
  if (match?.[1] === undefined) throw new Error(`invalid Vault port mapping: ${port.stdout}`)
  return `http://127.0.0.1:${match[1]}`
}

/** Waits until the real Vault health endpoint returns initialized state. */
async function ready(address: string): Promise<void> {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${address}/v1/sys/health`)
      if (response.ok) return
      await response.arrayBuffer()
    } catch {
      // Connection refusal is expected while the container starts.
    }
    await pause(100)
  }
  throw new Error("Vault container did not become ready within 45 seconds")
}

/** Sends one token-scoped raw Vault request for isolation and cleanup evidence. */
function raw(
  address: string,
  path: string,
  method = "GET",
  body: string | null = null,
  token = Token
): Promise<Response> {
  const headers = new Headers({ "X-Vault-Token": token })
  if (body !== null) headers.set("Content-Type", "application/json")
  return fetch(new Request(new URL(path, address), { method, headers, body, redirect: "error" }))
}

/** Creates one immediate Store and records every standard Request at the capability boundary. */
function createStore(
  address: string,
  root: string,
  requests: Request[],
  token = Token
): VaultStore {
  const borrowed: VaultFetch = async function fetchVault(request): Promise<Response> {
    requests.push(request.clone())
    return fetch(request)
  }
  return newVaultStore({ fetch: borrowed, address, mount: "secret", root, token })
}

/** Deletes all metadata for one exact test root and its known logical keys. */
async function cleanupRoot(address: string, root: string, keys: readonly string[]): Promise<void> {
  for (const key of keys) {
    const response = await raw(address, `/v1/secret/metadata/${root}/${physicalKey(key)}`, "DELETE")
    if (!response.ok && response.status !== 404) {
      throw new Error(`Vault metadata cleanup failed with ${response.status}`)
    }
    await response.arrayBuffer()
  }
}

/** Runs the complete real Vault KV v2 evidence scenario. */
async function main(): Promise<void> {
  const baseline = await docker(["ps", "--all", "--quiet", "--filter", `label=${Label}`])
  if (baseline.stdout !== "") throw new Error("Vault integration label was not clean")
  let address = ""
  let primary: Error | null = null
  const cleanupFailures: Error[] = []
  const primaryKeys = ["orders/a", "orders/z", "orders/new", "race"]
  const isolatedKeys = ["orders/a"]
  const requests: Request[] = []
  const evidence: Record<string, unknown> = {}
  try {
    address = await startVault()
    await ready(address)
    const version = await docker(["exec", Name, "vault", "version"])
    if (!version.stdout.includes("Vault v2.0.3")) {
      throw new Error(`unexpected Vault binary: ${version.stdout}`)
    }

    const wrong = newVaultStore({
      fetch: function wrongFetch(request): Promise<Response> {
        return fetch(request)
      },
      address,
      mount: "secret",
      root: Root,
      token: WrongToken
    })
    let wrongCode: unknown = null
    try {
      await wrong.list(background())
    } catch (value) {
      wrongCode = typeof value === "object" && value !== null && "code" in value ? value.code : null
    }
    if (wrongCode !== "LIKEGO_VAULT_STORE_HTTP") throw new Error("wrong token was not denied")

    const primaryStore = createStore(address, Root, requests)
    const isolatedStore = createStore(address, IsolatedRoot, requests)

    await primaryStore.write(background(), { key: "orders/z", value: Uint8Array.of(2) })
    await primaryStore.write(background(), { key: "orders/a", value: Uint8Array.of(1) })
    const first = await primaryStore.list(background(), limit(1))
    if (first.records[0]?.key !== "orders/a" || first.cursor === null) {
      throw new Error("Vault first stable page was invalid")
    }
    await primaryStore.write(background(), { key: "orders/new", value: Uint8Array.of(3) })
    const beforeContinuation = requests.length
    const second = await primaryStore.list(background(), cursor(first.cursor))
    if (
      second.records.length !== 1 ||
      second.records[0]?.key !== "orders/z" ||
      second.cursor !== null ||
      requests.length !== beforeContinuation
    ) {
      throw new Error("Vault cursor did not retain the process-local page snapshot")
    }
    if ((await isolatedStore.read(background(), "orders/a")) !== null) {
      throw new Error("Vault root isolation leaked a primary record")
    }

    const noIoBaseline = requests.length
    try {
      await primaryStore.write(background(), { key: "ttl", value: Uint8Array.of(1) }, expiresIn(1))
      throw new Error("Vault TTL unexpectedly succeeded")
    } catch (value) {
      if (!(value instanceof TypeError)) throw value
    }
    try {
      await primaryStore.write(
        background(),
        { key: "cas", value: Uint8Array.of(1) },
        ifRevision("1")
      )
      throw new Error("Vault CAS unexpectedly succeeded")
    } catch (value) {
      if (!(value instanceof TypeError)) throw value
    }
    if (requests.length !== noIoBaseline) throw new Error("unsupported options performed Vault I/O")

    await primaryStore.write(background(), { key: "race", value: Uint8Array.of(1) })
    let injectConcurrent = true
    const concurrentFetch: VaultFetch = async function fetchConcurrent(request): Promise<Response> {
      if (injectConcurrent && request.method === "POST" && request.url.includes("/delete/")) {
        injectConcurrent = false
        await primaryStore.write(background(), { key: "race", value: Uint8Array.of(9) })
      }
      return fetch(request)
    }
    const concurrentStore = newVaultStore({
      fetch: concurrentFetch,
      address,
      mount: "secret",
      root: Root,
      token: Token
    })
    if (!(await concurrentStore.delete(background(), "race"))) {
      throw new Error("Vault exact-version delete did not remove the observed version")
    }
    const surviving = await primaryStore.read(background(), "race")
    if (surviving?.revision !== "2" || surviving.value[0] !== 9) {
      throw new Error("Vault exact-version delete removed a concurrent write")
    }

    evidence.binaryVersion = version.stdout.split("\n")[0]
    evidence.wrongTokenDenied = true
    evidence.rootIsolation = true
    evidence.crud = true
    evidence.stablePagination = true
    evidence.ttlCasFailClosed = true
    evidence.exactVersionDeletePreservedConcurrentWrite = true
    evidence.tokenOnlyInHeader = requests.every(
      (request) => !request.url.includes(Token) && request.headers.get("X-Vault-Token") === Token
    )
    if (evidence.tokenOnlyInHeader !== true) throw new Error("Vault token boundary failed")
  } catch (value) {
    primary = value instanceof Error ? value : new Error("Vault Docker scenario failed")
  } finally {
    if (address !== "") {
      try {
        await cleanupRoot(address, Root, primaryKeys)
        await cleanupRoot(address, IsolatedRoot, isolatedKeys)
        for (const root of [Root, IsolatedRoot]) {
          const response = await raw(address, `/v1/secret/metadata/${root}?list=true`)
          await response.arrayBuffer()
          if (response.status !== 404) throw new Error(`Vault root residue remained: ${root}`)
        }
      } catch (value) {
        cleanupFailures.push(value instanceof Error ? value : new Error("Vault cleanup failed"))
      }
    }
    try {
      await docker(["rm", "--force", "--volumes", Name], true)
      const residual = await docker(["ps", "--all", "--quiet", "--filter", `label=${Label}`])
      if (residual.stdout !== "") throw new Error("Vault integration container residue remained")
    } catch (value) {
      cleanupFailures.push(value instanceof Error ? value : new Error("container cleanup failed"))
    }
  }
  if (primary !== null && cleanupFailures.length !== 0) {
    const failures: Error[] = [primary]
    for (const failure of cleanupFailures) failures.push(failure)
    throw new AggregateError(failures, "Vault scenario and cleanup failed")
  }
  if (primary !== null) throw primary
  if (cleanupFailures.length === 1 && cleanupFailures[0] !== undefined) throw cleanupFailures[0]
  if (cleanupFailures.length > 1) {
    throw new AggregateError(cleanupFailures, "Vault cleanup failed")
  }
  console.log(
    `${ResultMarker}=${JSON.stringify({
      schemaVersion: 1,
      valid: true,
      package: "@likego/store-vault",
      image: Image,
      scenarios: [
        "wrong-token",
        "root-isolation",
        "crud-stable-pagination",
        "ttl-cas-fail-closed",
        "exact-version-delete-concurrent-write",
        "zero-residue"
      ],
      evidence,
      cleanup: { remoteRoots: 0, containers: 0 }
    })}`
  )
}

await main()
