import { expect, test } from "bun:test"

import { background } from "@go-like/context"
import { struct } from "@go-like/struct"
import { endpoint } from "@go-like/transport"
import { decodeServiceErrorResponse } from "@go-like/transport/provider"

import { httpRoute, middleware, type Server, type ServerOption } from "../src/index"
import { dispatching } from "./dispatching"

const Tick = struct.object({ n: struct.number() })
const typed = endpoint("orders", "typed", Tick, Tick)
const ticks = endpoint("orders", "ticks", Tick, Tick, true)

/** Counts how often the routed middleware and handler ran. */
interface Runs {
  middleware: number
  handler: number
}

/** One route kind and what a non-JSON Content-Type does to it. */
interface Kind {
  readonly name: string
  readonly path: string
  /** The 400 message a non-JSON Content-Type gets, or null when the route has no JSON gate. */
  readonly rejection: string | null
  /** Whether the routed middleware already ran when the request was rejected. */
  readonly middlewareRan: boolean
}

// The dispatcher gates internal RPC before middleware; typed and stream handlers gate themselves,
// which is the only gate an httpRoute request meets. A raw handler behind httpRoute has none.
const kinds: readonly Kind[] = [
  {
    name: "internal RPC raw handler",
    path: "/orders/raw",
    rejection: "invalid request content type",
    middlewareRan: false
  },
  {
    name: "internal RPC typed handler",
    path: "/orders/typed",
    rejection: "invalid request content type",
    middlewareRan: false
  },
  {
    name: "internal RPC stream handler",
    path: "/orders/ticks",
    rejection: "invalid request content type",
    middlewareRan: false
  },
  { name: "httpRoute raw handler", path: "/v1/raw", rejection: null, middlewareRan: true },
  {
    name: "httpRoute typed handler",
    path: "/v1/typed",
    rejection: "invalid request body",
    middlewareRan: true
  },
  {
    name: "httpRoute stream handler",
    path: "/v1/ticks",
    rejection: "invalid request body",
    middlewareRan: true
  }
]

/** Registers one raw, one typed, and one stream endpoint that each count their runs. */
function register(server: Server, runs: Runs): void {
  server.registerHandler("orders", "raw", () => {
    runs.handler += 1
    return new Response("ok")
  })
  server.registerHandler(typed, (_ctx, value) => {
    runs.handler += 1
    return value
  })
  server.registerHandler(ticks, async function* (): AsyncGenerator<{ n: number }> {
    runs.handler += 1
    yield { n: 1 }
  })
}

/** Exposes every endpoint through httpRoute and counts middleware runs. */
function served(runs: Runs): readonly ServerOption[] {
  return [
    httpRoute("POST", "/v1/raw", "orders", "raw"),
    httpRoute("POST", "/v1/typed", "orders", "typed"),
    httpRoute("POST", "/v1/ticks", "orders", "ticks"),
    middleware((next) => (ctx, request) => {
      runs.middleware += 1
      return next(ctx, request)
    })
  ]
}

/** Posts a JSON-valued body whose Content-Type header is exactly contentType, or absent for null. */
function post(path: string, contentType: string | null): Request {
  const headers = new Headers()
  if (contentType !== null) headers.set("content-type", contentType)
  return new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers,
    body: new TextEncoder().encode('{"n":1}')
  })
}

for (const kind of kinds) {
  for (const contentType of ["text/plain", null]) {
    test(`${kind.name} answers ${contentType ?? "a missing"} Content-Type as specified`, async () => {
      const runs: Runs = { middleware: 0, handler: 0 }
      const serving = await dispatching((server) => register(server, runs), ...served(runs))
      try {
        const request = post(kind.path, contentType)
        expect(request.headers.get("content-type")).toBe(contentType)
        const response = await serving.dispatch(background(), request)
        if (kind.rejection === null) {
          expect(response.status).toBe(200)
          await response.text()
          expect(runs).toEqual({ middleware: 1, handler: 1 })
          return
        }
        expect(response.status).toBe(400)
        expect(await decodeServiceErrorResponse(response)).toMatchObject({
          code: "invalid_request",
          status: 400,
          message: kind.rejection
        })
        expect(runs).toEqual({ middleware: kind.middlewareRan ? 1 : 0, handler: 0 })
      } finally {
        await serving.stop()
      }
    })
  }

  test(`${kind.name} accepts a JSON Content-Type with parameters`, async () => {
    const runs: Runs = { middleware: 0, handler: 0 }
    const serving = await dispatching((server) => register(server, runs), ...served(runs))
    try {
      const response = await serving.dispatch(
        background(),
        post(kind.path, "Application/JSON; charset=utf-8")
      )
      expect(response.status).toBe(200)
      await response.text()
      expect(runs).toEqual({ middleware: 1, handler: 1 })
    } finally {
      await serving.stop()
    }
  })
}
