import { background } from "@likego/context"
import { type ServiceInstance } from "@likego/registry"
import { createServer } from "node:net"

import { newEtcdRegistry, type EtcdFetch } from "../../src/index"

const Image =
  "gcr.io/etcd-development/etcd:v3.7.1@sha256:a9983dd6d9283138ab926daa307c6c25623636703ecf5645d5df4d666ce9eba2"
const DockerOwner = process.env.LIKEGO_E2E_OWNER
if (DockerOwner === undefined || !/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(DockerOwner)) {
  throw new Error("invalid LIKEGO_E2E_OWNER")
}
const DockerOwnerLabel = `io.likego.e2e.owner=${DockerOwner}`

/** Creates one deterministic real-backend ServiceInstance revision. */
function fixture(endpoint = "http://127.0.0.1:8080/"): ServiceInstance {
  return {
    id: "orders-1",
    name: "docker-orders",
    version: "v1",
    metadata: { region: "east" },
    endpoints: [endpoint]
  }
}

/** Fails this integration gate unless one condition is true. */
function ensure(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/** Runs one Docker command to completion and returns trimmed stdout. */
async function docker(...args: readonly string[]): Promise<string> {
  const process = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited
  ])
  if (code !== 0) throw new Error(`docker ${args[0] ?? "command"} failed: ${stderr.trim()}`)
  return stdout.trim()
}

/** Reserves and releases one currently unused loopback TCP port. */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(
    /** Waits until the kernel assigns one ephemeral port. */
    function listen(resolve, reject): void {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", resolve)
    }
  )
  const address = server.address()
  if (typeof address !== "object" || address === null) throw new Error("free port is unavailable")
  const port = address.port
  await new Promise<void>(
    /** Releases the temporary reservation before Docker binds it. */
    function close(resolve, reject): void {
      server.close(function closed(error): void {
        if (error === undefined) resolve()
        else reject(error)
      })
    }
  )
  return port
}

/** Waits until one real asynchronous condition converges. */
async function eventually(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  message: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await Bun.sleep(50)
  }
  throw new Error(message)
}

/** Runs the publisher process that the parent deliberately kills. */
async function publisherChild(): Promise<never> {
  const address = process.env.LIKEGO_ETCD_ADDRESS
  if (address === undefined) throw new Error("publisher child address is missing")
  const registry = newEtcdRegistry({
    fetch,
    address,
    retryInitialMs: 50,
    retryMaximumMs: 200,
    ttlMs: 2_000
  })
  await registry.register(background(), fixture())
  console.log("LIKEGO_ETCD_CHILD_READY")
  return await new Promise<never>(
    /** Keeps the publisher alive until the parent sends SIGKILL. */
    function resident(): void {}
  )
}

/** Waits for the child publisher readiness line. */
async function waitForChild(child: ReturnType<typeof Bun.spawn>): Promise<void> {
  if (!(child.stdout instanceof ReadableStream)) throw new Error("publisher stdout is unavailable")
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  let text = ""
  while (!text.includes("LIKEGO_ETCD_CHILD_READY")) {
    const chunk = await reader.read()
    if (chunk.done) {
      const code = await child.exited
      throw new Error(`publisher exited ${code} before readiness`)
    }
    text += decoder.decode(chunk.value, { stream: true })
  }
  reader.releaseLock()
}

/** Runs all real etcd lifecycle evidence and always removes its container. */
async function main(): Promise<void> {
  const name = `likego-etcd-${crypto.randomUUID()}`
  const port = await freePort()
  let child: ReturnType<typeof Bun.spawn> | null = null
  try {
    await docker(
      "run",
      "-d",
      "--name",
      name,
      "--label",
      DockerOwnerLabel,
      "-p",
      `127.0.0.1:${port}:2379`,
      Image,
      "/usr/local/bin/etcd",
      "--name=likego",
      "--data-dir=/etcd-data",
      "--listen-client-urls=http://0.0.0.0:2379",
      "--advertise-client-urls=http://0.0.0.0:2379",
      "--listen-peer-urls=http://0.0.0.0:2380",
      "--initial-advertise-peer-urls=http://0.0.0.0:2380",
      "--initial-cluster=likego=http://0.0.0.0:2380"
    )
    const address = `http://127.0.0.1:${port}`
    await eventually(
      async function healthy(): Promise<boolean> {
        try {
          return (await fetch(`${address}/health`)).ok
        } catch {
          return false
        }
      },
      15_000,
      "real etcd did not become healthy"
    )

    const registry = newEtcdRegistry({
      fetch,
      address,
      retryInitialMs: 50,
      retryMaximumMs: 200,
      ttlMs: 2_000
    })
    const watcher = await registry.watch(background(), "docker-orders")
    await registry.register(background(), fixture())
    ensure(
      JSON.stringify(await watcher.next(background())) === JSON.stringify([fixture()]),
      "real watch omitted registration snapshot"
    )
    ensure(
      JSON.stringify(await registry.getService(background(), "docker-orders")) ===
        JSON.stringify([fixture()]),
      "real get failed"
    )
    const updated = fixture("http://127.0.0.1:8081/")
    await registry.register(background(), updated)
    ensure(
      JSON.stringify(await watcher.next(background())) === JSON.stringify([updated]),
      "real watch omitted update replacement snapshot"
    )
    await registry.deregister(background(), updated)
    ensure((await watcher.next(background())).length === 0, "real watch omitted deregistration")
    await watcher.stop(background())

    let lose = true
    const lostFetch: EtcdFetch = async function lostFetch(input, init): Promise<Response> {
      const request = input instanceof Request ? input : new Request(input, init)
      const response = await fetch(request)
      if (lose && new URL(request.url).pathname === "/v3/kv/txn") {
        lose = false
        await response.arrayBuffer()
        throw new Error("injected real lost transaction response")
      }
      return response
    }
    const lostRegistry = newEtcdRegistry({ fetch: lostFetch, address, ttlMs: 2_000 })
    await lostRegistry.register(background(), fixture())
    ensure(
      (await lostRegistry.getService(background(), "docker-orders")).length === 1,
      "real transaction readback failed"
    )
    await lostRegistry.deregister(background(), fixture())

    child = Bun.spawn([process.execPath, import.meta.path], {
      env: {
        LIKEGO_ETCD_PUBLISHER: "1",
        LIKEGO_ETCD_ADDRESS: address,
        LIKEGO_E2E_OWNER: DockerOwner
      },
      stdout: "pipe",
      stderr: "inherit"
    })
    await waitForChild(child)
    ensure(
      (await registry.getService(background(), "docker-orders")).length === 1,
      "child did not publish"
    )
    child.kill(9)
    await child.exited
    child = null
    await eventually(
      async function expired(): Promise<boolean> {
        return (await registry.getService(background(), "docker-orders")).length === 0
      },
      8_000,
      "SIGKILL publisher record did not expire"
    )

    console.log(
      `LIKEGO_ETCD_DOCKER_V2=${JSON.stringify({
        valid: true,
        image: Image,
        status: "passed",
        scenarios: [
          "service-instance-register-get-watch-update-deregister",
          "lost-transaction-response-exact-readback",
          "sigkill-publisher-lease-expiry"
        ],
        scenarioEvidence: {
          "service-instance-register-get-watch-update-deregister": {
            registerGet: true,
            watchUpdate: true,
            watchDeregisterEmpty: true
          },
          "lost-transaction-response-exact-readback": { exactReadback: true },
          "sigkill-publisher-lease-expiry": { expired: true }
        },
        cleanup: { remoteInstances: 0, watcherStopped: true }
      })}`
    )
  } finally {
    if (child !== null) {
      child.kill(9)
      await child.exited
    }
    await docker("rm", "-f", name).catch(function ignored(): string {
      return ""
    })
    const remnants = await docker("ps", "-a", "--filter", `name=^/${name}$`, "-q")
    ensure(remnants === "", "real etcd container cleanup left a remnant")
  }
}

if (process.env.LIKEGO_ETCD_PUBLISHER === "1") await publisherChild()
else await main()
