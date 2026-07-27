import { background } from "@likego/context"
import { type ServiceInstance } from "@likego/registry"
import { newZookeeperRegistry, type ZookeeperRegistry } from "@likego/registry-zookeeper"
import { createConnection, createServer } from "node:net"
import * as zookeeper from "node-zookeeper-client"

const image =
  "zookeeper:3.9.5@sha256:4c6f15fbd5491a3e01b0108c046891125553329a4956848ba3014cedff5386ee"
const marker = "LIKEGO_ZOOKEEPER_DOCKER_EVIDENCE_V2="
const operationTimeoutMs = 15_000
const DockerOwner = process.env.LIKEGO_E2E_OWNER
if (DockerOwner === undefined || !/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(DockerOwner)) {
  throw new Error("invalid LIKEGO_E2E_OWNER")
}
const DockerOwnerLabel = `io.likego.e2e.owner=${DockerOwner}`

interface CommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly code: number
}

/** Requires one integration invariant. */
function ensure(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/** Runs one Docker command to completion. */
async function docker(...args: readonly string[]): Promise<CommandResult> {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ])
  if (code !== 0) throw new Error(`docker ${args[0] ?? "command"} failed: ${stderr.trim()}`)
  return Object.freeze({ stdout: stdout.trim(), stderr: stderr.trim(), code })
}

/** Runs best-effort Docker cleanup. */
async function dockerCleanup(...args: readonly string[]): Promise<CommandResult> {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ])
  return Object.freeze({ stdout: stdout.trim(), stderr: stderr.trim(), code })
}

/** Reserves one currently unused loopback TCP port. */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(function listen(resolve, reject): void {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (typeof address !== "object" || address === null) throw new Error("free port unavailable")
  const port = address.port
  await new Promise<void>(function close(resolve, reject): void {
    server.close(function closed(error): void {
      if (error === undefined) resolve()
      else reject(error)
    })
  })
  return port
}

/** Waits until one real distributed condition converges. */
async function eventually(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  message: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last: unknown = null
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return
    } catch (value) {
      last = value
    }
    await Bun.sleep(100)
  }
  throw new Error(`${message}${last instanceof Error ? `: ${last.message}` : ""}`)
}

/** Executes one ZooKeeper four-letter command over TCP. */
function fourLetter(port: number, command: "ruok" | "stat"): Promise<string> {
  return new Promise<string>(function request(resolve, reject): void {
    const chunks: Buffer[] = []
    const socket = createConnection({ host: "127.0.0.1", port })
    socket.setTimeout(3_000)
    socket.once("connect", function connected(): void {
      socket.write(command)
    })
    socket.on("data", function received(chunk: Buffer): void {
      chunks.push(Buffer.from(chunk))
    })
    socket.once("end", function ended(): void {
      resolve(Buffer.concat(chunks).toString("utf8"))
    })
    socket.once("timeout", function timedOut(): void {
      socket.destroy(new Error(`ZooKeeper ${command} timed out`))
    })
    socket.once("error", reject)
  })
}

/** Creates one real registry with fast one-shot reconciliation. */
function registry(address: string, root: string): ZookeeperRegistry {
  return newZookeeperRegistry({
    address,
    root,
    sessionTimeoutMs: 4_000,
    spinDelayMs: 100,
    retries: 0,
    retryInitialMs: 100,
    retryMaximumMs: 1_000,
    reconcileIntervalMs: 250,
    timeoutMs: operationTimeoutMs
  })
}

/** Creates one deterministic real service fixture. */
function fixture(name: string, revision: "initial" | "updated"): ServiceInstance {
  return {
    id: `${name}-1`,
    name,
    version: "v1",
    metadata: { revision },
    endpoints: [revision === "initial" ? "http://127.0.0.1:8080/" : "http://127.0.0.1:8081/"]
  }
}

/** Opens one raw administration client. */
function rawClient(address: string): Promise<zookeeper.Client> {
  const client = zookeeper.createClient(address, {
    sessionTimeout: 4_000,
    spinDelay: 100,
    retries: 0
  })
  return new Promise<zookeeper.Client>(function opening(resolve, reject): void {
    const timer = setTimeout(function timedOut(): void {
      client.close()
      reject(new Error("raw ZooKeeper connection timed out"))
    }, operationTimeoutMs)
    client.once("connected", function connected(): void {
      clearTimeout(timer)
      resolve(client)
    })
    client.once("authenticationFailed", function failed(): void {
      clearTimeout(timer)
      reject(new Error("raw ZooKeeper authentication failed"))
    })
    client.connect()
  })
}

/** Reads a ZooKeeper code from the native declaration's broad error union. */
function nativeCode(value: unknown): number | null {
  if (
    typeof value === "object" &&
    value !== null &&
    "getCode" in value &&
    typeof value.getCode === "function"
  ) {
    const code: unknown = value.getCode()
    return typeof code === "number" ? code : null
  }
  return null
}

/** Reads exact child names for recursive cleanup. */
function children(client: zookeeper.Client, path: string): Promise<readonly string[]> {
  return new Promise<readonly string[]>(function reading(resolve, reject): void {
    client.getChildren(path, function completed(error, names): void {
      if (error === null) resolve(Object.freeze(Array.from(names)))
      else reject(error)
    })
  })
}

/** Removes one exact znode idempotently. */
function remove(client: zookeeper.Client, path: string): Promise<void> {
  return new Promise<void>(function removing(resolve, reject): void {
    client.remove(path, -1, function completed(error): void {
      if (error === null || nativeCode(error) === zookeeper.Exception.NO_NODE) resolve()
      else reject(error)
    })
  })
}

/** Removes one test-owned subtree through the native client. */
async function removeTree(client: zookeeper.Client, path: string): Promise<void> {
  let names: readonly string[]
  try {
    names = await children(client, path)
  } catch (value) {
    if (nativeCode(value) === zookeeper.Exception.NO_NODE) return
    throw value
  }
  for (const name of names) await removeTree(client, `${path}/${name}`)
  await remove(client, path)
}

/** Reports whether one exact znode exists. */
function exists(client: zookeeper.Client, path: string): Promise<boolean> {
  return new Promise<boolean>(function reading(resolve, reject): void {
    client.exists(path, function completed(error, stat): void {
      if (error === null) resolve(stat !== null && stat !== undefined)
      else if (nativeCode(error) === zookeeper.Exception.NO_NODE) resolve(false)
      else reject(error)
    })
  })
}

/** Runs the publisher process that the parent deliberately kills. */
async function publisherChild(): Promise<never> {
  const address = process.env.LIKEGO_ZOOKEEPER_ADDRESS
  const root = process.env.LIKEGO_ZOOKEEPER_ROOT
  if (address === undefined || root === undefined) throw new Error("publisher config missing")
  const subject = registry(address, root)
  await subject.register(background(), fixture("docker-sigkill", "initial"))
  console.log("LIKEGO_ZOOKEEPER_CHILD_READY")
  return await new Promise<never>(function resident(): void {})
}

/** Waits for the child readiness marker. */
async function waitForChild(child: ReturnType<typeof Bun.spawn>): Promise<void> {
  if (!(child.stdout instanceof ReadableStream)) throw new Error("publisher stdout unavailable")
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  const deadline = Date.now() + 20_000
  let text = ""
  try {
    while (!text.includes("LIKEGO_ZOOKEEPER_CHILD_READY")) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error("publisher readiness timed out")
      const chunk = await Promise.race([
        reader.read(),
        Bun.sleep(remaining).then(function timedOut(): null {
          return null
        })
      ])
      if (chunk === null || chunk.done) throw new Error("publisher exited before readiness")
      text += decoder.decode(chunk.value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
}

/** Runs real register/update/watch/deregister and SIGKILL expiry evidence. */
async function main(): Promise<void> {
  const identity = crypto.randomUUID()
  const suffix = identity.replaceAll("-", "")
  const containerName = `likego-zookeeper-${identity}`
  const root = `/likego/e2e/${suffix}`
  const port = await freePort()
  const address = `127.0.0.1:${port}`
  let remoteRemaining = -1
  let externalSessions = -1
  let child: ReturnType<typeof Bun.spawn> | null = null

  try {
    await docker(
      "run",
      "-d",
      "--name",
      containerName,
      "--label",
      "likego.suite=registry-zookeeper",
      "--label",
      DockerOwnerLabel,
      "-p",
      `127.0.0.1:${port}:2181`,
      "-e",
      "ZOO_4LW_COMMANDS_WHITELIST=ruok,stat",
      image
    )
    await eventually(
      async function healthy(): Promise<boolean> {
        try {
          return (await fourLetter(port, "ruok")).trim() === "imok"
        } catch {
          return false
        }
      },
      20_000,
      "ZooKeeper did not become healthy"
    )

    const publisher = registry(address, `${root}/lifecycle`)
    const observer = registry(address, `${root}/lifecycle`)
    const name = "docker-lifecycle"
    const initial = fixture(name, "initial")
    const updated = fixture(name, "updated")
    const watcher = await observer.watch(background(), name)

    await publisher.register(background(), initial)
    ensure(
      JSON.stringify(await watcher.next(background())) === JSON.stringify([initial]),
      "watch omitted register"
    )
    ensure(
      JSON.stringify(await observer.getService(background(), name)) === JSON.stringify([initial]),
      "get omitted register"
    )
    await publisher.register(background(), updated)
    ensure(
      JSON.stringify(await watcher.next(background())) === JSON.stringify([updated]),
      "watch omitted update"
    )
    await publisher.deregister(background(), updated)
    ensure((await watcher.next(background())).length === 0, "watch omitted deregister")
    await watcher.stop(background())
    ensure((await observer.getService(background(), name)).length === 0, "deregister left record")

    const sigkillRoot = `${root}/sigkill`
    const sigkillObserver = registry(address, sigkillRoot)
    child = Bun.spawn([process.execPath, import.meta.path], {
      env: {
        ...process.env,
        LIKEGO_ZOOKEEPER_PUBLISHER: "1",
        LIKEGO_ZOOKEEPER_ADDRESS: address,
        LIKEGO_ZOOKEEPER_ROOT: sigkillRoot
      },
      stdout: "pipe",
      stderr: "pipe"
    })
    await waitForChild(child)
    ensure(
      (await sigkillObserver.getService(background(), "docker-sigkill")).length === 1,
      "SIGKILL publisher did not register"
    )
    child.kill(9)
    await child.exited
    child = null
    await eventually(
      async function expired(): Promise<boolean> {
        return (await sigkillObserver.getService(background(), "docker-sigkill")).length === 0
      },
      20_000,
      "SIGKILL publisher ephemeral did not expire"
    )

    const admin = await rawClient(address)
    try {
      await removeTree(admin, root)
      remoteRemaining = Number(await exists(admin, root))
    } finally {
      admin.close()
    }
    await Bun.sleep(500)
    const stat = await fourLetter(port, "stat")
    const connections = /Connections:\s*(\d+)/.exec(stat)?.[1]
    ensure(connections !== undefined, "ZooKeeper stat omitted connections")
    externalSessions = Math.max(0, Number(connections) - 1)
    ensure(remoteRemaining === 0, "test-owned znode subtree remained")
    ensure(externalSessions === 0, "test-owned ZooKeeper sessions remained")
  } finally {
    if (child !== null && child.exitCode === null) {
      child.kill(9)
      await child.exited
    }
    await dockerCleanup("rm", "-fv", containerName)
  }

  const remaining = await dockerCleanup("inspect", containerName)
  ensure(remaining.code !== 0, "Docker container remained")
  console.log(
    `${marker}${JSON.stringify({
      valid: true,
      image,
      scenarios: [
        "service-instance-register-get-watch-update-deregister",
        "sigkill-publisher-ephemeral-expiry"
      ],
      scenarioEvidence: {
        "service-instance-register-get-watch-update-deregister": {
          registerGet: true,
          watchRegisterUpdateDeregister: true,
          deregisterReadbackEmpty: true
        },
        "sigkill-publisher-ephemeral-expiry": {
          publisherReady: true,
          signal: "SIGKILL",
          ephemeralRecordExpired: true
        }
      },
      cleanup: {
        remoteZnodes: remoteRemaining,
        externalSessions,
        containerRemaining: 0
      }
    })}`
  )
}

if (process.env.LIKEGO_ZOOKEEPER_PUBLISHER === "1") await publisherChild()
else await main()
