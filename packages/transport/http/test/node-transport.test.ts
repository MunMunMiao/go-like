import { readFileSync } from "node:fs"
import { createServer as createHTTPServer } from "node:http"
import { createSecureServer } from "node:http2"
import { createServer as createTCPServer, type Socket } from "node:net"
import { TLSSocket } from "node:tls"

import { expect, test } from "bun:test"

import { background, withCancel } from "@go-like/context"
import {
  logger,
  secure,
  tlsConfig,
  withConnClose,
  type ListenOption,
  type ListenOptions,
  type TLSEncodedBytes,
  type TLSConfig
} from "@go-like/transport"

import { allowHTTP1, clientAuth, newNodeHTTPTransport } from "../src/node"
import { executeNodeHTTP1, nodeHTTP1RequestOptions } from "../src/node-client"
import { applyHTTPDialOptions, executor } from "../src/options"
import { newHTTPTransportWithDialExecutor } from "../src/transport"
import type { HTTPExecutor, HTTPListener } from "../src/types"

const ca = readFileSync(new URL("fixtures/tls/ca.pem", import.meta.url))
const serverCertificate = readFileSync(new URL("fixtures/tls/server.pem", import.meta.url))
const serverKey = readFileSync(new URL("fixtures/tls/server-key.pem", import.meta.url))
const clientCertificate = readFileSync(new URL("fixtures/tls/client.pem", import.meta.url))
const clientKey = readFileSync(new URL("fixtures/tls/client-key.pem", import.meta.url))

/** Creates one detached PEM transport value. */
function pem(bytes: Uint8Array): TLSEncodedBytes {
  return Object.freeze({ encoding: "pem", bytes: new Uint8Array(bytes) })
}

/** Creates the verified client trust and mTLS identity used by loopback tests. */
function clientTLS(): TLSConfig {
  return Object.freeze({
    serverName: "localhost",
    caCertificate: pem(ca),
    certificateChain: pem(clientCertificate),
    privateKey: pem(clientKey)
  })
}

/** Copies bytes into an ArrayBuffer Fetch accepts as a body. */
function copied(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  return copy
}

/** Builds one POST on the dial origin. */
function posted(
  address: string,
  body: Uint8Array | string | null = null,
  secureDial = false
): Request {
  const init: RequestInit = { method: "POST" }
  if (typeof body === "string") init.body = body
  else if (body !== null && body.byteLength > 0) init.body = copied(body)
  const base = address.includes("://") ? address : `${secureDial ? "https" : "http"}://${address}`
  return new Request(new URL("/echo/call", base.endsWith("/") ? base : `${base}/`), init)
}

/** Returns one Promise rejection without imposing runtime-specific Error branding. */
async function rejection(work: Promise<unknown>): Promise<unknown> {
  try {
    await work
    return null
  } catch (error) {
    return error
  }
}

/** Returns the actual port from one listening Node server. */
function listeningPort(server: { address(): unknown }): number {
  const address = server.address()
  if (typeof address !== "object" || address === null || !("port" in address)) {
    throw new Error("test server omitted its bound port")
  }
  const port = address.port
  if (typeof port !== "number") throw new Error("test server returned an invalid port")
  return port
}

test("Node transport performs a real listen, dial, exchange, and close", async () => {
  const transport = newNodeHTTPTransport()
  let listenOptionCalls = 0
  const listenOption: ListenOption = function preserve<T extends ListenOptions>(options: T): T {
    listenOptionCalls += 1
    return options
  }
  const failures: unknown[] = []
  transport.init(
    logger({
      log(_level, _message, fields): void {
        failures.push(fields?.cause)
      }
    })
  )
  expect(transport.kind?.()).toBe("http")
  expect(transport.options().logger).not.toBeNull()
  expect(transport.string()).toBe("http")
  const listener = (await transport.listen(
    background(),
    "127.0.0.1:0",
    listenOption
  )) as HTTPListener
  expect(listenOptionCalls).toBe(1)
  const serving = listener.serve(background(), function echo(_ctx, request): Response {
    return new Response(request.body)
  })
  await listener.accepted()

  const client = await transport.dial(background(), listener.addr())
  let response: Response
  try {
    response = await client.fetch(background(), posted(listener.addr(), new Uint8Array([1, 2, 3])))
  } catch (error) {
    throw failures[0] ?? error
  }
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))

  await client.close(background())
  await listener.close(background())
  await serving
})

test("Node client close wins the public send body-read microtask", async () => {
  let requests = 0
  const server = createHTTPServer(function respond(request, response): void {
    requests += 1
    request.resume()
    request.once("end", function ended(): void {
      response.end()
    })
  })
  await new Promise<void>(function listen(resolve, reject): void {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  try {
    const client = await newNodeHTTPTransport().dial(
      background(),
      `127.0.0.1:${listeningPort(server)}`
    )
    const sending = rejection(
      client.fetch(
        background(),
        new Request(`http://127.0.0.1:${listeningPort(server)}/echo/call`, {
          method: "POST",
          body: new ReadableStream<Uint8Array>({
            pull(): void {}
          })
        })
      )
    )
    await Promise.resolve()
    await client.close(background())
    expect(await sending).toMatchObject({ code: "GO_LIKE_TRANSPORT_CLOSED" })
    await new Promise<void>(function observeLateAdmission(resolve): void {
      setTimeout(resolve, 50)
    })
    expect(requests).toBe(0)
  } finally {
    server.closeAllConnections()
    if (server.listening) {
      await new Promise<void>(function close(resolve, reject): void {
        server.close(function closed(error?: Error): void {
          if (error === undefined) resolve()
          else reject(error)
        })
      })
    }
  }
})

test("Node client close still terminates a request already admitted by the server", async () => {
  let requests = 0
  let admit = function pending(): void {}
  const admitted = new Promise<void>(function capture(resolve): void {
    admit = resolve
  })
  const server = createHTTPServer(function hold(request, response): void {
    requests += 1
    request.resume()
    response.on("error", function expected(): void {})
    admit()
  })
  await new Promise<void>(function listen(resolve, reject): void {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  try {
    const client = await newNodeHTTPTransport().dial(
      background(),
      `127.0.0.1:${listeningPort(server)}`
    )
    const sending = client.fetch(
      background(),
      posted(`127.0.0.1:${listeningPort(server)}`, new Uint8Array([1]))
    )
    await admitted
    await client.close(background())
    expect(await rejection(sending)).toMatchObject({ code: "GO_LIKE_TRANSPORT_CLOSED" })
    expect(requests).toBe(1)
  } finally {
    server.closeAllConnections()
    if (server.listening) {
      await new Promise<void>(function close(resolve, reject): void {
        server.close(function closed(error?: Error): void {
          if (error === undefined) resolve()
          else reject(error)
        })
      })
    }
  }
})

test("Node transport applies public server policy through its only constructor", async () => {
  expect(() => allowHTTP1(null as never)).toThrow(TypeError)
  expect(() => clientAuth("optional" as never)).toThrow(TypeError)

  const transport = newNodeHTTPTransport(clientAuth("require"), allowHTTP1(false))
  await expect(transport.listen(background(), "127.0.0.1:0")).rejects.toThrow(
    "client authentication requires TLS"
  )
})

test("Node transport preserves an explicitly injected Fetch executor", async () => {
  const requests: Request[] = []
  const injected: HTTPExecutor = async function execute(input, init): Promise<Response> {
    requests.push(new Request(input, init))
    return new Response("injected")
  }
  const transport = newNodeHTTPTransport(executor(injected))
  const client = await transport.dial(background(), "127.0.0.1:1")

  const response = await client.fetch(background(), posted("127.0.0.1:1", "request"))
  expect(await response.text()).toBe("injected")
  expect(requests).toHaveLength(1)
  expect(await requests[0]?.text()).toBe("request")
  await client.close(background())
})

test("Node custom executor rejects native-only dial capabilities before I/O", async () => {
  let executorCalls = 0
  const injected: HTTPExecutor = function execute(): Promise<Response> {
    executorCalls += 1
    return Promise.resolve(new Response())
  }
  const transport = newNodeHTTPTransport(executor(injected))
  await expect(transport.dial(background(), "127.0.0.1:1", withConnClose())).rejects.toMatchObject({
    code: "GO_LIKE_TRANSPORT_UNSUPPORTED_CAPABILITY",
    message: "standard Fetch cannot force connection close"
  })

  transport.init(tlsConfig(clientTLS()))
  await expect(transport.dial(background(), "127.0.0.1:1")).rejects.toMatchObject({
    code: "GO_LIKE_TRANSPORT_UNSUPPORTED_CAPABILITY",
    message: "standard Fetch cannot use custom TLS material"
  })
  expect(executorCalls).toBe(0)
})

test("Node client performs verified mTLS over negotiated HTTP/2", async () => {
  let protocol = ""
  const server = createSecureServer(
    {
      allowHTTP1: true,
      ca,
      cert: serverCertificate,
      key: serverKey,
      requestCert: true,
      rejectUnauthorized: true
    },
    function echo(request, response): void {
      protocol = request.httpVersion
      const chunks: Buffer[] = []
      request.on("data", function received(chunk: Buffer): void {
        chunks.push(chunk)
      })
      request.once("end", function ended(): void {
        response.writeHead(200, {
          "Go-Like-Reply": protocol,
          "Set-Cookie": ["first=1", "second=2"]
        })
        response.end(Buffer.concat(chunks))
      })
    }
  )
  await new Promise<void>(function listen(resolve, reject): void {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  try {
    const transport = newNodeHTTPTransport()
    transport.init(secure(true), tlsConfig(clientTLS()))
    const client = await transport.dial(background(), `127.0.0.1:${listeningPort(server)}`)
    const address = `127.0.0.1:${listeningPort(server)}`
    const response = await client.fetch(background(), posted(address, "mtls-h2", true))
    expect(await response.text()).toBe("mtls-h2")
    expect(response.headers.get("go-like-reply")).toBe("2.0")
    expect(protocol).toBe("2.0")
    const reused = await client.fetch(background(), posted(address, "mtls-h2-reused", true))
    expect(await reused.text()).toBe("mtls-h2-reused")
    await client.close(background())
  } finally {
    await new Promise<void>(function close(resolve, reject): void {
      server.close(function closed(error?: Error): void {
        if (error === undefined) resolve()
        else reject(error)
      })
    })
  }
})

test("Node HTTP/1 options reuse the already verified TLS socket", () => {
  const socket: TLSSocket = Object.create(TLSSocket.prototype)
  const request = new Request("https://localhost/internal/call?version=1", {
    method: "POST"
  })
  const options = nodeHTTP1RequestOptions(request, { connection: "close" }, socket)
  const createConnection = options.createConnection
  if (createConnection === undefined) throw new Error("TLS request omitted its socket factory")
  expect(options.agent).toBeUndefined()
  expect(options.hostname).toBe("localhost")
  expect(options.port).toBe(443)
  expect(options.path).toBe("/internal/call?version=1")
  expect(createConnection({}, function unused(): void {})).toBe(socket)
})

test("Node HTTP/1 admission failure destroys its verified TLS socket", async () => {
  let destroyed = false
  let requestDestroyed = false
  const socket: TLSSocket = Object.create(TLSSocket.prototype)
  Object.defineProperties(socket, {
    destroyed: {
      get(): boolean {
        return destroyed
      }
    },
    destroy: {
      value(): TLSSocket {
        destroyed = true
        return socket
      }
    }
  })
  const failure = new Error("native request rejected")
  const exchange = executeNodeHTTP1(
    new Request("https://localhost/internal/call", { method: "POST" }),
    new Uint8Array([1]),
    applyHTTPDialOptions([]),
    socket,
    function rejectRequest() {
      return {
        get destroyed(): boolean {
          return requestDestroyed
        },
        once(_event, listener): void {
          listener(failure)
        },
        end(_body): void {},
        destroy(): void {
          requestDestroyed = true
        }
      }
    }
  )
  expect(await rejection(exchange)).toBe(failure)
  expect(destroyed).toBeTrue()
  expect(requestDestroyed).toBeTrue()
})

test("Node client owns plaintext body cancellation and premature close", async () => {
  let requests = 0
  let truncate = function pending(): void {}
  const server = createHTTPServer(function respond(_request, response): void {
    requests += 1
    response.on("error", function expected(): void {})
    if (requests === 1) {
      response.writeHead(200)
      response.write("pending")
      return
    }
    response.writeHead(200)
    response.flushHeaders()
    truncate = function closeEarly(): void {
      response.destroy(new Error("truncated"))
    }
  })
  await new Promise<void>(function listen(resolve, reject): void {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  try {
    const transport = newNodeHTTPTransport()
    const address = `127.0.0.1:${listeningPort(server)}`
    const pending = await transport.dial(background(), address, withConnClose())
    const [ctx, cancel] = withCancel(background())
    const pendingResponse = await pending.fetch(ctx, posted(address))
    setImmediate(cancel)
    expect(await rejection(pendingResponse.arrayBuffer())).not.toBeNull()
    await pending.close(background())

    const truncated = await transport.dial(background(), address, withConnClose())
    const truncatedResponse = await truncated.fetch(background(), posted(address))
    truncate()
    expect(await rejection(truncatedResponse.arrayBuffer())).not.toBeNull()
    await truncated.close(background())
  } finally {
    server.closeAllConnections()
    if (server.listening) {
      await new Promise<void>(function close(resolve, reject): void {
        server.close(function closed(error?: Error): void {
          if (error === undefined) resolve()
          else reject(error)
        })
      })
    }
  }
})

test("Node client releases an unshared stalled TLS handshake after caller cancellation", async () => {
  let connections = 0
  let admitFirst: ((socket: Socket) => void) | null = null
  let admitSecond: ((socket: Socket) => void) | null = null
  const firstAccepted = new Promise<Socket>(function capture(resolve): void {
    admitFirst = resolve
  })
  const secondAccepted = new Promise<Socket>(function capture(resolve): void {
    admitSecond = resolve
  })
  const server = createTCPServer(function hold(socket): void {
    connections += 1
    socket.on("error", function expected(): void {})
    socket.resume()
    if (connections === 1) admitFirst?.(socket)
    else admitSecond?.(socket)
  })
  await new Promise<void>(function listen(resolve, reject): void {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  try {
    const transport = newNodeHTTPTransport()
    const address = `https://127.0.0.1:${listeningPort(server)}`
    const client = await transport.dial(background(), address)
    const [ctx, cancel] = withCancel(background())
    const sending = client.fetch(ctx, posted(address))
    const firstSocket = await firstAccepted
    const firstClosed = new Promise<void>(function observe(resolve): void {
      firstSocket.once("close", resolve)
    })
    cancel()
    expect(await rejection(sending)).not.toBeNull()
    await firstClosed

    const [retryContext, cancelRetry] = withCancel(background())
    const retry = client.fetch(retryContext, posted(address))
    const secondSocket = await secondAccepted
    const secondClosed = new Promise<void>(function observe(resolve): void {
      secondSocket.once("close", resolve)
    })
    cancelRetry()
    expect(await rejection(retry)).not.toBeNull()
    await secondClosed
    expect(connections).toBe(2)
    await client.close(background())
  } finally {
    await new Promise<void>(function close(resolve, reject): void {
      server.close(function closed(error?: Error): void {
        if (error === undefined) resolve()
        else reject(error)
      })
    })
  }
})

test("Node client releases an HTTP/2 session canceled before response headers", async () => {
  let admit = function pending(): void {}
  const admitted = new Promise<void>(function capture(resolve): void {
    admit = resolve
  })
  const server = createSecureServer({
    allowHTTP1: false,
    ca,
    cert: serverCertificate,
    key: serverKey,
    requestCert: true,
    rejectUnauthorized: true
  })
  server.on("stream", function hold(stream): void {
    stream.on("error", function expected(): void {})
    admit()
  })
  await new Promise<void>(function listen(resolve, reject): void {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  try {
    const transport = newNodeHTTPTransport()
    transport.init(secure(true), tlsConfig(clientTLS()))
    const address = `127.0.0.1:${listeningPort(server)}`
    const client = await transport.dial(background(), address)
    const [ctx, cancel] = withCancel(background())
    const sending = client.fetch(ctx, posted(address, null, true))
    await admitted
    cancel()
    expect(await rejection(sending)).not.toBeNull()
    await client.close(background())
  } finally {
    await new Promise<void>(function close(resolve, reject): void {
      server.close(function closed(error?: Error): void {
        if (error === undefined) resolve()
        else reject(error)
      })
    })
  }
})

test("runtime dial seam rejects a non-callable executor before client publication", async () => {
  const invalidFactory = function invalid(): never {
    return null as never
  }
  const transport = newHTTPTransportWithDialExecutor(invalidFactory)
  await expect(transport.dial(background(), "127.0.0.1:1")).rejects.toThrow(
    "must return an executor owner"
  )
})

test("runtime dial owner preserves a synchronous close failure", async () => {
  const failure = new Error("runtime owner close failed")
  const transport = newHTTPTransportWithDialExecutor(function owner() {
    return Object.freeze({
      executor(): Promise<Response> {
        return Promise.resolve(new Response())
      },
      close(): Promise<void> {
        throw failure
      }
    })
  })
  const client = await transport.dial(background(), "127.0.0.1:1")
  await expect(client.close(background())).rejects.toBe(failure)
  await expect(client.close(background())).rejects.toBe(failure)
})

test("Node client rejects invalid TLS identity material before network I/O", async () => {
  const transport = newNodeHTTPTransport()
  transport.init(
    secure(true),
    tlsConfig({
      serverName: "localhost",
      caCertificate: pem(ca),
      certificateChain: pem(clientCertificate),
      privateKey: null
    })
  )
  const client = await transport.dial(background(), "127.0.0.1:1")
  await expect(client.fetch(background(), posted("127.0.0.1:1", null, true))).rejects.toThrow(
    "requires both"
  )
  await client.close(background())

  const der = newNodeHTTPTransport()
  der.init(
    secure(true),
    tlsConfig({
      serverName: "localhost",
      caCertificate: {
        encoding: "der",
        bytes: new Uint8Array(ca)
      },
      certificateChain: null,
      privateKey: null
    })
  )
  const derClient = await der.dial(background(), "127.0.0.1:1")
  await expect(derClient.fetch(background(), posted("127.0.0.1:1", null, true))).rejects.toThrow(
    "must use PEM"
  )
  await derClient.close(background())
})

test("runtime dial owner preserves buffered capability getter failures", async () => {
  const failure = new Error("buffered getter failed")
  let closes = 0
  const throwing = newHTTPTransportWithDialExecutor(function owner() {
    return {
      executor(): Promise<Response> {
        return Promise.resolve(new Response())
      },
      get executeBuffered(): never {
        throw failure
      },
      close(): Promise<void> {
        closes += 1
        return Promise.resolve()
      }
    }
  })
  let published: Awaited<ReturnType<(typeof throwing)["dial"]>> | null = null
  let thrown: unknown = null
  try {
    published = await throwing.dial(background(), "127.0.0.1:1")
  } catch (error) {
    thrown = error
  }
  if (published !== null) await published.close(background())
  expect(thrown).toBe(failure)
  expect(closes).toBe(0)

  const raw = newHTTPTransportWithDialExecutor(function owner() {
    return {
      executor(): Promise<Response> {
        return Promise.resolve(new Response())
      },
      get executeBuffered(): never {
        throw "buffered getter failed"
      },
      close(): Promise<void> {
        return Promise.resolve()
      }
    }
  })
  let rawClient: Awaited<ReturnType<(typeof raw)["dial"]>> | null = null
  let rawFailure: unknown = null
  try {
    rawClient = await raw.dial(background(), "127.0.0.1:1")
  } catch (error) {
    rawFailure = error
  }
  if (rawClient !== null) await rawClient.close(background())
  expect(rawFailure).toBe("buffered getter failed")
})

test("runtime dial owner without buffered capability keeps the standard request body", async () => {
  const requests: Request[] = []
  const transport = newHTTPTransportWithDialExecutor(function owner() {
    const handle = {
      executor(input: RequestInfo | URL): Promise<Response> {
        requests.push(input instanceof Request ? input : new Request(input))
        return Promise.resolve(new Response("ok"))
      },
      close(): Promise<void> {
        return Promise.resolve()
      }
    }
    Object.defineProperty(handle, "executeBuffered", { value: undefined })
    return handle
  })
  const client = await transport.dial(background(), "127.0.0.1:1")
  const response = await client.fetch(background(), posted("127.0.0.1:1", "hello"))
  expect(await response.text()).toBe("ok")
  expect(requests).toHaveLength(1)
  expect(await requests[0]?.text()).toBe("hello")
  await client.close(background())
})

test("runtime dial owner preserves request construction failures for buffered execution", async () => {
  const NativeRequest = globalThis.Request
  const rejected = new Error("rejected request")
  let requestMode: "error" | "raw" = "error"
  let standardCalls = 0
  let bufferedCalls = 0
  globalThis.Request = class ThrowingRequest extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      if (init?.redirect === "manual") {
        if (requestMode === "error") throw rejected
        throw "rejected request"
      }
      super(input, init)
    }
  }
  try {
    const transport = newHTTPTransportWithDialExecutor(function owner() {
      return {
        executor(): Promise<Response> {
          standardCalls += 1
          return Promise.resolve(new Response())
        },
        executeBuffered(): Promise<Response> {
          bufferedCalls += 1
          return Promise.resolve(new Response())
        },
        close(): Promise<void> {
          return Promise.resolve()
        }
      }
    })
    const client = await transport.dial(background(), "127.0.0.1:1")
    try {
      const errorFailure = await rejection(
        client.fetch(
          background(),
          new Request("http://127.0.0.1:1/echo/call", { method: "POST", body: "x" })
        )
      )
      expect(errorFailure).toMatchObject({
        code: "GO_LIKE_TRANSPORT_PROTOCOL",
        message: "invalid HTTP Fetch request"
      })
      expect(Reflect.get(errorFailure as object, "cause")).toBe(rejected)
      requestMode = "raw"
      const rawFailure = await rejection(
        client.fetch(
          background(),
          new Request("http://127.0.0.1:1/echo/call", { method: "POST", body: "x" })
        )
      )
      expect(rawFailure).toMatchObject({
        code: "GO_LIKE_TRANSPORT_PROTOCOL",
        message: "invalid HTTP Fetch request"
      })
      expect(Reflect.get(rawFailure as object, "cause")).toBeUndefined()
      expect(standardCalls).toBe(0)
      expect(bufferedCalls).toBe(0)
    } finally {
      await client.close(background())
    }
  } finally {
    globalThis.Request = NativeRequest
  }
})

test("runtime dial owner does not start execution when the request aborts during the body read", async () => {
  let releaseBody = function pending(): void {}
  let markStarted = function pending(): void {}
  const started = new Promise<void>(function capture(resolve): void {
    markStarted = resolve
  })
  const gate = new Promise<void>(function capture(resolve): void {
    releaseBody = resolve
  })
  let standardCalls = 0
  let bufferedCalls = 0
  const transport = newHTTPTransportWithDialExecutor(function owner() {
    return {
      executor(): Promise<Response> {
        standardCalls += 1
        return Promise.resolve(new Response())
      },
      executeBuffered(): Promise<Response> {
        bufferedCalls += 1
        return Promise.resolve(new Response())
      },
      close(): Promise<void> {
        return Promise.resolve()
      }
    }
  })
  const client = await transport.dial(background(), "127.0.0.1:1")
  const controller = new AbortController()
  const reason = new Error("abort during read")
  const fetching = client.fetch(
    background(),
    new Request("http://127.0.0.1:1/echo/call", {
      method: "POST",
      signal: controller.signal,
      body: new ReadableStream<Uint8Array>({
        async pull(stream): Promise<void> {
          markStarted()
          await gate
          stream.enqueue(new Uint8Array([1]))
          stream.close()
        }
      })
    })
  )
  try {
    await started
    controller.abort(reason)
    expect(await rejection(fetching)).toBe(reason)
    expect(standardCalls).toBe(0)
    expect(bufferedCalls).toBe(0)
  } finally {
    releaseBody()
    await client.close(background())
  }
})

test("runtime dial owner selects buffered execution after the bounded request read", async () => {
  const original = new Uint8Array([1, 2, 3])
  const caller = new AbortController()
  let releaseBody = function pending(): void {}
  let markStarted = function pending(): void {}
  const started = new Promise<void>(function capture(resolve): void {
    markStarted = resolve
  })
  const gate = new Promise<void>(function capture(resolve): void {
    releaseBody = resolve
  })
  let reads = 0
  let bufferedCalls = 0
  let executorCalls = 0
  let replacedCalls = 0
  let phase: "original" | "replaced" = "original"
  let sent: Request | null = null
  const transport = newHTTPTransportWithDialExecutor(function factory() {
    const record = {
      executor(): Promise<Response> {
        executorCalls += 1
        return Promise.resolve(new Response("standard"))
      },
      get executeBuffered(): (request: Request, body: Uint8Array | null) => Promise<Response> {
        reads += 1
        if (phase === "replaced") {
          return function replaced(): Promise<Response> {
            replacedCalls += 1
            return Promise.resolve(new Response("replaced"))
          }
        }
        return function executeBuffered(
          this: object,
          request: Request,
          body: Uint8Array | null
        ): Promise<Response> {
          bufferedCalls += 1
          expect(this).toBe(record)
          sent?.headers.set("X-Topic", "mutated")
          original.fill(9)
          expect(request.method).toBe("POST")
          expect(request.url).toBe("http://127.0.0.1:1/echo/call")
          expect(request.redirect).toBe("manual")
          expect(request.body).toBeNull()
          expect(request.signal).not.toBe(caller.signal)
          expect(request.headers.get("x-topic")).toBe("greeting")
          expect(request.headers.get("connection")).toBeNull()
          expect(request.headers.get("host")).toBeNull()
          expect(body).toEqual(new Uint8Array([1, 2, 3]))
          expect(body).not.toBe(original)
          return Promise.resolve(new Response("buffered"))
        }
      },
      close(): Promise<void> {
        return Promise.resolve()
      }
    }
    return record
  })
  const client = await transport.dial(background(), "127.0.0.1:1")
  phase = "replaced"
  expect(reads).toBe(1)
  sent = new Request("http://127.0.0.1:1/echo/call", {
    method: "POST",
    headers: { "X-Topic": "greeting", Connection: "close", Host: "evil.test" },
    signal: caller.signal,
    body: new ReadableStream<Uint8Array>({
      async pull(stream): Promise<void> {
        markStarted()
        await gate
        stream.enqueue(original)
        stream.close()
      }
    })
  })
  const fetching = client.fetch(background(), sent)
  try {
    await started
    expect(bufferedCalls).toBe(0)
    expect(executorCalls).toBe(0)
    releaseBody()
    const response = await fetching
    expect(await response.text()).toBe("buffered")
    expect(bufferedCalls).toBe(1)
    expect(executorCalls).toBe(0)
    expect(replacedCalls).toBe(0)
    expect(reads).toBe(1)
  } finally {
    releaseBody()
    await client.close(background())
  }
})

test("runtime dial owner distinguishes a null body from an empty buffered body", async () => {
  const bodies: Array<Uint8Array | null> = []
  let executorCalls = 0
  const transport = newHTTPTransportWithDialExecutor(function owner() {
    return {
      executor(): Promise<Response> {
        executorCalls += 1
        return Promise.resolve(new Response())
      },
      executeBuffered(_request: Request, body: Uint8Array | null): Promise<Response> {
        bodies.push(body)
        return Promise.resolve(new Response(null))
      },
      close(): Promise<void> {
        return Promise.resolve()
      }
    }
  })
  const client = await transport.dial(background(), "127.0.0.1:1")
  try {
    await client.fetch(
      background(),
      new Request("http://127.0.0.1:1/echo/call", { method: "POST" })
    )
    await client.fetch(
      background(),
      new Request("http://127.0.0.1:1/echo/call", {
        method: "POST",
        body: new ReadableStream<Uint8Array>({
          start(stream): void {
            stream.close()
          }
        })
      })
    )
    expect(bodies).toHaveLength(2)
    expect(bodies[0]).toBeNull()
    expect(bodies[1]).toBeInstanceOf(Uint8Array)
    expect(bodies[1]).not.toBeNull()
    expect(bodies[1]?.byteLength).toBe(0)
    expect(executorCalls).toBe(0)
  } finally {
    await client.close(background())
  }
})

test("runtime dial owner preserves a synchronous buffered executor failure", async () => {
  const failure = new Error("buffered executor threw")
  let executorCalls = 0
  const transport = newHTTPTransportWithDialExecutor(function owner() {
    return {
      executor(): Promise<Response> {
        executorCalls += 1
        return Promise.resolve(new Response("standard"))
      },
      executeBuffered(): Promise<Response> {
        throw failure
      },
      close(): Promise<void> {
        return Promise.resolve()
      }
    }
  })
  const client = await transport.dial(background(), "127.0.0.1:1")
  try {
    expect(await rejection(client.fetch(background(), posted("127.0.0.1:1", "x")))).toBe(failure)
    expect(executorCalls).toBe(0)
  } finally {
    await client.close(background())
  }
})

test("runtime dial owner keeps GET and HEAD bodies on the standard executor", async () => {
  const calls: Array<{
    kind: "standard" | "buffered"
    method: string
    body: Uint8Array | null
  }> = []
  const transport = newHTTPTransportWithDialExecutor(function owner() {
    return {
      async executor(input: RequestInfo | URL): Promise<Response> {
        const request = input instanceof Request ? input : new Request(input)
        calls.push({
          kind: "standard",
          method: request.method,
          body: new Uint8Array(await request.arrayBuffer())
        })
        return new Response(null)
      },
      executeBuffered(request: Request, body: Uint8Array | null): Promise<Response> {
        calls.push({ kind: "buffered", method: request.method, body })
        return Promise.resolve(new Response(null))
      },
      close(): Promise<void> {
        return Promise.resolve()
      }
    }
  })
  const client = await transport.dial(background(), "127.0.0.1:1")
  /** Sends one request whose method and body are whatever the runtime stored. */
  async function send(request: Request): Promise<void> {
    await client.fetch(background(), request)
  }
  /** Attaches one method and byte stream without using a forbidden Fetch init. */
  function withMethodBody(method: string, bytes: Uint8Array): Request {
    const request = new Request("http://127.0.0.1:1/echo/call")
    Object.defineProperties(request, {
      method: { value: method },
      body: {
        value: new ReadableStream<Uint8Array>({
          start(stream): void {
            if (bytes.byteLength > 0) stream.enqueue(bytes)
            stream.close()
          }
        })
      }
    })
    return request
  }
  try {
    const lowercase = withMethodBody("get", new Uint8Array([1]))
    const head = withMethodBody("head", new Uint8Array([2]))
    expect(lowercase.method).toBe("get")
    expect(head.method).toBe("head")
    await send(withMethodBody("GET", new Uint8Array([65])))
    await send(withMethodBody("HEAD", new Uint8Array(0)))
    await send(lowercase)
    await send(head)
    expect(calls).toEqual([
      { kind: "standard", method: "GET", body: new Uint8Array([65]) },
      { kind: "standard", method: "HEAD", body: new Uint8Array(0) },
      { kind: "standard", method: "GET", body: new Uint8Array([1]) },
      { kind: "standard", method: "HEAD", body: new Uint8Array([2]) }
    ])

    calls.length = 0
    await send(new Request("http://127.0.0.1:1/echo/call", { method: "GET" }))
    await send(new Request("http://127.0.0.1:1/echo/call", { method: "HEAD" }))
    expect(calls).toEqual([
      { kind: "buffered", method: "GET", body: null },
      { kind: "buffered", method: "HEAD", body: null }
    ])
  } finally {
    await client.close(background())
  }
})

test("runtime dial owner rejects non-callable buffered capabilities", async () => {
  for (const value of [null, 1, false, "buffered", { not: "callable" }]) {
    let closes = 0
    let executorCalls = 0
    const transport = newHTTPTransportWithDialExecutor(function owner() {
      return {
        executor(): Promise<Response> {
          executorCalls += 1
          return Promise.resolve(new Response())
        },
        executeBuffered: value as never,
        close(): Promise<void> {
          closes += 1
          return Promise.resolve()
        }
      }
    })
    let client: Awaited<ReturnType<(typeof transport)["dial"]>> | null = null
    let failure: unknown = null
    try {
      client = await transport.dial(background(), "127.0.0.1:1")
    } catch (error) {
      failure = error
    }
    if (client !== null) await client.close(background())
    expect(failure).toBeInstanceOf(TypeError)
    expect((failure as TypeError).message).toBe(
      "HTTP dial executor executeBuffered must be a function"
    )
    expect(closes).toBe(0)
    expect(executorCalls).toBe(0)
  }
})
