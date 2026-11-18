/**
 * D29 release gate.
 * A real etcd with authentication enabled accepts the raw token on config, registry, and store,
 * and rejects a wrong token with GO_LIKE_ETCD_HTTP.
 */
import { spawn } from "node:child_process"
import { background } from "@go-like/core/context"
import type { ServiceInstance } from "@go-like/core/registry"
import { etcdSource } from "@go-like/etcd/config"
import { newEtcdRegistry } from "@go-like/etcd/registry"
import { newEtcdStore } from "@go-like/etcd/store"
import { newEtcdClient } from "@go-like/etcd"

const Image =
  "gcr.io/etcd-development/etcd:v3.7.1@sha256:a9983dd6d9283138ab926daa307c6c25623636703ecf5645d5df4d666ce9eba2"
const EtcdVersion = "3.7.1"
const Name = `go-like-release-etcd-auth-${process.pid}-${Date.now()}`
const Password = "release-auth-secret"
const WrongToken = "invalid-release-token"
const DockerOwner = process.env.GO_LIKE_E2E_OWNER
if (DockerOwner === undefined || !/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(DockerOwner)) {
  throw new Error("invalid GO_LIKE_E2E_OWNER")
}
const DockerOwnerLabel = `io.go-like.e2e.owner=${DockerOwner}`
const bypass = [process.env.NO_PROXY, process.env.no_proxy, "127.0.0.1", "localhost", "::1"]
  .filter((value): value is string => value !== undefined && value.length > 0)
  .join(",")
process.env.NO_PROXY = bypass
process.env.no_proxy = bypass

interface CommandResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

interface HttpErrorShape {
  readonly code: string
  readonly status: number
  readonly operation: string
}

/** Runs one direct subprocess with stdin closed. */
function command(argv: readonly string[]): Promise<CommandResult> {
  const [file, ...args] = argv
  if (file === undefined) return Promise.reject(new Error("empty command"))
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk)
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk)
    })
    child.on("error", reject)
    child.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      })
    })
  })
}

/** Runs one required command and returns trimmed standard output. */
async function required(argv: readonly string[]): Promise<string> {
  const result = await command(argv)
  if (result.exitCode !== 0) {
    throw new Error(`command failed (${argv[0]}): ${result.stderr.trim()}`)
  }
  return result.stdout.trim()
}

/** Waits one short integration-test interval. */
function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, timeoutMs)
  })
}

/** Encodes UTF-8 the way the etcd JSON gateway encodes bytes. */
function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** Posts one gateway request and returns the status and body. */
async function post(
  address: string,
  path: string,
  body: unknown,
  token?: string
): Promise<{ readonly status: number; readonly text: string }> {
  const headers = new Headers({ "content-type": "application/json" })
  if (token !== undefined) headers.set("authorization", token)
  const response = await fetch(`${address}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  })
  return { status: response.status, text: await response.text() }
}

/** Requires one gateway call to succeed and returns its body. */
async function requiredPost(
  address: string,
  path: string,
  body: unknown,
  token?: string
): Promise<string> {
  const result = await post(address, path, body, token)
  if (result.status !== 200) {
    throw new Error(`etcd ${path} failed with HTTP ${result.status}: ${result.text.slice(0, 400)}`)
  }
  return result.text
}

/** Reads one own data property without invoking accessors. */
function property(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined
  return Object.getOwnPropertyDescriptor(value, key)?.value
}

/** Reads the authenticate token without logging it. */
function tokenFrom(text: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    throw new Error("etcd authenticate response was not JSON")
  }
  const token = property(parsed, "token")
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("etcd authenticate response has no token")
  }
  return token
}

/** Waits until the fixed-digest container exposes a healthy JSON gateway. */
async function waitHealthy(address: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${address}/health`)
      if (response.ok && (await response.text()).includes('"health":"true"')) return
    } catch {
      // The listener refuses connections during its short startup window.
    }
    await delay(100)
  }
  throw new Error("etcd auth container did not become healthy")
}

/** Parses the exact etcd binary version reported inside the running container. */
function etcdVersion(output: string): string {
  const line = output.split("\n").find((value) => value.startsWith("etcd Version: "))
  const version = line?.slice("etcd Version: ".length).trim()
  if (version === undefined || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("etcd auth container did not report a semantic version")
  }
  return version
}

/** Narrows a plug rejection to the documented HTTP error. */
function httpError(value: unknown): HttpErrorShape | null {
  if (typeof value !== "object" || value === null) return null
  if (!("code" in value) || !("status" in value) || !("operation" in value)) return null
  const { code, status, operation } = value
  if (typeof code !== "string" || typeof status !== "number" || typeof operation !== "string") {
    return null
  }
  return { code, status, operation }
}

/** Requires one socket call to fail with GO_LIKE_ETCD_HTTP and HTTP 401. */
async function expectUnauthorized(socket: string, operation: Promise<unknown>): Promise<void> {
  try {
    await operation
  } catch (error) {
    const parsed = httpError(error)
    if (parsed === null || parsed.code !== "GO_LIKE_ETCD_HTTP" || parsed.status !== 401) {
      const observed = parsed === null ? "non-http" : `${parsed.code} status ${parsed.status}`
      throw new Error(`${socket} wrong credentials failed with ${observed}`, { cause: error })
    }
    if (!parsed.operation.startsWith(`${socket}.`)) {
      throw new Error(`${socket} wrong credentials reported operation ${parsed.operation}`)
    }
    return
  }
  throw new Error(`${socket} accepted invalid credentials`)
}

/** Builds one client. The token is sent unchanged as Authorization. */
function client(address: string, token: string) {
  return newEtcdClient({
    fetch(request) {
      return fetch(request)
    },
    address,
    token
  })
}

/** Enables auth and returns the raw token from /v3/auth/authenticate. */
async function enableAuth(address: string): Promise<string> {
  const password = encodeBase64(Password)
  await requiredPost(address, "/v3/auth/user/add", { name: "root", password })
  await requiredPost(address, "/v3/auth/user/grant", { user: "root", role: "root" })
  await requiredPost(address, "/v3/auth/enable", {})
  return tokenFrom(await requiredPost(address, "/v3/auth/authenticate", { name: "root", password }))
}

let started = false
let primary: { readonly value: unknown } | null = null
try {
  await required([
    "docker",
    "run",
    "-d",
    "--name",
    Name,
    "--label",
    DockerOwnerLabel,
    "-p",
    "127.0.0.1::2379",
    Image,
    "/usr/local/bin/etcd",
    "--name",
    "release-etcd",
    "--data-dir",
    "/etcd-data",
    "--listen-client-urls",
    "http://0.0.0.0:2379",
    "--advertise-client-urls",
    "http://0.0.0.0:2379",
    "--listen-peer-urls",
    "http://0.0.0.0:2380",
    "--initial-advertise-peer-urls",
    "http://0.0.0.0:2380",
    "--initial-cluster",
    "release-etcd=http://0.0.0.0:2380"
  ])
  started = true
  const binding = await required(["docker", "port", Name, "2379/tcp"])
  const port = binding.slice(binding.lastIndexOf(":") + 1)
  if (!/^[0-9]+$/.test(port)) throw new Error("Docker returned an invalid etcd host port")
  const address = `http://127.0.0.1:${port}`
  await waitHealthy(address)
  const observedVersion = etcdVersion(
    await required(["docker", "exec", Name, "/usr/local/bin/etcd", "--version"])
  )
  if (observedVersion !== EtcdVersion) {
    throw new Error(`expected etcd ${EtcdVersion}, received ${observedVersion}`)
  }

  const token = await enableAuth(address)
  const configKey = "release/auth-config"
  await requiredPost(
    address,
    "/v3/kv/put",
    {
      key: encodeBase64(configKey),
      value: encodeBase64(JSON.stringify({ ok: true }))
    },
    token
  )
  const authenticated = client(address, token)
  const loaded = await etcdSource(authenticated, {
    key: configKey,
    retryInitialMs: 10,
    retryMaximumMs: 50
  }).load(background())
  if (loaded.value.ok !== true) throw new Error("authenticated config load did not return ok")

  const storeKey = "release/auth-store"
  const store = newEtcdStore(authenticated)
  const written = await store.write(background(), {
    key: storeKey,
    value: new TextEncoder().encode("stored")
  })
  const record = await store.read(background(), storeKey)
  if (record === null || new TextDecoder().decode(record.value) !== "stored") {
    throw new Error("authenticated store read did not return the written value")
  }
  if (record.revision !== written.revision) {
    throw new Error("authenticated store read revision differed from the write")
  }

  const instance: ServiceInstance = {
    id: "release-auth-1",
    name: "release-auth",
    version: "v1",
    metadata: {},
    endpoints: ["http://127.0.0.1:9/"]
  }
  const registry = newEtcdRegistry(authenticated, { ttlMs: 2_000 })
  let registered = false
  try {
    await registry.register(background(), instance)
    registered = true
    const found = await registry.getService(background(), instance.name)
    if (!found.some((item) => item.id === instance.id)) {
      throw new Error("authenticated registry getService omitted the registered instance")
    }
  } finally {
    if (registered) await registry.deregister(background(), instance)
  }

  const rejected = client(address, WrongToken)
  await expectUnauthorized(
    "config",
    etcdSource(rejected, { key: configKey, retryInitialMs: 10, retryMaximumMs: 50 }).load(
      background()
    )
  )
  await expectUnauthorized("store", newEtcdStore(rejected).read(background(), storeKey))
  await expectUnauthorized(
    "registry",
    newEtcdRegistry(rejected, { ttlMs: 2_000 }).getService(background(), instance.name)
  )
  console.log(
    "auth_form=raw-token sockets=config,registry,store ok=true wrong_code=GO_LIKE_ETCD_HTTP wrong_status=401"
  )
} catch (value) {
  primary = Object.freeze({ value })
}

const cleanupFailures: unknown[] = []
if (started) {
  const removal = await command(["docker", "rm", "-f", Name])
  if (removal.exitCode !== 0) {
    cleanupFailures.push(new Error(`etcd auth cleanup failed: ${removal.stderr.trim()}`))
  }
}
const residual = await command([
  "docker",
  "ps",
  "--all",
  "--filter",
  `name=^/${Name}$`,
  "--format",
  "{{.Names}}"
])
if (residual.exitCode !== 0) {
  cleanupFailures.push(new Error(`etcd auth cleanup query failed: ${residual.stderr.trim()}`))
} else if (residual.stdout.trim() !== "") {
  cleanupFailures.push(new Error("etcd auth container cleanup failed"))
}
if (primary !== null || cleanupFailures.length > 0) {
  const failures = primary === null ? cleanupFailures : [primary.value, ...cleanupFailures]
  if (failures.length === 1) throw failures[0]
  throw new AggregateError(failures, "etcd auth integration and cleanup failed")
}
