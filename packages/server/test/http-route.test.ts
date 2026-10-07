import { expect, test } from "bun:test"

import { background, type Context } from "@go-like/context"
import { serviceError } from "@go-like/transport"
import type { Client, Listener, Options, Transport, TransportHandler } from "@go-like/transport"
import { decodeServiceErrorResponse } from "@go-like/transport/provider"

import {
  httpRoute,
  newServer,
  transport,
  type Handler,
  type Server,
  type ServerOption
} from "../src/index"

interface HTTPRouteSnapshot {
  readonly method: string
  readonly path: string
  readonly service: string
  readonly endpoint: string
  readonly successStatus: number
}

/** Returns the registered command body without reading transport peer identity. */
const commandHandler: Handler = () =>
  new Response(JSON.stringify({ status: "accepted" }), {
    status: 200,
    headers: { "content-type": "application/json" }
  })

/** Creates one listener controlled by close. */
function fixtureListener(
  sent: Response[],
  requests: readonly Request[],
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
    async serve(ctx: Context, handler: TransportHandler): Promise<void> {
      onAccept?.()
      for (const request of requests) sent.push(await handler(ctx, request))
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

/** Builds one request against the fixture origin. */
function request(
  method: string,
  path: string,
  body: string | null = null,
  headers: HeadersInit = {}
): Request {
  const init: RequestInit = { method, headers }
  if (body !== null) init.body = body
  return new Request(`http://127.0.0.1${path}`, init)
}

/** Dispatches one request through a real server serve loop. */
async function dispatch(
  value: Request,
  register: (server: Server) => void,
  ...options: readonly ServerOption[]
): Promise<Response> {
  const sent: Response[] = []
  const accepting = Promise.withResolvers<void>()
  const server = newServer(
    transport(fixtureTransport(fixtureListener(sent, [value], accepting.resolve))),
    ...options
  )
  register(server)
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
    httpRoute("POST", "/v1/machine-commands", "machine-gateway", "command", 201),
    httpRoute("POST", "/v1/machine-status", "machine-gateway", "command")
  )
  server.registerHandler("machine-gateway", "command", commandHandler)
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
  expect(() => httpRoute("POST", "/v1/orders#fragment", "orders", "get")).toThrow(
    "server httpRoute path must not include query or fragment"
  )
  expect(() => httpRoute("POST", "/v1/orders", "orders!", "get")).toThrow(
    "server service must be a URL unreserved route token"
  )
  expect(() => httpRoute("POST", "/v1/orders", ".", "get")).toThrow(
    "server service must be a URL unreserved route token"
  )
  expect(() => httpRoute("POST", "/v1/orders", "..", "get")).toThrow(
    "server service must be a URL unreserved route token"
  )
  expect(() => httpRoute("POST", "/v1/orders", "orders", ".")).toThrow(
    "server endpoint must be a URL unreserved route token"
  )
  expect(() => httpRoute("POST", "/v1/orders", "orders", "..")).toThrow(
    "server endpoint must be a URL unreserved route token"
  )
  expect(
    newServer(
      transport(fixtureTransport(fixtureListener([], []))),
      httpRoute("POST", "/v1/orders", "a.b", "a..b")
    ).options().httpRoutes[0]
  ).toMatchObject({ service: "a.b", endpoint: "a..b" })
  expect(() => httpRoute("POST", "/v1/orders", "orders", "get*")).toThrow(
    "server endpoint must be a URL unreserved route token"
  )
  expect(() => httpRoute("POST", "/v1/orders", "orders", "get", 99)).toThrow(
    "server httpRoute successStatus must be an HTTP status code"
  )
  expect(() =>
    newServer(transport(fixtureTransport(fixtureListener([], []))), (options) => ({
      address: options.address,
      advertise: options.advertise,
      transport: options.transport,
      middleware: options.middleware,
      operationMiddleware: options.operationMiddleware,
      listenOptions: options.listenOptions,
      streamKeepAliveMs: options.streamKeepAliveMs,
      maxSendMessageBytes: options.maxSendMessageBytes,
      httpRoutes: [null as never]
    }))
  ).toThrow("server httpRoute must be an object")
})

test("rejects a missing httpRoute target before listen", async () => {
  let listens = 0
  const listener = fixtureListener([], [])
  const base = fixtureTransport(listener)
  const server = newServer(
    transport({
      ...base,
      listen(ctx, address, ...options) {
        listens += 1
        return base.listen(ctx, address, ...options)
      }
    }),
    httpRoute("POST", "/v1/orders", "orders", "get")
  )
  server.registerHandler("health", "check", commandHandler)

  await expect(server.endpoint(background())).rejects.toThrow(
    "server httpRoute target is not registered: orders/get"
  )
  expect(listens).toBe(0)
})

test("httpRoute skips the RPC content-type check and rewrites a 2xx success status", async () => {
  const received: Request[] = []
  const response = await dispatch(
    request("POST", "/v1/machine-commands", "raw", { "content-type": "text/plain" }),
    (server) =>
      server.registerHandler("machine-gateway", "command", (_ctx, value) => {
        received.push(value)
        return commandHandler(_ctx, value)
      }),
    httpRoute("POST", "/v1/machine-commands", "machine-gateway", "command", 201)
  )

  expect(received).toHaveLength(1)
  expect(received[0]?.url).toBe("http://127.0.0.1/v1/machine-commands")
  expect(response.status).toBe(201)
  expect(response.headers.get("content-type")).toBe("application/json")
  expect(await decodeServiceErrorResponse(response.clone())).toBeNull()
  expect(await response.json()).toEqual({ status: "accepted" })
})

test("routes an internal RPC by pathname when that path is not an httpRoute", async () => {
  const received: string[] = []
  const response = await dispatch(
    request("POST", "/machine-gateway/command", "{}", { "content-type": "application/json" }),
    (server) => {
      server.registerHandler("machine-gateway", "command", () => {
        received.push("command")
        return commandHandler(background(), new Request("http://127.0.0.1/"))
      })
      server.registerHandler("other-gateway", "other", () => {
        received.push("other")
        return new Response(null, { status: 204 })
      })
    },
    httpRoute("POST", "/v1/other", "other-gateway", "other", 201)
  )

  expect(received).toEqual(["command"])
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ status: "accepted" })
})

test("an httpRoute ServiceError keeps its status instead of successStatus", async () => {
  const response = await dispatch(
    request("POST", "/v1/machine-commands", "raw"),
    (server) =>
      server.registerHandler("machine-gateway", "command", () => {
        throw serviceError("invalid_argument", "invalid JSON", 400)
      }),
    httpRoute("POST", "/v1/machine-commands", "machine-gateway", "command", 201)
  )

  expect(response.status).toBe(400)
  expect(response.headers.get("content-type")).toBe("application/json")
  expect(await decodeServiceErrorResponse(response)).toMatchObject({
    code: "invalid_argument",
    message: "invalid JSON",
    status: 400
  })
})

test("an internal RPC ServiceError uses the error status", async () => {
  const response = await dispatch(
    request("POST", "/machine-gateway/command", "{}", { "content-type": "application/json" }),
    (server) =>
      server.registerHandler("machine-gateway", "command", () => {
        throw serviceError("permission_denied", "machine command rejected", 403)
      })
  )

  expect(response.status).toBe(403)
  expect(await decodeServiceErrorResponse(response)).toMatchObject({
    code: "permission_denied",
    message: "machine command rejected",
    status: 403
  })
})

test("an unregistered two-segment path is not_found before the handler", async () => {
  const received: Request[] = []
  const response = await dispatch(request("POST", "/v1/machine-commands", "{}"), (server) =>
    server.registerHandler("machine-gateway", "command", (_ctx, value) => {
      received.push(value)
      return commandHandler(_ctx, value)
    })
  )

  expect(received).toHaveLength(0)
  expect(response.status).toBe(404)
  expect(await decodeServiceErrorResponse(response)).toMatchObject({
    code: "not_found",
    message: "unknown service endpoint: v1/machine-commands",
    status: 404
  })
})

test("a method mismatch on an httpRoute is 405 and lists methods in declaration order", async () => {
  const received: Request[] = []
  const response = await dispatch(
    request("PUT", "/v1/machine-commands"),
    (server) =>
      server.registerHandler("machine-gateway", "command", (_ctx, value) => {
        received.push(value)
        return commandHandler(_ctx, value)
      }),
    httpRoute("GET", "/v1/machine-commands", "machine-gateway", "command"),
    httpRoute("POST", "/v1/machine-commands", "machine-gateway", "command", 201)
  )

  expect(received).toHaveLength(0)
  expect(response.status).toBe(405)
  expect(response.headers.get("allow")).toBe("GET, POST")
  expect(await decodeServiceErrorResponse(response)).toMatchObject({
    code: "method_not_allowed",
    message: "method not allowed",
    status: 405
  })
})

test("GET and HEAD /healthz are empty 200 responses", async () => {
  for (const method of ["GET", "HEAD"] as const) {
    const received: Request[] = []
    const response = await dispatch(request(method, "/healthz"), (server) =>
      server.registerHandler("machine-gateway", "command", (_ctx, value) => {
        received.push(value)
        return commandHandler(_ctx, value)
      })
    )
    expect(received).toHaveLength(0)
    expect(response.status).toBe(200)
    expect(await response.arrayBuffer()).toHaveLength(0)
    expect(await decodeServiceErrorResponse(response.clone())).toBeNull()
  }
})

test("POST /healthz without an httpRoute is a generic not_found", async () => {
  const response = await dispatch(request("POST", "/healthz"), (server) =>
    server.registerHandler("machine-gateway", "command", commandHandler)
  )

  expect(response.status).toBe(404)
  expect(await decodeServiceErrorResponse(response)).toMatchObject({
    code: "not_found",
    message: "not found",
    status: 404
  })
})

test("an exact httpRoute on /healthz uses that handler and successStatus", async () => {
  const received: Request[] = []
  const response = await dispatch(
    request("GET", "/healthz"),
    (server) =>
      server.registerHandler("machine-gateway", "command", (_ctx, value) => {
        received.push(value)
        return commandHandler(_ctx, value)
      }),
    httpRoute("GET", "/healthz", "machine-gateway", "command", 503)
  )

  expect(received).toHaveLength(1)
  expect(response.status).toBe(503)
  expect(await decodeServiceErrorResponse(response.clone())).toBeNull()
  expect(await response.json()).toEqual({ status: "accepted" })
})

test("HEAD /healthz with only a GET httpRoute is 405 and does not use the default probe", async () => {
  const received: Request[] = []
  const response = await dispatch(
    request("HEAD", "/healthz"),
    (server) =>
      server.registerHandler("machine-gateway", "command", (_ctx, value) => {
        received.push(value)
        return commandHandler(_ctx, value)
      }),
    httpRoute("GET", "/healthz", "machine-gateway", "command", 201)
  )

  expect(received).toHaveLength(0)
  expect(response.status).toBe(405)
  expect(response.headers.get("allow")).toBe("GET")
  expect(await decodeServiceErrorResponse(response)).toMatchObject({
    code: "method_not_allowed",
    status: 405
  })
})

test("registering GET /healthz does not collide with the default probe", () => {
  expect(() =>
    newServer(
      transport(fixtureTransport(fixtureListener([], []))),
      httpRoute("GET", "/healthz", "machine-gateway", "command")
    )
  ).not.toThrow()
})

test("one-segment, invalid-token, and trailing-slash paths are generic not_found", async () => {
  for (const path of ["/livez", "/orders/get*", "/orders/get/", "/"]) {
    const response = await dispatch(request("GET", path), (server) =>
      server.registerHandler("machine-gateway", "command", commandHandler)
    )
    expect(response.status).toBe(404)
    expect(await decodeServiceErrorResponse(response)).toMatchObject({
      code: "not_found",
      message: "not found",
      status: 404
    })
  }
})

test("an illegal timeout header is rejected before healthz", async () => {
  const response = await dispatch(
    request("GET", "/healthz", null, { "Go-Like-Timeout-Ms": "nope" }),
    (server) => server.registerHandler("machine-gateway", "command", commandHandler)
  )

  expect(response.status).toBe(400)
  expect(await decodeServiceErrorResponse(response)).toMatchObject({
    code: "invalid_request",
    message: "invalid timeout header",
    status: 400
  })
})
