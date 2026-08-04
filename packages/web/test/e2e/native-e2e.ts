import { once } from "node:events"
import { mkdir, readFile, symlink } from "node:fs/promises"
import { createServer } from "node:http"
import { Socket } from "node:net"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const repoRoot = resolve(packageRoot, "../..")

interface SeenRequest {
  readonly method: string
  readonly url: string
  readonly body: string
}

/** Reports whether an unknown failure exposes a string error code. */
function hasErrorCode(value: unknown): value is { readonly code: string } {
  return (
    typeof value === "object" && value !== null && "code" in value && typeof value.code === "string"
  )
}

/** Ensures Node can resolve workspace dependencies in an isolated package mount. */
async function ensureWorkspaceLinks(): Promise<void> {
  const scope = resolve(packageRoot, "node_modules/@go-like")
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

/** Aborts one client socket after the first response bytes arrive. */
async function abortAfterFirstResponseData(port: number, path: string): Promise<void> {
  return await new Promise<void>((resolveAbort, rejectAbort) => {
    const socket = new Socket()
    socket.on("error", rejectAbort)
    socket.once("data", () => {
      socket.destroy()
      resolveAbort()
    })
    socket.connect(port, "127.0.0.1", () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`)
    })
  })
}

/** Reserves and releases one loopback TCP port. */
async function availablePort(): Promise<number> {
  const probe = createServer()
  probe.listen(0, "127.0.0.1")
  await once(probe, "listening")
  const address = probe.address()
  if (address === null || typeof address === "string")
    throw new Error("port probe did not bind a TCP address")
  await new Promise<void>((resolveClose, rejectClose) => {
    probe.close((error) => {
      if (error === undefined) resolveClose()
      else rejectClose(error)
    })
  })
  return address.port
}

/** Retries one Fetch request until the listener admits connections. */
async function fetchWhenReady(input: string, init?: RequestInit): Promise<Response> {
  const deadline = Date.now() + 2_000
  let failure: unknown = null
  while (Date.now() < deadline) {
    try {
      return await fetch(input, init)
    } catch (error) {
      failure = error
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 5))
    }
  }
  throw new Error("Node Web listener did not become ready", { cause: failure })
}

/** Waits until one loopback TCP listener accepts a connection. */
async function waitForPort(port: number): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>((resolveConnection) => {
      const socket = new Socket()
      socket.once("connect", () => {
        socket.destroy()
        resolveConnection(true)
      })
      socket.once("error", () => {
        socket.destroy()
        resolveConnection(false)
      })
      socket.connect(port, "127.0.0.1")
    })
    if (connected) return
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 5))
  }
  throw new Error("Node Web TCP listener did not become ready")
}

/** Fails the native E2E scenario when a required business observation is false. */
function verify(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

/** Selects timer resources from Node's public active resource inventory. */
function isTimeoutResource(resource: string): boolean {
  return resource === "Timeout"
}

/** Reads one exact package version from validated JSON metadata. */
function metadataVersion(value: unknown): string {
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    typeof value.version !== "string"
  ) {
    throw new Error("@hono/node-server package metadata has no string version")
  }
  return value.version
}

await ensureWorkspaceLinks()

const { background } = await import("@go-like/context")
const { nodeShutdownTimeout, newNodeServer, port: listenPort } = await import("@go-like/web/node")
const hostMetadata: unknown = JSON.parse(
  await readFile(new URL("../package.json", import.meta.resolve("@hono/node-server")), "utf8")
)
const hostVersion = metadataVersion(hostMetadata)
verify(hostVersion === "2.0.12", `unexpected @hono/node-server version: ${hostVersion}`)

const baselineTimeouts = process.getActiveResourcesInfo().filter(isTimeoutResource).length
const baselineUnhandledListeners = process.listenerCount("unhandledRejection")
const lateRejections: unknown[] = []
const onUnhandled = (reason: unknown): void => {
  lateRejections.push(reason)
}
process.on("unhandledRejection", onUnhandled)
const scenarios: string[] = []
let acceptedServers = 0
let terminalServers = 0
let portReleased = false
let forcePortReleased = false

const seen: SeenRequest[] = []
const drainEnteredCallbacks: { resolve?: () => void } = {}
const drainEntered = new Promise<void>((resolve) => {
  drainEnteredCallbacks.resolve = resolve
})
const drainReleaseCallbacks: { resolve?: () => void } = {}
const drainRelease = new Promise<void>((resolve) => {
  drainReleaseCallbacks.resolve = resolve
})
let handlerArgumentCount = 0
const mainPort = await availablePort()
const server = newNodeServer(async function fetchHandler(request) {
  handlerArgumentCount = arguments.length
  seen.push({
    method: request.method,
    url: request.url,
    body: request.body === null ? "" : await request.text()
  })
  if (new URL(request.url).pathname === "/sse") {
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("a"))
          setTimeout(() => {
            controller.enqueue(new TextEncoder().encode("b"))
            controller.close()
          }, 50)
        }
      })
    )
  }
  if (new URL(request.url).pathname === "/drain") {
    drainEnteredCallbacks.resolve?.()
    await drainRelease
    return new Response("drained")
  }
  return new Response("ok", {
    headers: {
      "set-cookie": "a=b",
      "x-method": request.method
    }
  })
}, listenPort(mainPort))

const running = server.start(background())
acceptedServers += 1
const base = `http://127.0.0.1:${mainPort}`

const basic = await fetchWhenReady(`${base}/hello`, { method: "POST", body: "abc" })
verify(basic.status === 200, "basic status")
const responseBody = await basic.text()
verify(responseBody === "ok", "basic body")
const firstSeen = seen[0]
if (firstSeen === undefined) throw new Error("handler request was not observed")
verify(firstSeen.method === "POST", "handler method")
verify(firstSeen.body === "abc", "handler body")
const responseHeader = basic.headers.get("x-method")
const responseCookie = basic.headers.get("set-cookie")
verify(responseHeader === "POST", "response method header")
verify(responseCookie === "a=b", "response cookie header")
scenarios.push("request-response-method-body-headers")

const started = Date.now()
const sse = await fetch(`${base}/sse`)
if (sse.body === null) throw new Error("sse response body is missing")
const reader = sse.body.getReader()
const first = await reader.read()
const elapsed = Date.now() - started
const second = await reader.read()
if (first.done || second.done) throw new Error("sse response ended before both chunks arrived")
verify(new TextDecoder().decode(first.value) === "a", "first sse chunk")
verify(elapsed < 45, `sse did not stream incrementally: ${elapsed}`)
verify(new TextDecoder().decode(second.value) === "b", "second sse chunk")
const terminal = await reader.read()
verify(terminal.done, "sse reader did not reach its native terminal boundary")
let readerClosed = false
await reader.closed.then(() => {
  readerClosed = true
})
verify(readerClosed, "sse reader closed Promise did not fulfill")
reader.releaseLock()
const readerLockReleased = !sse.body.locked
verify(readerLockReleased, "sse reader lock was not released")
scenarios.push("incremental-readable-stream-response")

verify(handlerArgumentCount === 1, `Web server handler argument count: ${handlerArgumentCount}`)
scenarios.push("exact-one-argument-fetch-abi")

const drainingRequest = fetch(`${base}/drain`)
await drainEntered
const gracefulStop = server.stop(background())
let gracefulSettled = false
void gracefulStop
  .finally(() => {
    gracefulSettled = true
  })
  .catch(() => {})
await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 10))
verify(!gracefulSettled, "graceful stop settled before accepted request")
const gracefulPendingBeforeRelease = !gracefulSettled
drainReleaseCallbacks.resolve?.()
const drainedResponse = await drainingRequest
verify((await drainedResponse.text()) === "drained", "accepted request did not drain")
await gracefulStop
await running
terminalServers += 1

let refused = false
try {
  await fetch(`${base}/after-stop`)
} catch {
  refused = true
}
verify(refused, "new connection refused after drain")
scenarios.push("graceful-drain-refuses-new-connections")

let clientAbortCancelCalls = 0
const clientAbortPort = await availablePort()
const clientAbortCallbacks: { resolve?: () => void } = {}
const clientAbortCanceled = new Promise<void>((resolveCancel) => {
  clientAbortCallbacks.resolve = resolveCancel
})
const clientAbortServer = newNodeServer(
  () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("first"))
        },
        cancel() {
          clientAbortCancelCalls += 1
          clientAbortCallbacks.resolve?.()
          return new Promise<void>(() => {})
        }
      })
    ),
  listenPort(clientAbortPort),
  nodeShutdownTimeout(20)
)
const clientAbortRunning = clientAbortServer.start(background())
acceptedServers += 1
await waitForPort(clientAbortPort)
await abortAfterFirstResponseData(clientAbortPort, "/client-abort")
let clientAbortTimeout: ReturnType<typeof setTimeout> | null = null
const canceledBeforeStop = await Promise.race([
  clientAbortCanceled.then(() => true),
  new Promise<boolean>((resolveTimeout) => {
    clientAbortTimeout = setTimeout(() => resolveTimeout(false), 100)
  })
])
if (clientAbortTimeout !== null) clearTimeout(clientAbortTimeout)
await clientAbortServer.stop(background())
await clientAbortRunning
terminalServers += 1
verify(canceledBeforeStop, "client abort did not cancel response body before stop")
verify(clientAbortCancelCalls === 1, `client abort cancel calls: ${clientAbortCancelCalls}`)
scenarios.push("client-abort-cancels-response-body")

const forcePort = await availablePort()
const forceServer = newNodeServer(
  () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("x"))
        },
        cancel() {
          return new Promise<void>(() => {})
        }
      })
    ),
  listenPort(forcePort),
  nodeShutdownTimeout(5)
)
const forceRunning = forceServer.start(background())
acceptedServers += 1
const forceBase = `http://127.0.0.1:${forcePort}`
const forceResponse = await fetchWhenReady(forceBase)
if (forceResponse.body === null) throw new Error("force-close response body is missing")
const forceReader = forceResponse.body.getReader()
await forceReader.read()
await forceServer.stop(background())
let forced: unknown = null
try {
  await forceRunning
} catch (error) {
  forced = error
}
verify(
  hasErrorCode(forced) && forced.code === "GO_LIKE_NODE_SERVER_FORCE_CLOSE",
  "force close error"
)
const stableForced = await forceRunning.catch((error: unknown) => error)
verify(stableForced === forced, "force close replaced stable done Error identity")
let forceStreamTimeout: ReturnType<typeof setTimeout> | null = null
const forceStreamTerminal = await Promise.race([
  forceReader.closed.then(
    () => true,
    () => true
  ),
  new Promise<boolean>((resolveTimeout) => {
    forceStreamTimeout = setTimeout(() => {
      resolveTimeout(false)
    }, 1_000)
  })
])
if (forceStreamTimeout !== null) clearTimeout(forceStreamTimeout)
verify(forceStreamTerminal, "force-close response stream did not reach terminal")
forceReader.releaseLock()
terminalServers += 1
scenarios.push("hard-force-noncooperative-body")

const forcePortSanity = createServer((_request, response) => response.end("force-released"))
forcePortSanity.listen(forcePort, "127.0.0.1")
await once(forcePortSanity, "listening")
await new Promise<void>((resolveClose, rejectClose) => {
  forcePortSanity.close((error) => {
    if (error === undefined) resolveClose()
    else rejectClose(error)
  })
})
forcePortReleased = true
scenarios.push("force-port-rebind")

await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 20))
process.off("unhandledRejection", onUnhandled)
verify(lateRejections.length === 0, `late unhandled rejections: ${lateRejections.length}`)

const sanity = createServer((_request, response) => response.end("released"))
sanity.listen(mainPort, "127.0.0.1")
await once(sanity, "listening")
await new Promise<void>((resolveClose, rejectClose) => {
  sanity.close((error) => {
    if (error === undefined) resolveClose()
    else rejectClose(error)
  })
})
portReleased = true
scenarios.push("released-port-rebind")

await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 20))
const finalTimeouts = process.getActiveResourcesInfo().filter(isTimeoutResource).length
const pendingTimers = finalTimeouts - baselineTimeouts
const unhandledListenerDelta =
  process.listenerCount("unhandledRejection") - baselineUnhandledListeners
const stableScenarios = Array.from(new Set(scenarios))
verify(stableScenarios.length === scenarios.length, "duplicate Web Node E2E scenario slug")
verify(stableScenarios.length === 8, `Web Node E2E scenario inventory: ${stableScenarios.length}`)
verify(acceptedServers === terminalServers, "Web server cleanup mismatch")
verify(portReleased, "Fetch port was not released")
verify(forcePortReleased, "forced Fetch port was not released")
verify(lateRejections.length === 0, "Web server published an unhandled rejection")
verify(pendingTimers === 0, `Web server leaked ${pendingTimers} timer(s)`)
verify(unhandledListenerDelta === 0, "Web server leaked an unhandledRejection listener")
