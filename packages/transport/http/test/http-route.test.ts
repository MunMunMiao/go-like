import { expect, test } from "bun:test"

import { background } from "@go-like/context"
import {
  address,
  handler,
  httpRoute,
  newServer,
  transport as serverTransport
} from "@go-like/server"
import { serviceError, type Message } from "@go-like/transport"
import { decodeServiceError } from "@go-like/transport/provider"

import { newNodeHTTPTransport } from "../src/node"

const noProxy = [process.env.NO_PROXY, process.env.no_proxy, "127.0.0.1", "localhost", "::1"]
  .filter(Boolean)
  .join(",")
process.env.NO_PROXY = noProxy
process.env.no_proxy = noProxy

const Encoder = new TextEncoder()
const Decoder = new TextDecoder()
const PeerIdentityHeader = "Go-Like-Peer-Identity"
const DestMissingServiceHeader = "missing Go-Like-Service header"

interface HTTPReply {
  readonly status: number
  readonly header: Readonly<Record<string, string>>
  readonly body: Uint8Array
  readonly text: string
}

/** Reads one header name case-insensitively. */
function headerValue(header: Readonly<Record<string, string>>, name: string): string | undefined {
  const expected = name.toLowerCase()
  let found: string | undefined
  for (const key of Object.keys(header)) {
    if (key.toLowerCase() !== expected) continue
    if (found !== undefined) throw new Error(`duplicate ${name} header`)
    found = header[key]
  }
  return found
}

/** Copies one Fetch Headers object into a frozen lower-cased record. */
function snapshotHeaders(headers: Headers): Readonly<Record<string, string>> {
  const entries: [string, string][] = []
  headers.forEach(function collect(value, key): void {
    entries.push([key, value])
  })
  return Object.freeze(Object.fromEntries(entries))
}

/** Copies Go-Like-Peer-Identity into the dest-shaped command JSON body. */
function commandMessage(request: Message): Message {
  return Object.freeze({
    header: Object.freeze({ "Content-Type": "application/json" }),
    body: Encoder.encode(
      JSON.stringify(
        Object.freeze({
          status: "accepted",
          peerIdentity: headerValue(request.header, PeerIdentityHeader) ?? ""
        })
      )
    )
  })
}

/** Sends one HTTP request once the Node listener is admitting requests. */
async function sendHTTP(
  url: string,
  method: string,
  header: Readonly<Record<string, string>> = {},
  body?: unknown
): Promise<HTTPReply> {
  let last: unknown = null
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const headers: Record<string, string> =
        body === undefined ? { ...header } : { "content-type": "application/json", ...header }
      const response = await fetch(
        url,
        body === undefined
          ? Object.freeze({ method, headers })
          : Object.freeze({ method, headers, body: JSON.stringify(body) })
      )
      if (response.status === 503) {
        last = new Error("HTTP 503 before listener admission")
      } else {
        const bytes = new Uint8Array(await response.arrayBuffer())
        return Object.freeze({
          status: response.status,
          header: snapshotHeaders(response.headers),
          body: bytes,
          text: Decoder.decode(bytes)
        })
      }
    } catch (error) {
      last = error
    }
    await new Promise<void>(function wait(resolve): void {
      setTimeout(resolve, 25)
    })
  }
  throw last instanceof Error ? last : new Error("listener never admitted the request")
}

/** POSTs JSON once the Node listener is admitting requests. */
function postJSON(
  url: string,
  header: Readonly<Record<string, string>>,
  body: unknown
): Promise<HTTPReply> {
  return sendHTTP(url, "POST", header, body)
}

test("POST /v1/machine-commands without Go-Like-Service returns HTTP 201 from httpRoute", async () => {
  const received: Message[] = []
  const transport = newNodeHTTPTransport()
  const server = newServer(
    serverTransport(transport),
    address("127.0.0.1:0"),
    handler("machine-gateway", "command", (_ctx, request) => {
      received.push(request)
      return commandMessage(request)
    }),
    httpRoute("POST", "/v1/machine-commands", "machine-gateway", "command", 201)
  )
  const running = server.start(background())
  try {
    const endpoint = await server.endpoint(background())
    const reply = await postJSON(
      new URL("/v1/machine-commands", endpoint).href,
      {},
      Object.freeze({ command: "reboot" })
    )

    expect(received).toHaveLength(1)
    const request = received[0]
    if (request === undefined) throw new Error("registered handler was not invoked")
    expect(headerValue(request.header, "Go-Like-Service")).toBe("machine-gateway")
    expect(headerValue(request.header, "Go-Like-Endpoint")).toBe("command")
    expect(reply.status).toBe(201)
    expect(JSON.parse(reply.text)).toMatchObject({ status: "accepted" })
    const peerIdentity = (JSON.parse(reply.text) as { peerIdentity?: unknown }).peerIdentity
    expect(typeof peerIdentity).toBe("string")
    const requestPeer = headerValue(request.header, PeerIdentityHeader) ?? ""
    expect(peerIdentity).toBe(requestPeer)
  } finally {
    await server.stop(background())
    await running
  }
})

test("envelope POST with Go-Like-Service still uses HTTP 200 when httpRoute would return 201", async () => {
  const transport = newNodeHTTPTransport()
  const server = newServer(
    serverTransport(transport),
    address("127.0.0.1:0"),
    handler("machine-gateway", "command", (_ctx, request) => commandMessage(request)),
    httpRoute("POST", "/v1/machine-commands", "machine-gateway", "command", 201)
  )
  const running = server.start(background())
  try {
    const endpoint = await server.endpoint(background())
    const reply = await postJSON(
      new URL("/v1/machine-commands", endpoint).href,
      {
        "Go-Like-Service": "machine-gateway",
        "Go-Like-Endpoint": "command"
      },
      Object.freeze({ command: "envelope" })
    )

    expect(reply.status).toBe(200)
    expect(JSON.parse(reply.text)).toMatchObject({ status: "accepted" })
  } finally {
    await server.stop(background())
    await running
  }
})

test("envelope ServiceError still uses HTTP carrier 200", async () => {
  const transport = newNodeHTTPTransport()
  const server = newServer(
    serverTransport(transport),
    address("127.0.0.1:0"),
    handler("machine-gateway", "command", () => {
      throw serviceError("permission_denied", "machine command rejected", 403)
    }),
    httpRoute("POST", "/v1/machine-commands", "machine-gateway", "command", 201)
  )
  const running = server.start(background())
  try {
    const endpoint = await server.endpoint(background())
    const reply = await postJSON(
      new URL("/v1/machine-commands", endpoint).href,
      {
        "Go-Like-Service": "machine-gateway",
        "Go-Like-Endpoint": "command"
      },
      Object.freeze({ command: "reject" })
    )

    expect(reply.status).toBe(200)
    expect(decodeServiceError("unary", reply.status, reply.header, reply.body)).toMatchObject({
      code: "permission_denied",
      status: 403
    })
  } finally {
    await server.stop(background())
    await running
  }
})

test("POST without envelope and without matching httpRoute is HTTP 404 not dest missing-header", async () => {
  const received: Message[] = []
  const transport = newNodeHTTPTransport()
  const server = newServer(
    serverTransport(transport),
    address("127.0.0.1:0"),
    handler("machine-gateway", "command", (_ctx, request) => {
      received.push(request)
      return commandMessage(request)
    })
  )
  const running = server.start(background())
  try {
    const endpoint = await server.endpoint(background())
    const reply = await postJSON(
      new URL("/v1/machine-commands", endpoint).href,
      {},
      Object.freeze({ command: "reboot" })
    )

    expect(received).toHaveLength(0)
    expect(reply.status).toBe(404)
    expect(reply.status).not.toBe(200)
    expect(reply.text).not.toContain(DestMissingServiceHeader)
    expect(Decoder.decode(reply.body)).not.toContain(DestMissingServiceHeader)
  } finally {
    await server.stop(background())
    await running
  }
})

test("GET on a POST httpRoute path is HTTP 405 not dest missing-header", async () => {
  const received: Message[] = []
  const transport = newNodeHTTPTransport()
  const server = newServer(
    serverTransport(transport),
    address("127.0.0.1:0"),
    handler("machine-gateway", "command", (_ctx, request) => {
      received.push(request)
      return commandMessage(request)
    }),
    httpRoute("POST", "/v1/machine-commands", "machine-gateway", "command", 201)
  )
  const running = server.start(background())
  try {
    const endpoint = await server.endpoint(background())
    const reply = await sendHTTP(new URL("/v1/machine-commands", endpoint).href, "GET")

    expect(received).toHaveLength(0)
    expect(reply.status).toBe(405)
    expect(reply.status).not.toBe(200)
    expect(reply.text).not.toContain(DestMissingServiceHeader)
    expect(Decoder.decode(reply.body)).not.toContain(DestMissingServiceHeader)
  } finally {
    await server.stop(background())
    await running
  }
})

test("GET /healthz without Go-Like-Service is HTTP 200 not dest missing-header", async () => {
  const received: Message[] = []
  const transport = newNodeHTTPTransport()
  const server = newServer(
    serverTransport(transport),
    address("127.0.0.1:0"),
    handler("machine-gateway", "command", (_ctx, request) => {
      received.push(request)
      return commandMessage(request)
    })
  )
  const running = server.start(background())
  try {
    const endpoint = await server.endpoint(background())
    const reply = await sendHTTP(new URL("/healthz", endpoint).href, "GET")

    expect(received).toHaveLength(0)
    expect(reply.status).toBe(200)
    expect(reply.status).not.toBe(500)
    expect(reply.text).not.toContain(DestMissingServiceHeader)
    expect(Decoder.decode(reply.body)).not.toContain(DestMissingServiceHeader)
  } finally {
    await server.stop(background())
    await running
  }
})

test("HEAD /healthz without Go-Like-Service is HTTP 200", async () => {
  const received: Message[] = []
  const transport = newNodeHTTPTransport()
  const server = newServer(
    serverTransport(transport),
    address("127.0.0.1:0"),
    handler("machine-gateway", "command", (_ctx, request) => {
      received.push(request)
      return commandMessage(request)
    })
  )
  const running = server.start(background())
  try {
    const endpoint = await server.endpoint(background())
    const reply = await sendHTTP(new URL("/healthz", endpoint).href, "HEAD")

    expect(received).toHaveLength(0)
    expect(reply.status).toBe(200)
    expect(reply.status).not.toBe(500)
    expect(reply.text).not.toContain(DestMissingServiceHeader)
    expect(Decoder.decode(reply.body)).not.toContain(DestMissingServiceHeader)
  } finally {
    await server.stop(background())
    await running
  }
})

test("GET /livez without a matching httpRoute is HTTP 404 not dest missing-header", async () => {
  const received: Message[] = []
  const transport = newNodeHTTPTransport()
  const server = newServer(
    serverTransport(transport),
    address("127.0.0.1:0"),
    handler("machine-gateway", "command", (_ctx, request) => {
      received.push(request)
      return commandMessage(request)
    })
  )
  const running = server.start(background())
  try {
    const endpoint = await server.endpoint(background())
    const reply = await sendHTTP(new URL("/livez", endpoint).href, "GET")

    expect(received).toHaveLength(0)
    expect(reply.status).toBe(404)
    expect(reply.status).not.toBe(200)
    expect(reply.text).not.toContain(DestMissingServiceHeader)
    expect(Decoder.decode(reply.body)).not.toContain(DestMissingServiceHeader)
  } finally {
    await server.stop(background())
    await running
  }
})

test("envelope POST with Go-Like-Service still HTTP 200", async () => {
  const transport = newNodeHTTPTransport()
  const server = newServer(
    serverTransport(transport),
    address("127.0.0.1:0"),
    handler("machine-gateway", "command", (_ctx, request) => commandMessage(request))
  )
  const running = server.start(background())
  try {
    const endpoint = await server.endpoint(background())
    const reply = await postJSON(
      new URL("/v1/machine-commands", endpoint).href,
      {
        "Go-Like-Service": "machine-gateway",
        "Go-Like-Endpoint": "command"
      },
      Object.freeze({ command: "envelope" })
    )

    expect(reply.status).toBe(200)
    expect(JSON.parse(reply.text)).toMatchObject({ status: "accepted" })
  } finally {
    await server.stop(background())
    await running
  }
})
