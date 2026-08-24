import { expect, test } from "bun:test"

import { background, type Context } from "@go-like/context"
import { serviceError } from "@go-like/transport"
import type {
  AcceptHandler,
  Client,
  Listener,
  Message,
  Options,
  Transport
} from "@go-like/transport"
import { decodeServiceError } from "@go-like/transport/provider"

import {
  handler,
  httpRoute,
  newServer,
  transport,
  type Handler,
  type ServerOption
} from "../src/index"

const Encoder = new TextEncoder()
const Decoder = new TextDecoder()
const PeerIdentityHeader = "Go-Like-Peer-Identity"
const DestPeerIdentity = "spiffe://ms020/machine/alpha"
const DestMissingServiceHeader = "missing Go-Like-Service header"
const HTTPCarrierStatusHeader = "Go-Like-HTTP-Status"

interface HTTPRouteSnapshot {
  readonly method: string
  readonly path: string
  readonly service: string
  readonly endpoint: string
  readonly successStatus: number
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

/** Creates one JSON transport Message. */
function jsonMessage(header: Readonly<Record<string, string>>, value: unknown): Message {
  return Object.freeze({
    header: Object.freeze({ ...header, "Content-Type": "application/json" }),
    body: Encoder.encode(JSON.stringify(value))
  })
}

/** Parses one JSON transport body. */
function readJSON(message: Message): unknown {
  return JSON.parse(Decoder.decode(message.body))
}

/** Copies Go-Like-Peer-Identity into the dest-shaped command JSON body. */
const commandHandler: Handler = (_ctx, request) =>
  jsonMessage(
    {},
    Object.freeze({
      status: "accepted",
      peerIdentity: headerValue(request.header, PeerIdentityHeader) ?? ""
    })
  )

/** Creates one listener controlled by close. */
function fixtureListener(
  sent: Message[],
  requests: readonly Message[],
  onAccept: (() => void) | null = null
): Listener {
  let resolveDone: (() => void) | null = null
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  return {
    addr(): string {
      return "127.0.0.1:43210"
    },
    async close(): Promise<void> {
      resolveDone?.()
    },
    async accept(ctx: Context, handle: AcceptHandler): Promise<void> {
      onAccept?.()
      for (const request of requests) {
        const socket = {
          recv(): Promise<Message> {
            return Promise.resolve(request)
          },
          async send(_ctx: Context, message: Message): Promise<void> {
            sent.push(message)
          },
          close(): Promise<void> {
            return Promise.resolve()
          },
          local(): string {
            return "127.0.0.1:43210"
          },
          remote(): string {
            return "127.0.0.1:50000"
          }
        }
        await handle(ctx, socket)
      }
      await done
    }
  }
}

/** Creates one structural transport around listener. */
function fixtureTransport(listener: Listener): Transport {
  return {
    kind(): string {
      return "http"
    },
    init(): void {},
    options(): Options {
      return Object.freeze({
        codec: null,
        logger: null,
        timeoutMs: 0,
        secure: false,
        tlsConfig: null
      })
    },
    dial(): Promise<Client> {
      return Promise.reject(new Error("unused"))
    },
    listen(): Promise<Listener> {
      return Promise.resolve(listener)
    },
    string(): string {
      return "fixture"
    }
  }
}

/** Dispatches one request through a real server accept loop. */
async function dispatch(request: Message, ...options: readonly ServerOption[]): Promise<Message> {
  const sent: Message[] = []
  const accepting = Promise.withResolvers<void>()
  const server = newServer(
    transport(fixtureTransport(fixtureListener(sent, [request], accepting.resolve))),
    ...options
  )
  const running = server.start(background())
  await accepting.promise
  await server.stop(background())
  await running
  const response = sent[0]
  if (response === undefined) throw new Error("server omitted its response")
  return response
}

test("snapshots httpRoute entries including an omitted successStatus default of 200", () => {
  const server = newServer(
    transport(fixtureTransport(fixtureListener([], []))),
    handler("machine-gateway", "command", commandHandler),
    httpRoute("POST", "/v1/machine-commands", "machine-gateway", "command", 201),
    httpRoute("POST", "/v1/machine-status", "machine-gateway", "command")
  )
  const routes = server.options().httpRoutes
  expect(routes).toEqual([
    Object.freeze({
      method: "POST",
      path: "/v1/machine-commands",
      service: "machine-gateway",
      endpoint: "command",
      successStatus: 201
    }),
    Object.freeze({
      method: "POST",
      path: "/v1/machine-status",
      service: "machine-gateway",
      endpoint: "command",
      successStatus: 200
    })
  ] satisfies HTTPRouteSnapshot[])
})

test("rejects a duplicated httpRoute method and path at construction", () => {
  expect(() =>
    newServer(
      transport(fixtureTransport(fixtureListener([], []))),
      handler("machine-gateway", "command", commandHandler),
      httpRoute("POST", "/v1/machine-commands", "machine-gateway", "command", 201),
      httpRoute("post", "/v1/machine-commands", "machine-gateway", "command", 200)
    )
  ).toThrow("duplicated")
})

test("rejects malformed httpRoute construction values", () => {
  expect(() => httpRoute("", "/v1/orders", "orders", "get")).toThrow(
    "server httpRoute method must be an HTTP method token"
  )
  expect(() => httpRoute("POST", "", "orders", "get")).toThrow(
    "server httpRoute path must be a non-empty string"
  )
  expect(() => httpRoute("POST", "/v1/orders?x=1", "orders", "get")).toThrow(
    "server httpRoute path must not include query or fragment"
  )
  expect(() => httpRoute("POST", "/v1/orders", "orders", "get", 99)).toThrow(
    "server httpRoute successStatus must be an HTTP status code"
  )
  expect(() =>
    newServer(
      transport(fixtureTransport(fixtureListener([], []))),
      handler("machine-gateway", "command", commandHandler),
      (options) => ({
        address: options.address,
        advertise: options.advertise,
        transport: options.transport,
        handlers: options.handlers,
        middleware: options.middleware,
        operationMiddleware: options.operationMiddleware,
        listenOptions: options.listenOptions,
        httpRoutes: [null as never]
      })
    )
  ).toThrow("server httpRoute must be an object")
})

test("an unparseable Go-Like-Target is not a dest missing-header 500", async () => {
  const received: Message[] = []
  const response = await dispatch(
    jsonMessage(
      {
        "Go-Like-Method": "GET",
        "Go-Like-Target": "http://example.com:65536"
      },
      Object.freeze({})
    ),
    handler("machine-gateway", "command", (ctx, request) => {
      received.push(request)
      return commandHandler(ctx, request)
    })
  )

  expect(received).toHaveLength(0)
  expect(headerValue(response.header, HTTPCarrierStatusHeader)).toBe("404")
  expect(Decoder.decode(response.body)).not.toContain(DestMissingServiceHeader)
})

test("POST /v1/machine-commands without Go-Like-Service reaches the registered handler", async () => {
  const received: Message[] = []
  const response = await dispatch(
    jsonMessage(
      {
        "Go-Like-Method": "POST",
        "Go-Like-Target": "/v1/machine-commands",
        [PeerIdentityHeader]: DestPeerIdentity
      },
      Object.freeze({ command: "reboot" })
    ),
    handler("machine-gateway", "command", (ctx, request) => {
      received.push(request)
      return commandHandler(ctx, request)
    }),
    httpRoute("POST", "/v1/machine-commands", "machine-gateway", "command", 201)
  )

  expect(received).toHaveLength(1)
  const request = received[0]
  if (request === undefined) throw new Error("registered handler was not invoked")
  expect(headerValue(request.header, "Go-Like-Service")).toBe("machine-gateway")
  expect(headerValue(request.header, "Go-Like-Endpoint")).toBe("command")
  expect(headerValue(request.header, PeerIdentityHeader)).toBe(DestPeerIdentity)
  expect(decodeServiceError("unary", 200, response.header, response.body)).toBeNull()
  expect(readJSON(response)).toEqual(
    Object.freeze({
      status: "accepted",
      peerIdentity: DestPeerIdentity
    })
  )
})

test("envelope POST with Go-Like-Service is not rewritten by a matching httpRoute path", async () => {
  const received: string[] = []
  const response = await dispatch(
    jsonMessage(
      {
        "Go-Like-Service": "machine-gateway",
        "Go-Like-Endpoint": "command",
        "Go-Like-Method": "POST",
        "Go-Like-Target": "/v1/other"
      },
      Object.freeze({ command: "envelope" })
    ),
    handler("machine-gateway", "command", (_ctx, request) => {
      received.push("command")
      return commandHandler(_ctx, request)
    }),
    handler("other-gateway", "other", (_ctx, request) => {
      received.push("other")
      return request
    }),
    httpRoute("POST", "/v1/other", "other-gateway", "other", 201)
  )

  expect(received).toEqual(["command"])
  expect(decodeServiceError("unary", 200, response.header, response.body)).toBeNull()
})

test("httpRoute ServiceError uses HTTP carrier status not dest 200", async () => {
  const response = await dispatch(
    jsonMessage(
      {
        "Go-Like-Method": "POST",
        "Go-Like-Target": "/v1/machine-commands"
      },
      Object.freeze({ command: "reboot" })
    ),
    handler("machine-gateway", "command", () => {
      throw serviceError("invalid_argument", "invalid JSON", 400)
    }),
    httpRoute("POST", "/v1/machine-commands", "machine-gateway", "command", 201)
  )

  expect(headerValue(response.header, HTTPCarrierStatusHeader)).toBe("400")
  expect(headerValue(response.header, HTTPCarrierStatusHeader)).not.toBe("201")
})

test("envelope ServiceError still decodes as unary carrier 200", async () => {
  const response = await dispatch(
    jsonMessage(
      {
        "Go-Like-Service": "machine-gateway",
        "Go-Like-Endpoint": "command"
      },
      Object.freeze({ command: "reject" })
    ),
    handler("machine-gateway", "command", () => {
      throw serviceError("permission_denied", "machine command rejected", 403)
    }),
    httpRoute("POST", "/v1/machine-commands", "machine-gateway", "command", 201)
  )

  expect(decodeServiceError("unary", 200, response.header, response.body)).toMatchObject({
    code: "permission_denied",
    status: 403
  })
})

test("POST with Go-Like-Method/Target and no matching httpRoute is HTTP 404 not dest missing-header", async () => {
  const received: Message[] = []
  const response = await dispatch(
    jsonMessage(
      {
        "Go-Like-Method": "POST",
        "Go-Like-Target": "/v1/machine-commands"
      },
      Object.freeze({ command: "reboot" })
    ),
    handler("machine-gateway", "command", (ctx, request) => {
      received.push(request)
      return commandHandler(ctx, request)
    })
  )

  expect(received).toHaveLength(0)
  expect(headerValue(response.header, HTTPCarrierStatusHeader)).toBe("404")
  expect(Decoder.decode(response.body)).not.toContain(DestMissingServiceHeader)
  expect(decodeServiceError("unary", 200, response.header, response.body)).toBeNull()
})

test("GET with a POST httpRoute on the same path is HTTP 405 not dest missing-header", async () => {
  const received: Message[] = []
  const response = await dispatch(
    jsonMessage(
      {
        "Go-Like-Method": "GET",
        "Go-Like-Target": "/v1/machine-commands"
      },
      Object.freeze({ command: "reboot" })
    ),
    handler("machine-gateway", "command", (ctx, request) => {
      received.push(request)
      return commandHandler(ctx, request)
    }),
    httpRoute("POST", "/v1/machine-commands", "machine-gateway", "command", 201)
  )

  expect(received).toHaveLength(0)
  expect(headerValue(response.header, HTTPCarrierStatusHeader)).toBe("405")
  expect(Decoder.decode(response.body)).not.toContain(DestMissingServiceHeader)
  expect(decodeServiceError("unary", 200, response.header, response.body)).toBeNull()
})

test("GET /healthz without Go-Like-Service is HTTP 200 not dest missing-header", async () => {
  const received: Message[] = []
  const response = await dispatch(
    jsonMessage(
      {
        "Go-Like-Method": "GET",
        "Go-Like-Target": "/healthz"
      },
      Object.freeze({})
    ),
    handler("machine-gateway", "command", (ctx, request) => {
      received.push(request)
      return commandHandler(ctx, request)
    })
  )

  expect(received).toHaveLength(0)
  expect(headerValue(response.header, HTTPCarrierStatusHeader)).toBe("200")
  expect(headerValue(response.header, HTTPCarrierStatusHeader)).not.toBe("500")
  expect(Decoder.decode(response.body)).not.toContain(DestMissingServiceHeader)
  expect(decodeServiceError("unary", 200, response.header, response.body)).toBeNull()
})

test("HEAD /healthz without Go-Like-Service is HTTP 200", async () => {
  const received: Message[] = []
  const response = await dispatch(
    jsonMessage(
      {
        "Go-Like-Method": "HEAD",
        "Go-Like-Target": "/healthz"
      },
      Object.freeze({})
    ),
    handler("machine-gateway", "command", (ctx, request) => {
      received.push(request)
      return commandHandler(ctx, request)
    })
  )

  expect(received).toHaveLength(0)
  expect(headerValue(response.header, HTTPCarrierStatusHeader)).toBe("200")
  expect(Decoder.decode(response.body)).not.toContain(DestMissingServiceHeader)
  expect(decodeServiceError("unary", 200, response.header, response.body)).toBeNull()
})

test("POST /healthz without a matching httpRoute is HTTP 404 not dest missing-header", async () => {
  const received: Message[] = []
  const response = await dispatch(
    jsonMessage(
      {
        "Go-Like-Method": "POST",
        "Go-Like-Target": "/healthz"
      },
      Object.freeze({})
    ),
    handler("machine-gateway", "command", (ctx, request) => {
      received.push(request)
      return commandHandler(ctx, request)
    })
  )

  expect(received).toHaveLength(0)
  expect(headerValue(response.header, HTTPCarrierStatusHeader)).toBe("404")
  expect(headerValue(response.header, HTTPCarrierStatusHeader)).not.toBe("200")
  expect(Decoder.decode(response.body)).not.toContain(DestMissingServiceHeader)
  expect(decodeServiceError("unary", 200, response.header, response.body)).toBeNull()
})

test("GET /healthz with an exact httpRoute uses that handler successStatus", async () => {
  const received: Message[] = []
  const response = await dispatch(
    jsonMessage(
      {
        "Go-Like-Method": "GET",
        "Go-Like-Target": "/healthz"
      },
      Object.freeze({})
    ),
    handler("machine-gateway", "command", (ctx, request) => {
      received.push(request)
      return commandHandler(ctx, request)
    }),
    httpRoute("GET", "/healthz", "machine-gateway", "command", 503)
  )

  expect(received).toHaveLength(1)
  expect(headerValue(response.header, HTTPCarrierStatusHeader)).toBe("503")
  expect(headerValue(response.header, HTTPCarrierStatusHeader)).not.toBe("200")
  expect(decodeServiceError("unary", 200, response.header, response.body)).toBeNull()
  expect(readJSON(response)).toEqual(
    Object.freeze({
      status: "accepted",
      peerIdentity: ""
    })
  )
})

test("HEAD /healthz with only a GET httpRoute is HTTP 405", async () => {
  const received: Message[] = []
  const response = await dispatch(
    jsonMessage(
      {
        "Go-Like-Method": "HEAD",
        "Go-Like-Target": "/healthz"
      },
      Object.freeze({})
    ),
    handler("machine-gateway", "command", (ctx, request) => {
      received.push(request)
      return commandHandler(ctx, request)
    }),
    httpRoute("GET", "/healthz", "machine-gateway", "command", 201)
  )

  expect(received).toHaveLength(0)
  expect(headerValue(response.header, HTTPCarrierStatusHeader)).toBe("405")
  expect(Decoder.decode(response.body)).not.toContain(DestMissingServiceHeader)
  expect(decodeServiceError("unary", 200, response.header, response.body)).toBeNull()
})

test("httpRoute GET /healthz is not treated as a duplicated default probe", () => {
  expect(() =>
    newServer(
      transport(fixtureTransport(fixtureListener([], []))),
      handler("machine-gateway", "command", commandHandler),
      httpRoute("GET", "/healthz", "machine-gateway", "command")
    )
  ).not.toThrow()
})

test("GET /livez without a matching httpRoute is HTTP 404 not dest missing-header", async () => {
  const received: Message[] = []
  const response = await dispatch(
    jsonMessage(
      {
        "Go-Like-Method": "GET",
        "Go-Like-Target": "/livez"
      },
      Object.freeze({})
    ),
    handler("machine-gateway", "command", (ctx, request) => {
      received.push(request)
      return commandHandler(ctx, request)
    })
  )

  expect(received).toHaveLength(0)
  expect(headerValue(response.header, HTTPCarrierStatusHeader)).toBe("404")
  expect(headerValue(response.header, HTTPCarrierStatusHeader)).not.toBe("200")
  expect(Decoder.decode(response.body)).not.toContain(DestMissingServiceHeader)
  expect(decodeServiceError("unary", 200, response.header, response.body)).toBeNull()
})

test("envelope POST with Go-Like-Service still uses HTTP 200", async () => {
  const received: Message[] = []
  const response = await dispatch(
    jsonMessage(
      {
        "Go-Like-Service": "machine-gateway",
        "Go-Like-Endpoint": "command"
      },
      Object.freeze({ command: "envelope" })
    ),
    handler("machine-gateway", "command", (ctx, request) => {
      received.push(request)
      return commandHandler(ctx, request)
    })
  )

  expect(received).toHaveLength(1)
  expect(headerValue(response.header, HTTPCarrierStatusHeader)).toBeUndefined()
  expect(Decoder.decode(response.body)).not.toContain(DestMissingServiceHeader)
  expect(decodeServiceError("unary", 200, response.header, response.body)).toBeNull()
  expect(readJSON(response)).toEqual(
    Object.freeze({
      status: "accepted",
      peerIdentity: ""
    })
  )
})
