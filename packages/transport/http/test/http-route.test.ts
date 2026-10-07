import { expect, test } from "bun:test"

import { background } from "@go-like/context"
import { address, httpRoute, newServer, transport as serverTransport } from "@go-like/server"
import { serviceError } from "@go-like/transport"
import { decodeServiceErrorResponse } from "@go-like/transport/provider"

import { newNodeHTTPTransport } from "../src/node"

const noProxy = [process.env.NO_PROXY, process.env.no_proxy, "127.0.0.1", "localhost", "::1"]
  .filter(Boolean)
  .join(",")
process.env.NO_PROXY = noProxy
process.env.no_proxy = noProxy

interface HTTPReply {
  readonly status: number
  readonly header: Readonly<Record<string, string>>
  readonly text: string
}

/** Copies one Fetch Headers object into a frozen lower-cased record. */
function snapshotHeaders(headers: Headers): Readonly<Record<string, string>> {
  const entries: [string, string][] = []
  headers.forEach(function collect(value, key): void {
    entries.push([key, value])
  })
  return Object.freeze(Object.fromEntries(entries))
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
        return Object.freeze({
          status: response.status,
          header: snapshotHeaders(response.headers),
          text: await response.text()
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

/** Returns one JSON command acknowledgement. */
function accepted(): Response {
  return new Response(JSON.stringify(Object.freeze({ status: "accepted" })), {
    headers: Object.freeze({ "content-type": "application/json" })
  })
}

test("POST /v1/machine-commands hits httpRoute and returns its success status", async () => {
  let calls = 0
  const transport = newNodeHTTPTransport()
  const server = newServer(
    serverTransport(transport),
    address("127.0.0.1:0"),
    httpRoute("POST", "/v1/machine-commands", "machine-gateway", "command", 201)
  )
  server.registerHandler("machine-gateway", "command", function handle(): Response {
    calls += 1
    return accepted()
  })
  const running = server.start(background())
  try {
    const endpoint = await server.endpoint(background())
    const reply = await sendHTTP(
      new URL("/v1/machine-commands", endpoint).href,
      "POST",
      { "content-type": "text/plain" },
      undefined
    )
    const routed = await sendHTTP(
      new URL("/v1/machine-commands", endpoint).href,
      "POST",
      {},
      {
        command: "reboot"
      }
    )

    expect(calls).toBe(2)
    expect(reply.status).toBe(201)
    expect(routed.status).toBe(201)
    expect(JSON.parse(routed.text)).toEqual({ status: "accepted" })
    expect(routed.header["go-like-service"]).toBeUndefined()
    expect(routed.header["go-like-endpoint"]).toBeUndefined()
  } finally {
    await server.stop(background())
    await running
  }
})

test("RPC pathname stays on the registered endpoint when another httpRoute exists", async () => {
  const seen: string[] = []
  const transport = newNodeHTTPTransport()
  const server = newServer(
    serverTransport(transport),
    address("127.0.0.1:0"),
    httpRoute("POST", "/v1/machine-commands", "machine-gateway", "command", 201)
  )
  server.registerHandler("machine-gateway", "command", function handle(_ctx, request): Response {
    seen.push(new URL(request.url).pathname)
    return accepted()
  })
  const running = server.start(background())
  try {
    const endpoint = await server.endpoint(background())
    const reply = await sendHTTP(
      new URL("/machine-gateway/command", endpoint).href,
      "POST",
      {},
      Object.freeze({ command: "envelope" })
    )

    expect(seen).toEqual(["/machine-gateway/command"])
    expect(reply.status).toBe(200)
    expect(JSON.parse(reply.text)).toEqual({ status: "accepted" })
  } finally {
    await server.stop(background())
    await running
  }
})

test("ServiceError uses its own HTTP status on both httpRoute and RPC paths", async () => {
  const transport = newNodeHTTPTransport()
  const server = newServer(
    serverTransport(transport),
    address("127.0.0.1:0"),
    httpRoute("POST", "/v1/machine-commands", "machine-gateway", "command", 201)
  )
  server.registerHandler("machine-gateway", "command", function reject(): Response {
    throw serviceError("permission_denied", "machine command rejected", 403)
  })
  const running = server.start(background())
  try {
    const endpoint = await server.endpoint(background())
    const routed = await sendHTTP(new URL("/v1/machine-commands", endpoint).href, "POST", {}, {})
    const rpc = await sendHTTP(new URL("/machine-gateway/command", endpoint).href, "POST", {}, {})
    const routedError = await decodeServiceErrorResponse(
      new Response(routed.text, {
        status: routed.status,
        headers: { "content-type": "application/json" }
      })
    )
    const rpcError = await decodeServiceErrorResponse(
      new Response(rpc.text, {
        status: rpc.status,
        headers: { "content-type": "application/json" }
      })
    )

    expect(routed.status).toBe(403)
    expect(rpc.status).toBe(403)
    expect(routedError).toMatchObject({ code: "permission_denied", status: 403 })
    expect(rpcError).toMatchObject({
      code: "permission_denied",
      message: "machine command rejected"
    })
    expect(routed.header["go-like-service-error"]).toBeUndefined()
  } finally {
    await server.stop(background())
    await running
  }
})

test("unregistered and method-mismatched paths use Fetch status codes", async () => {
  let calls = 0
  const transport = newNodeHTTPTransport()
  const server = newServer(
    serverTransport(transport),
    address("127.0.0.1:0"),
    httpRoute("POST", "/v1/machine-commands", "machine-gateway", "command", 201)
  )
  server.registerHandler("machine-gateway", "command", function handle(): Response {
    calls += 1
    return accepted()
  })
  const running = server.start(background())
  try {
    const endpoint = await server.endpoint(background())
    const missing = await sendHTTP(new URL("/v1/other-commands", endpoint).href, "POST", {}, {})
    const method = await sendHTTP(new URL("/v1/machine-commands", endpoint).href, "GET")
    const livez = await sendHTTP(new URL("/livez", endpoint).href, "GET")

    expect(calls).toBe(0)
    expect(missing.status).toBe(404)
    expect(JSON.parse(missing.text)).toMatchObject({ code: "not_found" })
    expect(method.status).toBe(405)
    expect(method.header.allow).toBe("POST")
    expect(JSON.parse(method.text)).toMatchObject({ code: "method_not_allowed" })
    expect(livez.status).toBe(404)
    expect(JSON.parse(livez.text)).toMatchObject({ code: "not_found", message: "not found" })
  } finally {
    await server.stop(background())
    await running
  }
})

test("GET and HEAD /healthz are empty 200 responses", async () => {
  const transport = newNodeHTTPTransport()
  const server = newServer(serverTransport(transport), address("127.0.0.1:0"))
  server.registerHandler("machine-gateway", "command", function handle(): Response {
    return accepted()
  })
  const running = server.start(background())
  try {
    const endpoint = await server.endpoint(background())
    const get = await sendHTTP(new URL("/healthz", endpoint).href, "GET")
    const head = await sendHTTP(new URL("/healthz", endpoint).href, "HEAD")

    expect(get.status).toBe(200)
    expect(get.text).toBe("")
    expect(head.status).toBe(200)
    expect(head.text).toBe("")
  } finally {
    await server.stop(background())
    await running
  }
})
