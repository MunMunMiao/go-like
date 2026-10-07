import { Socket } from "node:net"
import process from "node:process"

import { background } from "@go-like/context"
import type { Handler } from "@go-like/web"
import type { BunServer, BunServerOption } from "@go-like/web/bun"

interface Flavor {
  readonly name: "bun" | "deno"
  readonly forceCloseCode: string
  readonly occupiedCode: string
  newServer(handler: Handler, ...options: readonly BunServerOption[]): BunServer
  shutdownTimeout(timeoutMs: number): BunServerOption
  port(value: number): BunServerOption
}

interface SeenRequest {
  readonly method: string
  readonly url: string
  readonly body: string
}

const limitMs = 5_000

/** Selects the native host entry that matches the runtime executing this script. */
async function loadFlavor(): Promise<Flavor> {
  if ("Bun" in globalThis) {
    const api = await import("@go-like/web/bun")
    return {
      name: "bun",
      forceCloseCode: "GO_LIKE_BUN_SERVER_FORCE_CLOSE",
      occupiedCode: "EADDRINUSE",
      newServer: api.newBunServer,
      shutdownTimeout: api.bunShutdownTimeout,
      port: api.port
    }
  }
  if ("Deno" in globalThis) {
    const api = await import("@go-like/web/deno")
    return {
      name: "deno",
      forceCloseCode: "GO_LIKE_DENO_SERVER_FORCE_CLOSE",
      occupiedCode: "AddrInUse",
      newServer: api.newDenoServer,
      shutdownTimeout: api.denoShutdownTimeout,
      port: api.port
    }
  }
  throw new Error("native host E2E requires the Bun or Deno runtime")
}

/** Fails the native E2E scenario when a required business observation is false. */
function verify(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

/** Waits for a fixed delay without holding the process open afterwards. */
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** Rejects with a descriptive error when one awaited observation does not happen in time. */
async function within<T>(promise: Promise<T>, label: string, ms = limitMs): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`timed out waiting for ${label}`))
    }, ms)
  })
  try {
    return await Promise.race([promise, expired])
  } finally {
    clearTimeout(timer)
  }
}

/** Reports whether an unknown failure exposes a string error code. */
function hasErrorCode(value: unknown): value is { readonly code: string } {
  return (
    typeof value === "object" && value !== null && "code" in value && typeof value.code === "string"
  )
}

/** Matches runtime bind failures whose diagnostic is exposed as either code or error name. */
function hasErrorMarker(value: unknown, marker: string): boolean {
  if (typeof value !== "object" || value === null) return false
  const code = "code" in value && typeof value.code === "string" ? value.code : ""
  const name = "name" in value && typeof value.name === "string" ? value.name : ""
  return code === marker || name === marker
}

/** Sends one raw HTTP exchange so tests can exercise methods and headers Fetch refuses to build. */
function rawExchange(port: number, requestText: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = new Socket()
    let response = ""
    socket.setEncoding("utf8")
    socket.on("data", (chunk: string) => {
      response += chunk
    })
    socket.once("error", reject)
    socket.once("close", () => {
      resolve(response)
    })
    socket.connect(port, "127.0.0.1", () => {
      socket.write(requestText)
    })
  })
}

/** Aborts one client socket after the first response bytes arrive. */
function abortAfterFirstResponseData(port: number, path: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const socket = new Socket()
    socket.on("error", reject)
    socket.once("data", () => {
      socket.destroy()
      resolve()
    })
    socket.connect(port, "127.0.0.1", () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`)
    })
  })
}

/** Writes a request whose declared body is longer than the bytes sent, then drops the connection. */
function truncatedUpload(port: number, requestText: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const socket = new Socket()
    socket.once("error", (error) => {
      if (!hasErrorCode(error) || error.code !== "ECONNRESET") reject(error)
    })
    socket.once("close", () => {
      resolve()
    })
    socket.connect(port, "127.0.0.1", () => {
      socket.write(requestText, () => {
        setTimeout(() => {
          socket.destroy()
        }, 10)
      })
    })
  })
}

/** Returns the error one construction attempt throws, or null when it unexpectedly succeeds. */
function constructionError(construct: () => unknown): unknown {
  try {
    construct()
    return null
  } catch (error) {
    return error
  }
}

/** Returns the origin and TCP port of one reported endpoint. */
function locate(endpoint: string): { readonly origin: string; readonly port: number } {
  const url = new URL(endpoint)
  return { origin: url.origin, port: Number(url.port) }
}

/** Reports whether a fresh connection to one origin is refused. */
async function refuses(origin: string): Promise<boolean> {
  try {
    await within(fetch(`${origin}/refusal-probe`, { headers: { connection: "close" } }), "refusal")
    return false
  } catch (error) {
    return !(error instanceof Error && error.message.startsWith("timed out"))
  }
}

/** Reads one chunk as text, failing when the stream ended instead. */
async function readText(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const chunk = await within(reader.read(), "a response chunk")
  if (chunk.done) throw new Error("response ended before the expected chunk")
  return new TextDecoder().decode(chunk.value)
}

/** Builds a streaming body that stays open until its consumer is cancelled. */
function openBody(onCancel: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("first"))
    },
    cancel() {
      onCancel()
      return new Promise<void>(() => undefined)
    }
  })
}

const flavor = await loadFlavor()
const { newServer, shutdownTimeout, port: listenPort } = flavor

const scenarios: string[] = []
// A rejection nobody observed is a lifecycle leak; failing fast also keeps a failed scenario from
// being swallowed by the listener when the runtime routes top-level failures through it.
process.on("unhandledRejection", (reason) => {
  console.error("unhandled rejection:", reason)
  process.exit(1)
})
let acceptedServers = 0
let terminalServers = 0

const seen: SeenRequest[] = []
const streamRelease = Promise.withResolvers<void>()
const drainEntered = Promise.withResolvers<void>()
const drainRelease = Promise.withResolvers<void>()
const truncatedObserved = Promise.withResolvers<string>()
let handlerArgumentCount = -1
let probeHits = 0

const main = newServer(async function fetchHandler(request) {
  handlerArgumentCount = arguments.length
  const url = new URL(request.url)
  switch (url.pathname) {
    case "/clone": {
      const cloned = request.clone()
      const originalBody = await request.text()
      const clonedBody = await cloned.text()
      return Response.json({ bodyUsed: request.bodyUsed, clonedBody, originalBody })
    }
    case "/stream": {
      let step = 0
      return new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (step === 0) {
              step = 1
              controller.enqueue(new TextEncoder().encode("a"))
              return
            }
            await streamRelease.promise
            controller.enqueue(new TextEncoder().encode("b"))
            controller.close()
          }
        })
      )
    }
    case "/drain":
      drainEntered.resolve()
      await drainRelease.promise
      return new Response("drained")
    case "/truncated":
      try {
        await request.text()
        truncatedObserved.resolve("completed")
      } catch (error) {
        truncatedObserved.resolve(error instanceof Error ? "rejected" : "rejected-non-error")
      }
      return new Response("observed")
    case "/fail-sync":
      throw new Error("synchronous failure")
    case "/fail-async":
      return Promise.reject(new Error("asynchronous failure"))
    case "/fail-timeout":
      return Promise.reject(Object.assign(new Error("deadline"), { name: "TimeoutError" }))
    case "/fail-value":
      return undefined as never
    case "/refusal-probe":
      probeHits += 1
      return new Response("probe")
    default:
      seen.push({
        method: request.method,
        url: request.url,
        body: request.body === null ? "" : await request.text()
      })
      return new Response("ok", { headers: { "set-cookie": "a=b", "x-method": request.method } })
  }
})
const running = main.start(background())
acceptedServers += 1
const mainEndpoint = locate(await within(main.endpoint(background()), "the main endpoint"))
const base = mainEndpoint.origin

const basic = await fetch(`${base}/hello`, { method: "POST", body: "abc" })
verify(basic.status === 200, "basic status")
verify((await basic.text()) === "ok", "basic body")
const firstSeen = seen[0]
if (firstSeen === undefined) throw new Error("handler request was not observed")
verify(firstSeen.method === "POST", "handler method")
verify(firstSeen.body === "abc", "handler body")
verify(new URL(firstSeen.url).pathname === "/hello", "handler url")
verify(basic.headers.get("x-method") === "POST", "response method header")
verify(basic.headers.get("set-cookie") === "a=b", "response cookie header")
scenarios.push("request-response-method-body-headers")

const cloned = await fetch(`${base}/clone`, { method: "POST", body: "clone-body" })
verify(cloned.status === 200, "clone status")
verify(
  JSON.stringify(await cloned.json()) ===
    JSON.stringify({ bodyUsed: true, clonedBody: "clone-body", originalBody: "clone-body" }),
  "request clone body"
)
scenarios.push("request-clone-body")

const traced = (
  await rawExchange(
    mainEndpoint.port,
    "TRACE /trace HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"
  )
).toLowerCase()
verify(traced.includes("\r\nx-method: trace\r\n"), "TRACE method header")
verify(traced.endsWith("ok"), "TRACE response body")
scenarios.push("trace-method-bridge")

const streamed = await fetch(`${base}/stream`)
if (streamed.body === null) throw new Error("stream response body is missing")
const streamReader = streamed.body.getReader()
verify((await readText(streamReader)) === "a", "first chunk did not arrive before the second")
streamRelease.resolve()
verify((await readText(streamReader)) === "b", "second stream chunk")
const streamEnd = await within(streamReader.read(), "the stream terminal")
verify(streamEnd.done, "stream reader did not reach its native terminal boundary")
streamReader.releaseLock()
verify(!streamed.body.locked, "stream reader lock was not released")
scenarios.push("incremental-readable-stream-response")

verify(handlerArgumentCount === 1, `Web server handler argument count: ${handlerArgumentCount}`)
scenarios.push("exact-one-argument-fetch-abi")

for (const [path, expected] of [
  ["/fail-sync", 500],
  ["/fail-async", 500],
  ["/fail-value", 500],
  ["/fail-timeout", 504]
] as const) {
  const failed = await fetch(`${base}${path}`)
  verify(failed.status === expected, `${path} status ${failed.status}`)
  verify((await failed.text()) === "", `${path} body`)
}
scenarios.push("handler-failure-status-mapping")

if (flavor.name === "bun") {
  const before = seen.length
  const hostless = await rawExchange(
    mainEndpoint.port,
    "GET /p HTTP/1.1\r\nHost: bad host\r\nConnection: close\r\n\r\n"
  )
  verify(hostless.startsWith("HTTP/1.1 400"), "unusable Host answers 400")
  verify(seen.length === before, "unusable Host reached the handler")
  scenarios.push("bun-unusable-host-answers-400")
}

const upload = truncatedUpload(
  mainEndpoint.port,
  "POST /truncated HTTP/1.1\r\nHost: localhost\r\nContent-Length: 11\r\nConnection: keep-alive\r\n\r\nhello"
)
verify(
  (await within(truncatedObserved.promise, "the truncated upload observation")) === "rejected",
  "truncated upload body read did not reject"
)
await upload
scenarios.push("truncated-upload-rejects")

const drainingRequest = fetch(`${base}/drain`)
await within(drainEntered.promise, "the draining request")
const gracefulStop = main.stop(background())
let gracefulSettled = false
void gracefulStop
  .finally(() => {
    gracefulSettled = true
  })
  .catch(() => undefined)
await sleep(20)
verify(!gracefulSettled, "graceful stop settled before the accepted request")
const probeBefore = probeHits
if (flavor.name === "bun") {
  verify(await refuses(base), "Bun kept accepting connections while draining")
} else {
  const refusedDuringDrain = (
    await within(
      rawExchange(
        mainEndpoint.port,
        "GET /refusal-probe HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"
      ),
      "the draining 503"
    )
  ).toLowerCase()
  verify(refusedDuringDrain.startsWith("http/1.1 503"), "Deno drain answers 503")
  verify(refusedDuringDrain.includes("\r\nconnection: close\r\n"), "Deno drain connection header")
}
verify(probeHits === probeBefore, "a request entered the handler while draining")
drainRelease.resolve()
const drainedResponse = await within(drainingRequest, "the drained response")
verify((await drainedResponse.text()) === "drained", "accepted request did not drain")
await within(gracefulStop, "the graceful stop")
await within(running, "the clean lifecycle")
terminalServers += 1
verify(await refuses(base), "new connection accepted after drain")
scenarios.push("graceful-drain-refuses-new-connections")

const releasedRebind = newServer(() => new Response("released"), listenPort(mainEndpoint.port))
const releasedRunning = releasedRebind.start(background())
acceptedServers += 1
const releasedResponse = await fetch(`${base}/`)
verify((await releasedResponse.text()) === "released", "drained port was not reusable")
await releasedRebind.stop(background())
await within(releasedRunning, "the rebound lifecycle")
terminalServers += 1
scenarios.push("released-port-rebind")

let clientAbortCancelCalls = 0
const clientAbortCanceled = Promise.withResolvers<void>()
const clientAbortSignaled = Promise.withResolvers<void>()
const clientAbortServer = newServer((request) => {
  request.signal.addEventListener(
    "abort",
    () => {
      clientAbortSignaled.resolve()
    },
    { once: true }
  )
  return new Response(
    openBody(() => {
      clientAbortCancelCalls += 1
      clientAbortCanceled.resolve()
    })
  )
}, shutdownTimeout(20))
const clientAbortRunning = clientAbortServer.start(background())
acceptedServers += 1
const clientAbortEndpoint = locate(
  await within(clientAbortServer.endpoint(background()), "the client abort endpoint")
)
await abortAfterFirstResponseData(clientAbortEndpoint.port, "/client-abort")
await within(clientAbortCanceled.promise, "response body cancellation after client abort")
await within(clientAbortSignaled.promise, "request.signal abort after client abort")
await clientAbortServer.stop(background())
await within(clientAbortRunning, "the client abort lifecycle")
terminalServers += 1
verify(clientAbortCancelCalls === 1, `client abort cancel calls: ${clientAbortCancelCalls}`)
scenarios.push("client-abort-cancels-response-body")

const forceServer = newServer(() => new Response(openBody(() => undefined)), shutdownTimeout(5))
const forceRunning = forceServer.start(background())
acceptedServers += 1
const forceEndpoint = locate(await within(forceServer.endpoint(background()), "the force endpoint"))
const forceResponse = await fetch(`${forceEndpoint.origin}/`)
if (forceResponse.body === null) throw new Error("force-close response body is missing")
const forceReader = forceResponse.body.getReader()
await readText(forceReader)
await within(forceServer.stop(background()), "the forced stop call")
let forced: unknown = null
try {
  await within(forceRunning, "the forced lifecycle")
} catch (error) {
  forced = error
}
verify(
  hasErrorCode(forced) && forced.code === flavor.forceCloseCode,
  `force close error: ${String(forced)}`
)
const stableForced = await forceRunning.catch((error: unknown) => error)
verify(stableForced === forced, "force close replaced stable done Error identity")
if (flavor.name === "bun") {
  const forceStreamTerminal = await within(
    forceReader.closed.then(
      () => true,
      () => true
    ),
    "the force-closed response stream"
  )
  verify(forceStreamTerminal, "force-close response stream did not reach terminal")
}
forceReader.releaseLock()
terminalServers += 1
scenarios.push("hard-force-noncooperative-body")

const forcedRebind = newServer(() => new Response("force-released"), listenPort(forceEndpoint.port))
const forcedRebindRunning = forcedRebind.start(background())
acceptedServers += 1
const forcedRebindResponse = await fetch(`${forceEndpoint.origin}/`)
verify((await forcedRebindResponse.text()) === "force-released", "forced port was not reusable")
await forcedRebind.stop(background())
await within(forcedRebindRunning, "the forced rebind lifecycle")
terminalServers += 1
scenarios.push("force-port-rebind")

const occupier = newServer(() => new Response("occupied"))
const occupierRunning = occupier.start(background())
acceptedServers += 1
const occupiedEndpoint = locate(await within(occupier.endpoint(background()), "the occupied port"))
const contender = newServer(() => new Response("contender"), listenPort(occupiedEndpoint.port))
const contenderStart = contender.start(background())
const bindFailure = await contenderStart.then(
  () => null,
  (error: unknown) => error
)
verify(
  hasErrorMarker(bindFailure, flavor.occupiedCode),
  `occupied port error: ${String(bindFailure)}`
)
const endpointFailure = await contender.endpoint(background()).then(
  () => null,
  (error: unknown) => error
)
verify(endpointFailure === bindFailure, "endpoint did not report the same bind failure")
const stopFailure = await contender.stop(background()).then(
  () => null,
  (error: unknown) => error
)
verify(stopFailure === bindFailure, "stop did not report the same bind failure")
await occupier.stop(background())
await within(occupierRunning, "the occupier lifecycle")
terminalServers += 1
scenarios.push("bind-failure-keeps-runtime-error")

let foreignError: unknown = null
let foreignMessage = ""
if (flavor.name === "bun") {
  const foreign = await import("@go-like/web/deno")
  foreignError = constructionError(() => foreign.newDenoServer(() => new Response()))
  foreignMessage = "@go-like/web/deno requires the Deno runtime"
} else {
  const foreign = await import("@go-like/web/bun")
  foreignError = constructionError(() => foreign.newBunServer(() => new Response()))
  foreignMessage = "@go-like/web/bun requires the Bun runtime"
}
verify(
  foreignError instanceof Error && foreignError.message === foreignMessage,
  `the other runtime's entry did not fail clearly at construction: ${String(foreignError)}`
)
scenarios.push("foreign-runtime-entry-imports-cleanly")

await sleep(20)
const stableScenarios = Array.from(new Set(scenarios))
verify(stableScenarios.length === scenarios.length, "duplicate native host E2E scenario slug")
verify(
  stableScenarios.length === (flavor.name === "bun" ? 15 : 14),
  `native host E2E scenario inventory: ${stableScenarios.length}`
)
verify(acceptedServers === terminalServers, "native host server cleanup mismatch")

console.log(JSON.stringify({ runtime: flavor.name, scenarios: stableScenarios }))
