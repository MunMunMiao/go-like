import { once } from "node:events"
import { mkdir, symlink } from "node:fs/promises"
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

/** Sends one raw HTTP request so tests can exercise methods Fetch refuses to construct. */
async function rawHttpRequest(port: number, requestText: string): Promise<string> {
  return await new Promise<string>((resolveResponse, rejectResponse) => {
    const socket = new Socket()
    let response = ""
    socket.setEncoding("utf8")
    socket.on("data", (chunk: string) => {
      response += chunk
    })
    socket.once("error", rejectResponse)
    socket.once("end", () => {
      resolveResponse(response)
    })
    socket.connect(port, "127.0.0.1", () => {
      socket.write(requestText)
    })
  })
}

/** Writes one raw request and resets the client connection after Node accepts its bytes. */
async function resetAfterRawRequest(port: number, requestText: string): Promise<void> {
  await new Promise<void>((resolveReset, rejectReset) => {
    const socket = new Socket()
    socket.once("error", (error) => {
      if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") rejectReset(error)
    })
    socket.once("close", () => resolveReset())
    socket.connect(port, "127.0.0.1", () => {
      socket.write(requestText, () => setTimeout(() => socket.resetAndDestroy(), 10))
    })
  })
}

/** Keeps one incomplete request open until the Node bridge enforces its drain deadline. */
async function waitForServerDrainClose(port: number, requestText: string): Promise<string> {
  return await new Promise<string>((resolveClose, rejectClose) => {
    const socket = new Socket()
    let response = ""
    const timer = setTimeout(() => {
      socket.destroy()
      rejectClose(new Error("Node bridge did not enforce the request drain deadline"))
    }, 1_500)
    const finish = (): void => {
      clearTimeout(timer)
      socket.destroy()
      resolveClose(response)
    }
    socket.setEncoding("utf8")
    socket.on("data", (chunk: string) => {
      response += chunk
    })
    socket.once("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ECONNRESET") finish()
      else rejectClose(error)
    })
    socket.once("close", finish)
    socket.connect(port, "127.0.0.1", () => socket.write(requestText))
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

await ensureWorkspaceLinks()

const { background } = await import("@go-like/context")
const { nodeShutdownTimeout, newNodeServer, port: listenPort } = await import("@go-like/web/node")

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
let recoveryGate = Promise.resolve()
let releaseRecovery: (() => void) | undefined
let recoveryEntered: (() => void) | undefined
let recoveryObservation: { body?: string; error?: string } | undefined
let handlerArgumentCount = 0
const mainPort = await availablePort()
const server = newNodeServer(async function fetchHandler(request) {
  handlerArgumentCount = arguments.length
  const url = new URL(request.url)
  if (url.pathname.startsWith("/recovery-")) {
    recoveryEntered?.()
    await recoveryGate
    try {
      recoveryObservation = {
        body:
          url.pathname === "/recovery-lazy"
            ? await new Response(request.body).text()
            : await request.text()
      }
    } catch (error) {
      recoveryObservation = { error: error instanceof Error ? error.message : String(error) }
    }
    return new Response("observed")
  }
  if (url.pathname === "/bounded-drain") return new Response("drained")
  if (url.pathname === "/clone") {
    const cloned = request.clone()
    const originalBody = await request.text()
    const clonedBody = await cloned.text()
    return Response.json({ bodyUsed: request.bodyUsed, clonedBody, originalBody })
  }
  seen.push({
    method: request.method,
    url: request.url,
    body: request.body === null ? "" : await request.text()
  })
  if (url.pathname === "/sse") {
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
  if (url.pathname === "/drain") {
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

const boundedDrain = await waitForServerDrainClose(
  mainPort,
  "POST /bounded-drain HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100000000\r\nConnection: keep-alive\r\n\r\nhello"
)
verify(boundedDrain.includes("\r\n\r\ndrained"), "bounded drain response")
scenarios.push("bounded-incomplete-request-drain")

for (const [path, payload, expected] of [
  ["/recovery-direct", "hello-world", JSON.stringify({ body: "hello-world" })],
  ["/recovery-lazy", "hello-world", JSON.stringify({ body: "hello-world" })],
  ["/recovery-truncated", "hello", JSON.stringify({ error: "aborted" })]
] as const) {
  recoveryObservation = undefined
  recoveryGate = new Promise<void>((resolveRecovery) => {
    releaseRecovery = resolveRecovery
  })
  const entered = new Promise<void>((resolveEntered) => {
    recoveryEntered = resolveEntered
  })
  const reset = resetAfterRawRequest(
    mainPort,
    `POST ${path} HTTP/1.1\r\nHost: localhost\r\nContent-Length: 11\r\nConnection: keep-alive\r\n\r\n${payload}`
  )
  await entered
  await reset
  releaseRecovery?.()
  const deadline = Date.now() + 1_000
  while (recoveryObservation === undefined && Date.now() < deadline) {
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 1))
  }
  verify(JSON.stringify(recoveryObservation) === expected, `${path} recovery observation`)
  scenarios.push(path.slice(1))
}

const cloned = await fetch(`${base}/clone`, { method: "POST", body: "clone-body" })
verify(cloned.status === 200, "clone status")
verify(
  JSON.stringify(await cloned.json()) ===
    JSON.stringify({ bodyUsed: true, clonedBody: "clone-body", originalBody: "clone-body" }),
  "request clone body"
)
scenarios.push("request-clone-body")

const traced = await rawHttpRequest(
  mainPort,
  "TRACE /trace HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"
)
verify(traced.includes("\r\nx-method: TRACE\r\n"), "TRACE method header")
verify(traced.endsWith("ok"), "TRACE response body")
scenarios.push("trace-method-bridge")

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
verify(stableScenarios.length === 14, `Web Node E2E scenario inventory: ${stableScenarios.length}`)
verify(acceptedServers === terminalServers, "Web server cleanup mismatch")
verify(portReleased, "Fetch port was not released")
verify(forcePortReleased, "forced Fetch port was not released")
verify(lateRejections.length === 0, "Web server published an unhandled rejection")
verify(pendingTimers === 0, `Web server leaked ${pendingTimers} timer(s)`)
verify(unhandledListenerDelta === 0, "Web server leaked an unhandledRejection listener")
