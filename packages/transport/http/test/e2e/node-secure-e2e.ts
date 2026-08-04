import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import {
  connect,
  constants as http2Constants,
  createSecureServer,
  type ClientHttp2Session,
  type ServerHttp2Session
} from "node:http2"
import { createServer as createHTTPSServer, request as httpsRequest } from "node:https"
import { TLSSocket } from "node:tls"

import { background } from "@go-like/context"
import {
  secure,
  tlsConfig as withTLSConfig,
  withConnClose,
  type TLSConfig,
  type TLSEncodedBytes
} from "@go-like/transport"
import { allowHTTP1, clientAuth, newNodeHTTPTransport } from "@go-like/transport-http/node"
import { normalizeHTTPDialTarget } from "../../src/address"
import { newNodeHTTPExecutor } from "../../src/node-client"
import {
  applyHTTPCommonOptions,
  applyHTTPDialOptions,
  defaultHTTPCommonOptions
} from "../../src/options"

interface HTTP2Reply {
  readonly body: string
  readonly protocol: string
  readonly status: number
}

const tlsRoot =
  process.env.GO_LIKE_TRANSPORT_HTTP_TLS_E2E_ROOT ??
  new URL("../fixtures/tls/", import.meta.url).href
const ca = await readFile(new URL("ca.pem", tlsRoot))
const serverCertificate = await readFile(new URL("server.pem", tlsRoot))
const serverKey = await readFile(new URL("server-key.pem", tlsRoot))
const clientCertificate = await readFile(new URL("client.pem", tlsRoot))
const clientKey = await readFile(new URL("client-key.pem", tlsRoot))

/** Throws one stable E2E assertion failure. */
function verify(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/** Bounds one E2E operation so native resource failures cannot hang the runner. */
async function bounded<T>(operation: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>(function wait(_resolve, reject): void {
    timer = setTimeout(function expired(): void {
      reject(new Error(message))
    }, 2_000)
  })
  try {
    return await Promise.race([operation, timeout])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/** Creates one detached PEM transport value. */
function pem(bytes: Uint8Array): TLSEncodedBytes {
  return Object.freeze({ encoding: "pem", bytes: new Uint8Array(bytes) })
}

const tlsConfig: TLSConfig = Object.freeze({
  serverName: null,
  caCertificate: pem(ca),
  certificateChain: pem(serverCertificate),
  privateKey: pem(serverKey)
})
const clientTLSConfig: TLSConfig = Object.freeze({
  serverName: "localhost",
  caCertificate: pem(ca),
  certificateChain: pem(clientCertificate),
  privateKey: pem(clientKey)
})
/** Returns the numeric TCP port of one normalized authority. */
function port(address: string): number {
  return Number(address.slice(address.lastIndexOf(":") + 1))
}

/** Returns one native loopback server authority after real bind. */
function nativeAddress(server: { address(): unknown }): string {
  const address = server.address()
  verify(
    typeof address === "object" &&
      address !== null &&
      "port" in address &&
      typeof address.port === "number",
    "native HTTPS server omitted its bound port"
  )
  return `127.0.0.1:${address.port}`
}

/** Opens one verified HTTP/2 session with or without an mTLS client identity. */
function openHTTP2(address: string, identity: boolean): ClientHttp2Session {
  return connect(`https://localhost:${port(address)}`, {
    ca,
    cert: identity ? clientCertificate : undefined,
    key: identity ? clientKey : undefined,
    servername: "localhost",
    rejectUnauthorized: true
  })
}

/** Exchanges one POST over an already-owned HTTP/2 session. */
function requestHTTP2(session: ClientHttp2Session, body: string): Promise<HTTP2Reply> {
  return new Promise<HTTP2Reply>(function exchange(resolve, reject): void {
    let status = 0
    const chunks: Buffer[] = []
    const request = session.request(
      Object.freeze({ ":method": "POST", ":path": "/secure", "content-type": "text/plain" })
    )
    request.once("response", function headers(value): void {
      const received = value[":status"]
      status = typeof received === "number" ? received : 0
    })
    request.once("error", reject)
    request.on("data", function received(chunk: Buffer): void {
      chunks.push(chunk)
    })
    request.once("end", function ended(): void {
      resolve(
        Object.freeze({
          body: Buffer.concat(chunks).toString(),
          protocol: session.alpnProtocol ?? "",
          status
        })
      )
    })
    request.end(body)
  })
}

/** Observes one peer GOAWAY code and rejects if the session terminates first. */
function observeGoaway(session: ClientHttp2Session): Promise<number> {
  return new Promise<number>(function observe(resolve, reject): void {
    /** Removes every competing terminal observer after the first outcome. */
    function cleanup(): void {
      session.off("goaway", received)
      session.off("error", failed)
      session.off("close", closed)
    }
    /** Publishes the actual graceful shutdown code received from the server. */
    function received(errorCode: number): void {
      cleanup()
      resolve(errorCode)
    }
    /** Rejects an unexpected session failure before GOAWAY. */
    function failed(error: Error): void {
      cleanup()
      reject(error)
    }
    /** Rejects a close that arrived without a prior GOAWAY observation. */
    function closed(): void {
      cleanup()
      reject(new Error("HTTP/2 session closed before GOAWAY was observed"))
    }
    session.once("goaway", received)
    session.once("error", failed)
    session.once("close", closed)
  })
}

/** Proves an unauthenticated client cannot create one request stream. */
function rejectedWithoutClientCertificate(address: string): Promise<Error> {
  return new Promise<Error>(function rejectProbe(resolve, reject): void {
    const session = openHTTP2(address, false)
    let settled = false
    /** Publishes the first TLS or stream failure and releases the session. */
    function failed(error: Error): void {
      if (settled) return
      settled = true
      session.destroy()
      resolve(error)
    }
    session.once("error", failed)
    session.once("connect", function connected(): void {
      const request = session.request(Object.freeze({ ":path": "/must-reject" }))
      request.once("error", failed)
      request.once("response", function unexpected(): void {
        if (settled) return
        settled = true
        session.destroy()
        reject(new Error("mTLS server admitted a request without a client certificate"))
      })
      request.end()
    })
  })
}

/** Exchanges one verified HTTP/1.1 request through secure ALPN fallback. */
function requestHTTP1(address: string): Promise<string> {
  return new Promise<string>(function exchange(resolve, reject): void {
    const chunks: Buffer[] = []
    const request = httpsRequest(
      Object.freeze({
        hostname: "127.0.0.1",
        port: port(address),
        path: "/secure",
        method: "POST",
        ca,
        cert: clientCertificate,
        key: clientKey,
        servername: "localhost",
        agent: false
      }),
      function responseReceived(response): void {
        response.on("data", function received(chunk: Buffer): void {
          chunks.push(chunk)
        })
        response.once("error", reject)
        response.once("end", function ended(): void {
          resolve(Buffer.concat(chunks).toString())
        })
      }
    )
    request.once("error", reject)
    request.end("http1")
  })
}

/** Proves the released TCP authority can be rebound once. */
function provePortReleased(address: string): Promise<void> {
  const hostname = address.slice(0, address.lastIndexOf(":"))
  const probe = createServer()
  return new Promise<void>(function bind(resolve, reject): void {
    probe.once("error", reject)
    probe.listen(
      { host: hostname, port: port(address), exclusive: true },
      function listening(): void {
        probe.close(function closed(error?: Error): void {
          if (error === undefined) resolve()
          else reject(error)
        })
      }
    )
  })
}

const baselineTCP = process.getActiveResourcesInfo().filter(function tcp(value): boolean {
  return value === "TCPSocket" || value === "TCPServerWrap"
}).length
const serverTransport = newNodeHTTPTransport(clientAuth("require"), allowHTTP1(true))
serverTransport.init(secure(true), withTLSConfig(tlsConfig))
const listener = await serverTransport.listen(background(), "127.0.0.1:0")
let dispatched = 0
const served = listener.accept(background(), async function echo(ctx, socket): Promise<void> {
  dispatched += 1
  const request = await socket.recv(ctx)
  await socket.send(ctx, Object.freeze({ header: Object.freeze({}), body: request.body }))
})

const session = openHTTP2(listener.addr(), true)
const h2 = await bounded(requestHTTP2(session, "http2"), "authenticated HTTP/2 request timed out")
verify(h2.protocol === "h2", `expected ALPN h2, received ${h2.protocol}`)
verify(h2.status === 200, `expected HTTP/2 status 200, received ${h2.status}`)
verify(h2.body === "http2", "HTTP/2 transport response changed")
const sessionSocket = session.socket
verify(sessionSocket instanceof TLSSocket, "HTTP/2 client session did not expose a TLS socket")
const negotiatedTLS = sessionSocket.getProtocol()
verify(negotiatedTLS === "TLSv1.3", `expected TLSv1.3, received ${negotiatedTLS ?? "none"}`)
const h1 = await bounded(requestHTTP1(listener.addr()), "HTTP/1.1 fallback request timed out")
verify(h1 === "http1", "HTTP/1.1 ALPN fallback mismatch")
const rejected = await bounded(
  rejectedWithoutClientCertificate(listener.addr()),
  "missing client certificate did not fail"
)
verify(rejected instanceof Error, "missing client certificate did not preserve an Error")
verify(dispatched === 2, `mTLS rejection dispatched unexpected request count ${dispatched}`)

const sessionClosed = new Promise<void>(function observe(resolve): void {
  session.once("close", resolve)
})
const goaway = observeGoaway(session)
const closing = listener.close(background())
const goawayErrorCode = await bounded(goaway, "graceful HTTP/2 GOAWAY was not observed")
const gracefulGoaway = goawayErrorCode === http2Constants.NGHTTP2_NO_ERROR
verify(
  gracefulGoaway,
  `expected HTTP/2 GOAWAY code ${http2Constants.NGHTTP2_NO_ERROR}, received ${goawayErrorCode}`
)
await bounded(sessionClosed, "graceful HTTP/2 GOAWAY did not close the session")
await bounded(closing, "secure transport graceful close timed out")
await served
await provePortReleased(listener.addr())

const clientServerTransport = newNodeHTTPTransport(clientAuth("require"), allowHTTP1(false))
clientServerTransport.init(secure(true), withTLSConfig(tlsConfig))
const clientListener = await clientServerTransport.listen(background(), "127.0.0.1:0")
let clientRequests = 0
const clientServed = clientListener.accept(
  background(),
  async function echo(ctx, socket): Promise<void> {
    clientRequests += 1
    const request = await socket.recv(ctx)
    await socket.send(ctx, Object.freeze({ header: Object.freeze({}), body: request.body }))
  }
)
const clientTransport = newNodeHTTPTransport()
clientTransport.init(secure(true), withTLSConfig(clientTLSConfig))
/** Exchanges one go-like unary request through an already-owned client. */
async function exchangeGoLike(
  client: Awaited<ReturnType<typeof clientTransport.dial>>,
  body: string
): Promise<string> {
  await client.send(background(), {
    header: { "Go-Like-Service": "secure", "Go-Like-Endpoint": "call" },
    body: new TextEncoder().encode(body)
  })
  return new TextDecoder().decode((await client.recv(background())).body)
}
const goLikeClient = await clientTransport.dial(background(), clientListener.addr())
await bounded(
  goLikeClient.send(background(), {
    header: { "Go-Like-Service": "secure", "Go-Like-Endpoint": "call" },
    body: new TextEncoder().encode("go-like-mtls-h2")
  }),
  "go-like mTLS HTTP/2 send timed out"
)
const goLikeReply = await bounded(
  goLikeClient.recv(background()),
  "go-like mTLS HTTP/2 receive timed out"
)
verify(
  new TextDecoder().decode(goLikeReply.body) === "go-like-mtls-h2",
  "go-like mTLS HTTP/2 response changed"
)
verify(clientRequests === 1, `go-like HTTP/2 client dispatched ${clientRequests} requests`)
await goLikeClient.close(background())
await clientListener.close(background())
await clientServed
await provePortReleased(clientListener.addr())

let goLikeHTTP1Connections = 0
let goLikeHTTP1Requests = 0
let goLikeHTTP1Version = ""
const goLikeHTTP1Server = createHTTPSServer(
  {
    ca,
    cert: serverCertificate,
    key: serverKey,
    requestCert: true,
    rejectUnauthorized: true
  },
  function echo(request, response): void {
    goLikeHTTP1Requests += 1
    goLikeHTTP1Version = request.httpVersion
    request.pipe(response)
  }
)
goLikeHTTP1Server.on("secureConnection", function connected(): void {
  goLikeHTTP1Connections += 1
})
await new Promise<void>(function listen(resolve, reject): void {
  goLikeHTTP1Server.once("error", reject)
  goLikeHTTP1Server.listen(0, "127.0.0.1", resolve)
})
const goLikeHTTP1Address = nativeAddress(goLikeHTTP1Server)
const goLikeHTTP1Client = await clientTransport.dial(background(), goLikeHTTP1Address)
verify(
  (await bounded(
    exchangeGoLike(goLikeHTTP1Client, "go-like-mtls-http1-one"),
    "first go-like mTLS HTTP/1.1 exchange timed out"
  )) === "go-like-mtls-http1-one",
  "first go-like mTLS HTTP/1.1 response changed"
)
verify(
  (await bounded(
    exchangeGoLike(goLikeHTTP1Client, "go-like-mtls-http1-two"),
    "second go-like mTLS HTTP/1.1 exchange timed out"
  )) === "go-like-mtls-http1-two",
  "second go-like mTLS HTTP/1.1 response changed"
)
verify(goLikeHTTP1Version === "1.1", `expected go-like HTTP/1.1, got ${goLikeHTTP1Version}`)
verify(
  goLikeHTTP1Connections === 1,
  `go-like HTTP/1.1 used ${goLikeHTTP1Connections} TLS connections`
)
const goLikeHTTP1ClientConnections = goLikeHTTP1Connections
await goLikeHTTP1Client.close(background())
const directHTTP1URL = `https://${goLikeHTTP1Address}/internal`
const directHTTP1Owner = newNodeHTTPExecutor(
  normalizeHTTPDialTarget(directHTTP1URL, true),
  applyHTTPCommonOptions(defaultHTTPCommonOptions(), [
    secure(true),
    withTLSConfig(clientTLSConfig)
  ]),
  applyHTTPDialOptions([])
)
try {
  const beforeDirectOwner = goLikeHTTP1Requests
  const warm = await bounded(
    directHTTP1Owner.executor(
      new Request(directHTTP1URL, { method: "POST", body: new Uint8Array([1]) })
    ),
    "direct HTTP/1 owner warm request timed out"
  )
  await bounded(warm.arrayBuffer(), "direct HTTP/1 owner warm body timed out")
  verify(
    goLikeHTTP1Requests === beforeDirectOwner + 1,
    "direct HTTP/1 owner warm request did not reach the server"
  )

  const request = new Request(directHTTP1URL, { method: "POST" })
  Object.defineProperty(request, "arrayBuffer", {
    value(): Promise<ArrayBuffer> {
      return Promise.resolve(new Uint8Array([2]).buffer)
    }
  })
  const sending = directHTTP1Owner.executor(request)
  const settled = sending.then(
    async function unexpected(response): Promise<null> {
      await response.arrayBuffer()
      return null
    },
    function rejected(error: unknown): unknown {
      return error
    }
  )
  await Promise.resolve()
  await bounded(directHTTP1Owner.close(), "direct HTTP/1 owner close timed out")
  const failure = await bounded(settled, "direct HTTP/1 owner racing request did not settle")
  await new Promise<void>(function observeLateAdmission(resolve): void {
    setTimeout(resolve, 50)
  })
  verify(
    goLikeHTTP1Requests === beforeDirectOwner + 1,
    "closed direct HTTP/1 owner admitted a late request"
  )
  verify(failure instanceof Error, "closed direct HTTP/1 owner resolved a late request")
} finally {
  await directHTTP1Owner.close()
  goLikeHTTP1Server.closeAllConnections()
}
await new Promise<void>(function close(resolve, reject): void {
  goLikeHTTP1Server.close(function closed(error?: Error): void {
    if (error === undefined) resolve()
    else reject(error)
  })
})
await provePortReleased(goLikeHTTP1Address)

let goLikePoolConnections = 0
let goLikePoolSessions = 0
let goLikePoolRequests = 0
const activeGoLikePoolSessions = new Set<ServerHttp2Session>()
const goLikePoolVersions: string[] = []
/** Returns live native pool counters without retaining prior assertion narrowing. */
function goLikePoolCounts(): {
  readonly connections: number
  readonly requests: number
  readonly sessions: number
} {
  return Object.freeze({
    connections: goLikePoolConnections,
    requests: goLikePoolRequests,
    sessions: goLikePoolSessions
  })
}
const goLikePoolServer = createSecureServer(
  {
    allowHTTP1: true,
    ca,
    cert: serverCertificate,
    key: serverKey,
    requestCert: true,
    rejectUnauthorized: true
  },
  function echo(request, response): void {
    goLikePoolRequests += 1
    goLikePoolVersions.push(request.httpVersion)
    request.pipe(response)
  }
)
goLikePoolServer.on("secureConnection", function connected(): void {
  goLikePoolConnections += 1
})
goLikePoolServer.on("session", function admitted(session): void {
  goLikePoolSessions += 1
  activeGoLikePoolSessions.add(session)
  session.once("close", function closed(): void {
    activeGoLikePoolSessions.delete(session)
  })
})
await new Promise<void>(function listen(resolve, reject): void {
  goLikePoolServer.once("error", reject)
  goLikePoolServer.listen(0, "127.0.0.1", resolve)
})
const goLikePoolAddress = nativeAddress(goLikePoolServer)
const goLikePoolClient = await clientTransport.dial(background(), goLikePoolAddress)
verify(
  (await bounded(
    exchangeGoLike(goLikePoolClient, "go-like-h2-one"),
    "first pooled go-like HTTP/2 exchange timed out"
  )) === "go-like-h2-one",
  "first pooled go-like HTTP/2 response changed"
)
verify(
  (await bounded(
    exchangeGoLike(goLikePoolClient, "go-like-h2-two"),
    "second pooled go-like HTTP/2 exchange timed out"
  )) === "go-like-h2-two",
  "second pooled go-like HTTP/2 response changed"
)
verify(
  goLikePoolCounts().sessions === 1,
  `two go-like requests opened ${goLikePoolSessions} HTTP/2 sessions`
)
const firstGoLikePoolSession = Array.from(activeGoLikePoolSessions)[0]
verify(firstGoLikePoolSession !== undefined, "go-like HTTP/2 pool omitted its server session")
firstGoLikePoolSession.goaway(http2Constants.NGHTTP2_NO_ERROR)
await new Promise<void>(function deliverGoaway(resolve): void {
  setTimeout(resolve, 20)
})
firstGoLikePoolSession.close()
await bounded(
  (async function waitForOldSessionClose(): Promise<void> {
    while (activeGoLikePoolSessions.has(firstGoLikePoolSession)) {
      await new Promise<void>(function wait(resolve): void {
        setTimeout(resolve, 1)
      })
    }
  })(),
  "GOAWAY source session did not close"
)
verify(
  (await bounded(
    exchangeGoLike(goLikePoolClient, "go-like-h2-after-goaway"),
    "go-like HTTP/2 replacement exchange timed out"
  )) === "go-like-h2-after-goaway",
  "go-like HTTP/2 replacement response changed"
)
verify(
  goLikePoolCounts().sessions === 2,
  `GOAWAY produced ${goLikePoolSessions} total HTTP/2 sessions`
)
verify(
  goLikePoolCounts().requests === 3,
  `GOAWAY retried a POST; observed ${goLikePoolRequests} requests`
)
await goLikePoolClient.close(background())
await bounded(
  (async function waitForPoolClose(): Promise<void> {
    while (activeGoLikePoolSessions.size > 0) {
      await new Promise<void>(function wait(resolve): void {
        setTimeout(resolve, 1)
      })
    }
  })(),
  "go-like HTTP/2 client close retained a session"
)
const connectionCloseClient = await clientTransport.dial(
  background(),
  goLikePoolAddress,
  withConnClose()
)
verify(
  (await bounded(
    exchangeGoLike(connectionCloseClient, "go-like-close-one"),
    "first go-like connection-close exchange timed out"
  )) === "go-like-close-one",
  "first go-like connection-close response changed"
)
verify(
  (await bounded(
    exchangeGoLike(connectionCloseClient, "go-like-close-two"),
    "second go-like connection-close exchange timed out"
  )) === "go-like-close-two",
  "second go-like connection-close response changed"
)
verify(
  goLikePoolVersions.slice(-2).every(function http1(version): boolean {
    return version === "1.1"
  }),
  "connection-close negotiated HTTP/2"
)
verify(goLikePoolCounts().sessions === 2, "connection-close allocated an HTTP/2 session")
verify(
  goLikePoolCounts().connections === 4,
  `pooled h2 plus connection-close used ${goLikePoolConnections} TLS connections`
)
await connectionCloseClient.close(background())
await new Promise<void>(function close(resolve, reject): void {
  goLikePoolServer.close(function closed(error?: Error): void {
    if (error === undefined) resolve()
    else reject(error)
  })
})
await provePortReleased(goLikePoolAddress)

await new Promise<void>(function settle(resolve): void {
  setTimeout(resolve, 20)
})
const finalTCP = process.getActiveResourcesInfo().filter(function tcp(value): boolean {
  return value === "TCPSocket" || value === "TCPServerWrap"
}).length
verify(finalTCP === baselineTCP, `secure host TCP resource delta ${finalTCP - baselineTCP}`)

process.stdout.write(
  `GO_LIKE_NODE_HTTP_HOST_SECURE_E2E_V1=${JSON.stringify(
    Object.freeze({
      runtime: `Node.js ${process.versions.node}`,
      tls: negotiatedTLS,
      mtlsRequired: true,
      alpn: h2.protocol,
      http1Fallback: true,
      goLikeClientHTTP2: true,
      goLikeClientHTTP1: true,
      goLikeClientHTTP1TLSConnections: goLikeHTTP1ClientConnections,
      gracefulGoaway,
      goawayErrorCode,
      portReleased: true,
      tcpResourceDelta: finalTCP - baselineTCP
    })
  )}\n`
)
