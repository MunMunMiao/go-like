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
  type Message,
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

/** Decodes one transport body for readable wire assertions. */
function text(message: Message): string {
  return new TextDecoder().decode(message.body)
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
  const serving = listener.accept(background(), async (ctx, socket) => {
    const request = await socket.recv(ctx)
    await socket.send(ctx, { header: {}, body: request.body })
  })
  await listener.accepted()

  const client = await transport.dial(background(), listener.addr())
  await client.send(background(), {
    header: { "Go-Like-Service": "echo", "Go-Like-Endpoint": "call" },
    body: new Uint8Array([1, 2, 3])
  })
  let response
  try {
    response = await client.recv(background())
  } catch (error) {
    throw failures[0] ?? error
  }
  expect(response.body).toEqual(new Uint8Array([1, 2, 3]))

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
    const sending = rejection(client.send(background(), { header: {}, body: new Uint8Array([1]) }))
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
    const sending = client.send(background(), { header: {}, body: new Uint8Array([1]) })
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

  await client.send(background(), {
    header: { "Go-Like-Service": "echo", "Go-Like-Endpoint": "call" },
    body: new TextEncoder().encode("request")
  })
  expect(text(await client.recv(background()))).toBe("injected")
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
    await client.send(background(), {
      header: { "Go-Like-Service": "echo", "Go-Like-Endpoint": "call" },
      body: new TextEncoder().encode("mtls-h2")
    })
    const response = await client.recv(background())
    expect(text(response)).toBe("mtls-h2")
    expect(response.header["go-like-reply"]).toBe("2.0")
    expect(protocol).toBe("2.0")
    await client.send(background(), {
      header: { "Go-Like-Service": "echo", "Go-Like-Endpoint": "call" },
      body: new TextEncoder().encode("mtls-h2-reused")
    })
    expect(text(await client.recv(background()))).toBe("mtls-h2-reused")
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
    const pending = await transport.dial(
      background(),
      `127.0.0.1:${listeningPort(server)}`,
      withConnClose()
    )
    await pending.send(background(), { header: {}, body: new Uint8Array() })
    const [ctx, cancel] = withCancel(background())
    const receiving = pending.recv(ctx)
    setImmediate(cancel)
    expect(await rejection(receiving)).not.toBeNull()
    await pending.close(background())

    const truncated = await transport.dial(
      background(),
      `127.0.0.1:${listeningPort(server)}`,
      withConnClose()
    )
    await truncated.send(background(), { header: {}, body: new Uint8Array() })
    truncate()
    expect(await rejection(truncated.recv(background()))).not.toBeNull()
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
    if (connections === 1) admitFirst?.(socket)
    else admitSecond?.(socket)
  })
  await new Promise<void>(function listen(resolve, reject): void {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  try {
    const transport = newNodeHTTPTransport()
    const client = await transport.dial(background(), `https://127.0.0.1:${listeningPort(server)}`)
    const [ctx, cancel] = withCancel(background())
    const sending = client.send(ctx, { header: {}, body: new Uint8Array() })
    const firstSocket = await firstAccepted
    const firstClosed = new Promise<void>(function observe(resolve): void {
      firstSocket.once("close", resolve)
    })
    cancel()
    expect(await rejection(sending)).not.toBeNull()
    await firstClosed

    const [retryContext, cancelRetry] = withCancel(background())
    const retry = client.send(retryContext, { header: {}, body: new Uint8Array() })
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
    const client = await transport.dial(background(), `127.0.0.1:${listeningPort(server)}`)
    const [ctx, cancel] = withCancel(background())
    const sending = client.send(ctx, { header: {}, body: new Uint8Array() })
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
  await expect(client.send(background(), { header: {}, body: new Uint8Array() })).rejects.toThrow(
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
  await expect(
    derClient.send(background(), { header: {}, body: new Uint8Array() })
  ).rejects.toThrow("must use PEM")
  await derClient.close(background())
})
