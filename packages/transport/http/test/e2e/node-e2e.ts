import { createServer, type RequestListener, type Server } from "node:http"
import { connect, type Socket } from "node:net"

import { newClient, withAddress, withTransport } from "@likego/client"
import { background, withCancel, withCancelCause } from "@likego/context"
import {
  address as serverAddress,
  handler,
  newServer,
  transport as serverTransport
} from "@likego/server"
import { struct } from "@likego/struct"
import { endpoint, withConnClose } from "@likego/transport"
import { newNodeHTTPTransport } from "../../src/node"
import type {
  HTTPHost,
  HTTPHostHandle,
  HTTPHostListenOptions,
  HTTPListener,
  HTTPServeHandle
} from "../../src/types"

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

interface NodeHostModule {
  newNodeHTTPHost(): HTTPHost
  newNodeHTTPHostWithFactory(factory: (listener: RequestListener) => Server): HTTPHost
}

interface MetadataEvidence {
  readonly envelopeMatchesSocket: boolean
  readonly differsFromWildcardBind: boolean
  readonly status: number
  readonly portReleased: boolean
}

const listenOptions: HTTPHostListenOptions = Object.freeze({ secure: false, tlsConfig: null })
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const nodeHostModule =
  process.env.LIKEGO_TRANSPORT_HTTP_NODE_HOST_E2E_MODULE ??
  new URL("../../src/node-host.ts", import.meta.url).href
const { newNodeHTTPHost, newNodeHTTPHostWithFactory } = (await import(
  nodeHostModule
)) as NodeHostModule
const noProxy = [process.env.NO_PROXY, process.env.no_proxy, "127.0.0.1", "localhost", "::1"]
  .filter(Boolean)
  .join(",")
process.env.NO_PROXY = noProxy
process.env.no_proxy = noProxy

/** Throws one precise E2E assertion failure. */
function verify(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/** Creates one externally resolvable Promise. */
function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | null = null
  const promise = new Promise<T>(function capture(resolve): void {
    resolvePromise = resolve
  })
  return Object.freeze({
    promise,
    resolve(value: T): void {
      resolvePromise?.(value)
    }
  })
}

/** Bounds one native operation so a resource leak cannot hang the evidence process. */
async function bounded<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>(function wait(_resolve, reject): void {
    timer = setTimeout(function expired(): void {
      reject(new Error(`${label} timed out`))
    }, 2_000)
  })
  try {
    return await Promise.race([operation, timeout])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/** Reports whether one Promise remains pending after an event-loop checkpoint. */
async function pending(operation: Promise<unknown>): Promise<boolean> {
  let settled = false
  void operation.then(
    function resolved(): void {
      settled = true
    },
    function rejected(): void {
      settled = true
    }
  )
  await new Promise<void>(function checkpoint(resolve): void {
    setTimeout(resolve, 0)
  })
  return !settled
}

/** Returns one HTTP URL for an actual bound authority. */
function url(address: string): string {
  return `http://${address}/transport`
}

/** Returns one loopback authority from an actual Node server bind. */
function nativeAddress(server: Server): string {
  const address = server.address()
  verify(
    typeof address === "object" &&
      address !== null &&
      "port" in address &&
      typeof address.port === "number",
    "native server omitted its bound port"
  )
  return `127.0.0.1:${address.port}`
}

/** Splits a normalized host:port authority. */
function addressParts(address: string): { readonly hostname: string; readonly port: number } {
  const separator = address.lastIndexOf(":")
  const host = address.slice(0, separator)
  return Object.freeze({
    hostname: host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host,
    port: Number(address.slice(separator + 1))
  })
}

/** Rebinds and closes one exact released address. */
async function provePortReleased(address: string): Promise<void> {
  const target = addressParts(address)
  const probe = createServer()
  await new Promise<void>(function bind(resolve, reject): void {
    probe.once("error", reject)
    probe.listen({ host: target.hostname, port: target.port, exclusive: true }, resolve)
  })
  await new Promise<void>(function close(resolve, reject): void {
    probe.close(function closed(error?: Error): void {
      if (error === undefined) resolve()
      else reject(error)
    })
  })
}

/** Proves a fresh TCP connection is rejected after native listener close begins. */
async function connectionRefused(address: string): Promise<boolean> {
  const target = addressParts(address)
  return await bounded(
    new Promise<boolean>(function dial(resolve): void {
      const socket = connect(target)
      socket.once("connect", function unexpected(): void {
        socket.destroy()
        resolve(false)
      })
      socket.once("error", function refused(): void {
        resolve(true)
      })
    }),
    "closed-listener connection probe"
  )
}

/** Captures one rejected Promise value without replacing its identity. */
async function rejection(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation
  } catch (error) {
    return error
  }
  throw new Error("expected rejection")
}

let acceptedServers = 0
let terminalServers = 0
const baselineTimeouts = process
  .getActiveResourcesInfo()
  .filter((value) => value === "Timeout").length
const baselineUnhandledListeners = process.listenerCount("unhandledRejection")
const unhandledRejections: unknown[] = []
function onUnhandled(reason: unknown): void {
  unhandledRejections.push(reason)
}
process.on("unhandledRejection", onUnhandled)

const transport = newNodeHTTPTransport()
const unaryListener = (await transport.listen(background(), "127.0.0.1:0")) as HTTPListener
let unaryRequestBody = ""
let unaryRequestHeader = ""
const unaryAccept = unaryListener.accept(
  background(),
  async function echo(ctx, socket): Promise<void> {
    const request = await socket.recv(ctx)
    unaryRequestBody = decoder.decode(request.body)
    unaryRequestHeader =
      request.header["likego-loopback"] ?? request.header["Likego-Loopback"] ?? ""
    await socket.send(ctx, {
      header: Object.freeze({ "Likego-Reply": "node" }),
      body: encoder.encode("unary-response")
    })
  }
)
await unaryListener.accepted()
acceptedServers += 1
const acceptedBeforeRequest = true
const unaryClient = await transport.dial(background(), unaryListener.addr())
await unaryClient.send(background(), {
  header: Object.freeze({ "Likego-Loopback": "loopback" }),
  body: encoder.encode("unary-request")
})
const unaryResponse = await unaryClient.recv(background())
await unaryClient.close(background())
await unaryListener.close(background())
await unaryAccept
terminalServers += 1
const unaryAddress = unaryListener.addr()
await provePortReleased(unaryAddress)
const unaryResponseBody = decoder.decode(unaryResponse.body)
const unaryResponseHeader =
  unaryResponse.header["likego-reply"] ?? unaryResponse.header["Likego-Reply"] ?? ""
verify(unaryRequestBody === "unary-request", "unary request body changed")
verify(unaryRequestHeader === "loopback", "unary request header changed")
verify(unaryResponseBody === "unary-response", "unary response body changed")
verify(unaryResponseHeader === "node", "unary response header changed")

const gracefulHost = newNodeHTTPHost()
const gracefulHandle = await gracefulHost.bind(background(), "127.0.0.1:0", listenOptions)
const gracefulEntered = deferred<void>()
const gracefulRelease = deferred<void>()
const gracefulServed = gracefulHandle.serve(
  background(),
  async function drain(): Promise<Response> {
    gracefulEntered.resolve(undefined)
    await gracefulRelease.promise
    return new Response("drained:accepted")
  }
)
await gracefulServed.ready()
acceptedServers += 1
const gracefulResponseWork = fetch(url(gracefulHandle.address()), { method: "POST" })
await gracefulEntered.promise
const [callerContext, cancelCaller] = withCancelCause(background())
const callerFailure = new Error("stop caller canceled")
const abandonedClose = gracefulHandle.close(callerContext)
cancelCaller(callerFailure)
const callerCancellationScoped = (await rejection(abandonedClose)) === callerFailure
const gracefulClose = gracefulHandle.close(background())
const stopPendingBeforeRelease = await pending(gracefulClose)
const newConnectionRefused = await connectionRefused(gracefulHandle.address())
gracefulRelease.resolve(undefined)
const gracefulResponse = await gracefulResponseWork
const gracefulResponseBody = await gracefulResponse.text()
await gracefulClose
await gracefulServed.done()
await gracefulHandle.done()
terminalServers += 1
await provePortReleased(gracefulHandle.address())

const forceOrder: string[] = []
const forceHost = newNodeHTTPHostWithFactory(function createForceHost(
  listener: RequestListener
): Server {
  const server = createServer(listener)
  const close = server.close.bind(server)
  const closeAllConnections = server.closeAllConnections.bind(server)
  Reflect.set(server, "close", function recordClose(callback: (error?: Error) => void): Server {
    forceOrder.push("close")
    return close(callback)
  })
  Reflect.set(server, "closeAllConnections", function recordForce(): void {
    forceOrder.push("force")
    closeAllConnections()
  })
  return server
})
const forceHandle = await forceHost.bind(background(), "127.0.0.1:0", listenOptions)
let forceBodyCanceled = false
const forceServed = forceHandle.serve(background(), function stream(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(encoder.encode("partial"))
      },
      cancel(): void {
        forceBodyCanceled = true
      }
    })
  )
})
await forceServed.ready()
acceptedServers += 1
const forceResponse = await fetch(url(forceHandle.address()), { method: "POST" })
const forceClose = forceHandle.close(background())
const closePendingBeforeForce = await pending(forceClose)
const force = forceHandle.forceClose
verify(typeof force === "function", "Node HTTP host omitted forceClose")
await force.call(forceHandle, new Error("E2E force boundary"))
let clientStreamTerminal = false
try {
  await bounded(forceResponse.arrayBuffer(), "forced client response")
  clientStreamTerminal = true
} catch {
  clientStreamTerminal = true
}
await bounded(forceClose, "forced host close")
await bounded(forceServed.done(), "forced serve terminal")
await bounded(forceHandle.done(), "forced host terminal")
terminalServers += 1
await provePortReleased(forceHandle.address())
const closeBeforeForce =
  forceOrder.indexOf("close") >= 0 && forceOrder.indexOf("force") > forceOrder.indexOf("close")
verify(closePendingBeforeForce, "host close settled before force boundary")
verify(closeBeforeForce, "force cleanup began before native graceful close")
verify(forceBodyCanceled, "force cleanup did not cancel the response body")

const passiveNative: { server: Server | null } = { server: null }
const passiveSockets = new Set<Socket>()
let passiveInvocations = 0
const passiveHost = newNodeHTTPHostWithFactory(function createPassiveHost(
  listener: RequestListener
): Server {
  const server = createServer(listener)
  passiveNative.server = server
  server.on("connection", function connected(socket): void {
    passiveSockets.add(socket)
    socket.once("close", function closed(): void {
      passiveSockets.delete(socket)
    })
  })
  return server
})
const passiveHandle = await passiveHost.bind(background(), "127.0.0.1:0", listenOptions)
const passiveServed = passiveHandle.serve(background(), function unused(): Response {
  passiveInvocations += 1
  return new Response("unused")
})
await passiveServed.ready()
acceptedServers += 1
const passiveDone = passiveHandle.done()
const stableDoneRejection = passiveHandle.done() === passiveDone
const passiveFailure = new Error("native host failed")
verify(passiveNative.server !== null, "passive native server was not created")
passiveNative.server.emit("error", passiveFailure)
const [hostFailure, serveFailure] = await Promise.all([
  rejection(passiveDone),
  rejection(passiveServed.done())
])
terminalServers += 1
await provePortReleased(passiveHandle.address())
const originalErrorIdentity = hostFailure === passiveFailure
const serveErrorIdentity = serveFailure === passiveFailure
verify(originalErrorIdentity && serveErrorIdentity, "passive host error identity changed")
verify(passiveSockets.size === 0, "passive host retained a native socket")

async function metadataProbe(bindAddress: string, dialHostname: string): Promise<MetadataEvidence> {
  let nativeLocalAddress = ""
  let envelopeLocalAddress = ""
  const host = newNodeHTTPHostWithFactory(function createMetadataHost(
    listener: RequestListener
  ): Server {
    return createServer(function capture(request, response): void {
      const hostname = request.socket.localAddress ?? ""
      const port = request.socket.localPort ?? 0
      nativeLocalAddress = hostname.includes(":") ? `[${hostname}]:${port}` : `${hostname}:${port}`
      listener(request, response)
    })
  })
  const handle = await host.bind(background(), bindAddress, listenOptions)
  const served: HTTPServeHandle = handle.serve(background(), function capture(input): Response {
    envelopeLocalAddress = input.localAddress
    return new Response("metadata")
  })
  await served.ready()
  acceptedServers += 1
  const target = addressParts(handle.address())
  const dialAddress = dialHostname.includes(":")
    ? `[${dialHostname}]:${target.port}`
    : `${dialHostname}:${target.port}`
  const response = await fetch(url(dialAddress))
  await response.arrayBuffer()
  await handle.close(background())
  await served.done()
  await handle.done()
  terminalServers += 1
  await provePortReleased(handle.address())
  return Object.freeze({
    envelopeMatchesSocket: envelopeLocalAddress === nativeLocalAddress,
    differsFromWildcardBind:
      envelopeLocalAddress !== handle.address() && nativeLocalAddress !== handle.address(),
    status: response.status,
    portReleased: true
  })
}

const ipv4Metadata = await metadataProbe("0.0.0.0:0", "127.0.0.1")
const ipv6Metadata = await metadataProbe("[::]:0", "::1")
verify(acceptedServers === 6, `accepted server inventory changed: ${acceptedServers}`)
verify(terminalServers === acceptedServers, "not every accepted server reached terminal")
verify(ipv4Metadata.envelopeMatchesSocket, "IPv4 connection metadata changed")
verify(ipv6Metadata.envelopeMatchesSocket, "IPv6 connection metadata changed")

let poolRequests = 0
let poolConnections = 0
const poolSockets = new Set<Socket>()
const poolConnectionHeaders: string[] = []
const poolServer = createServer(function respond(request, response): void {
  poolRequests += 1
  poolConnectionHeaders.push(request.headers.connection ?? "")
  response.on("error", function expected(): void {})
  if (poolRequests === 3) {
    response.write("pending")
    return
  }
  if (poolRequests === 4) {
    response.writeHead(200)
    response.flushHeaders()
    setImmediate(function truncate(): void {
      response.destroy()
    })
    return
  }
  response.end(`pool-${poolRequests}`)
})
poolServer.on("connection", function connected(socket): void {
  poolConnections += 1
  poolSockets.add(socket)
  socket.once("close", function closed(): void {
    poolSockets.delete(socket)
  })
})
await new Promise<void>(function listen(resolve, reject): void {
  poolServer.once("error", reject)
  poolServer.listen(0, "127.0.0.1", resolve)
})
const poolAddress = nativeAddress(poolServer)
/** Returns the live connection count without retaining prior assertion narrowing. */
function observedPoolConnections(): number {
  return poolConnections
}
const poolClient = await transport.dial(background(), poolAddress)
/** Performs one complete unary pool probe. */
async function poolExchange(client: Awaited<ReturnType<typeof transport.dial>>): Promise<string> {
  await client.send(background(), { header: {}, body: new Uint8Array() })
  return decoder.decode((await client.recv(background())).body)
}
verify((await poolExchange(poolClient)) === "pool-1", "first pooled response changed")
verify((await poolExchange(poolClient)) === "pool-2", "second pooled response changed")
verify(
  observedPoolConnections() === 1,
  `HTTP/1 pool opened ${poolConnections} connections for two requests`
)
await poolClient.send(background(), { header: {}, body: new Uint8Array() })
const [poolCancelContext, cancelPoolReceive] = withCancel(background())
const canceledPoolReceive = poolClient.recv(poolCancelContext)
cancelPoolReceive()
await rejection(canceledPoolReceive)
await poolClient.send(background(), { header: {}, body: new Uint8Array() })
await rejection(poolClient.recv(background()))
verify((await poolExchange(poolClient)) === "pool-5", "pool recovery response changed")
verify(
  observedPoolConnections() === 3,
  `canceled and truncated responses left ${poolConnections} HTTP/1 connections`
)
await poolClient.close(background())
await bounded(
  (async function waitForPoolClose(): Promise<void> {
    while (poolSockets.size > 0) {
      await new Promise<void>(function wait(resolve): void {
        setTimeout(resolve, 1)
      })
    }
  })(),
  "HTTP/1 pool close retained a socket"
)
const closeClient = await transport.dial(background(), poolAddress, withConnClose())
verify((await poolExchange(closeClient)) === "pool-6", "first connection-close response changed")
verify((await poolExchange(closeClient)) === "pool-7", "second connection-close response changed")
verify(
  observedPoolConnections() === 5,
  `connection-close opened ${poolConnections - 3} connections for two requests`
)
verify(
  poolConnectionHeaders.slice(-2).every(function closed(value): boolean {
    return value === "close"
  }),
  "connection-close requests omitted their wire header"
)
await closeClient.close(background())
await new Promise<void>(function close(resolve, reject): void {
  poolServer.close(function closed(error?: Error): void {
    if (error === undefined) resolve()
    else reject(error)
  })
})
await provePortReleased(poolAddress)

const TypedRequest = struct.object({
  id: struct.bigint().alias("request_id"),
  requestedAt: struct.date().alias("requested_at")
})
const TypedResponse = struct.object({
  id: struct.bigint().alias("response_id"),
  processedAt: struct.date().alias("processed_at")
})
const typedContract = endpoint("typed-http", "Increment", TypedRequest, TypedResponse)
const typedServer = newServer(
  serverTransport(transport),
  serverAddress("127.0.0.1:0"),
  handler(typedContract, (_ctx, request) => ({
    id: request.id + 1n,
    processedAt: new Date(request.requestedAt.getTime() + 1_000)
  }))
)
const typedRunning = typedServer.start(background())
const typedAddress = await typedServer.endpoint(background())
const typedClient = newClient(withTransport(transport))
const requestedAt = new Date("2026-08-03T12:00:00.000Z")
const typedResult = await typedClient.call(
  background(),
  typedContract,
  { id: 41n, requestedAt },
  withAddress(typedAddress)
)
verify(typedResult.id === 42n, "typed HTTP bigint response changed")
verify(
  typedResult.processedAt.getTime() === requestedAt.getTime() + 1_000,
  "typed HTTP date response changed"
)
await typedClient.close(background())
await typedServer.stop(background())
await typedRunning
await provePortReleased(new URL(typedAddress).host)

await new Promise<void>(function settle(resolve): void {
  setTimeout(resolve, 20)
})
process.off("unhandledRejection", onUnhandled)
const finalTimeouts = process.getActiveResourcesInfo().filter((value) => value === "Timeout").length
const pendingTimers = finalTimeouts - baselineTimeouts
const unhandledListenerDelta =
  process.listenerCount("unhandledRejection") - baselineUnhandledListeners
verify(unhandledRejections.length === 0, "transport E2E published an unhandled rejection")
verify(pendingTimers === 0, `transport E2E leaked ${pendingTimers} timer(s)`)
verify(unhandledListenerDelta === 0, "transport E2E leaked an unhandledRejection listener")
