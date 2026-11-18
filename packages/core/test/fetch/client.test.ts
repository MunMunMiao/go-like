import { expect, test } from "bun:test"

import { background, withCancelCause } from "../../src/context"
import {
  headerValue,
  isRetryableStatus,
  newFetchClient,
  parseOrigin,
  type FetchClient,
  type FetchErrors
} from "../../src/fetch/index"

const errors: FetchErrors<"read"> = {
  http(operation, status, body) {
    return Object.assign(new Error("http"), { operation, status, body })
  },
  transport(operation, cause) {
    return Object.assign(new Error("transport"), { operation, cause })
  },
  protocol(operation) {
    return Object.assign(new Error("protocol"), { operation })
  }
}

/** Builds one client over a scripted Fetch. */
function client(
  fetch: (input: Request) => Response | Promise<Response>,
  extra: { secret?: boolean; authorize?: (headers: Headers) => void; errorBodyBytes?: number } = {}
): FetchClient<"read"> {
  return newFetchClient({
    fetch: (request) => Promise.resolve(fetch(request)),
    origin: parseOrigin("https://example.test", "example"),
    secret: extra.secret ?? false,
    errors,
    ...(extra.authorize === undefined ? {} : { authorize: extra.authorize }),
    ...(extra.errorBodyBytes === undefined ? {} : { errorBodyBytes: extra.errorBodyBytes })
  })
}

/** One JSON response. */
function jsonResponse(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), { status })
}

test("parses origins and header values without echoing the input", () => {
  expect(parseOrigin("https://example.test", "example").origin).toBe("https://example.test")
  expect(parseOrigin("http://example.test", "example").protocol).toBe("http:")
  expect(() => parseOrigin("https://example.test", "")).toThrow("origin label")
  expect(() => parseOrigin("not a url", "example")).toThrow("example origin must be an http")
  expect(() => parseOrigin("https://user:pass@example.test", "example")).toThrow("without extra")
  expect(() => parseOrigin("https://example.test/extra", "example")).toThrow("without extra")
  expect(() => parseOrigin("https://example.test/?q=1", "example")).toThrow("without extra")
  expect(() => parseOrigin("https://example.test/#x", "example")).toThrow("without extra")
  expect(headerValue("token", "authorization", "example")).toBe("token")
  expect(() => headerValue("", "authorization", "example")).toThrow("must be a header value")
  expect(() => headerValue("a\nb", "authorization", "example")).toThrow("must be a header value")
  expect(() => headerValue("token", "bad name", "example")).toThrow("must be a header value")
  expect(() => headerValue("token", "authorization", "")).toThrow("header label")
  expect(isRetryableStatus(408)).toBe(true)
  expect(isRetryableStatus(425)).toBe(true)
  expect(isRetryableStatus(429)).toBe(true)
  expect(isRetryableStatus(500)).toBe(true)
  expect(isRetryableStatus(599)).toBe(true)
  expect(isRetryableStatus(404)).toBe(false)
})

test("rejects invalid client options before any request", () => {
  const origin = parseOrigin("https://example.test", "example")
  expect(() => newFetchClient({ fetch: "no" as never, origin, secret: false, errors })).toThrow(
    "fetch must be a function"
  )
  expect(() =>
    newFetchClient({
      fetch: () => Promise.resolve(new Response(null)),
      origin: "no" as never,
      secret: false,
      errors
    })
  ).toThrow("origin must be a URL")
  expect(() =>
    newFetchClient({
      fetch: () => Promise.resolve(new Response(null)),
      origin: new URL("file:///tmp"),
      secret: false,
      errors
    })
  ).toThrow("origin must be an http or https URL")
  expect(() =>
    newFetchClient({
      fetch: () => Promise.resolve(new Response(null)),
      origin,
      secret: "no" as never,
      errors
    })
  ).toThrow("secret must be a boolean")
  expect(() =>
    newFetchClient({
      fetch: () => Promise.resolve(new Response(null)),
      origin,
      secret: false,
      authorize: "no" as never,
      errors
    })
  ).toThrow("authorize must be a function")
  expect(() =>
    newFetchClient({
      fetch: () => Promise.resolve(new Response(null)),
      origin,
      secret: false,
      errors: null as never
    })
  ).toThrow("errors must provide")
  expect(() =>
    newFetchClient({
      fetch: () => Promise.resolve(new Response(null)),
      origin,
      secret: false,
      errors,
      errorBodyBytes: -1
    })
  ).toThrow(RangeError)
})

test("sends, reads text and JSON, and keeps allowed failures unread", async () => {
  const seen: string[] = []
  const api = client(
    (request) => {
      seen.push(`${request.method} ${request.url}`)
      if (request.headers.get("x-token") !== "secret") return jsonResponse(500, { nope: true })
      if (request.url.endsWith("/text")) return new Response("hello", { status: 200 })
      if (request.url.endsWith("/missing")) return new Response("hidden", { status: 404 })
      return jsonResponse(200, { ok: true })
    },
    {
      authorize(headers) {
        headers.set("x-token", "secret")
      },
      errorBodyBytes: 32
    }
  )
  const sent = await api.send(background(), {
    operation: "read",
    method: "POST",
    path: "/items",
    query: { q: "a" },
    json: { n: 1 }
  })
  expect(sent.status).toBe(200)
  expect(seen[0]).toBe("POST https://example.test/items?q=a")
  expect(
    await api.json(background(), { operation: "read", method: "GET", path: "/items" })
  ).toMatchObject({
    value: { ok: true }
  })
  expect(
    await api.text(background(), {
      operation: "read",
      method: "GET",
      path: "/text",
      accept: "text/plain"
    })
  ).toMatchObject({ text: "hello" })
  const allowed = await api.text(background(), {
    operation: "read",
    method: "GET",
    path: "/missing",
    allow: [404]
  })
  expect(allowed.text).toBe("")
  await expect(
    api.send(background(), { operation: "read", method: "GET", path: "/missing" })
  ).rejects.toMatchObject({ status: 404, body: "hidden" })
  await expect(
    api.json(background(), { operation: "read", method: "GET", path: "/text" })
  ).rejects.toMatchObject({ message: "protocol" })
})

test("hides secret transport failures and rejects malformed requests", async () => {
  const secret = client(() => Promise.reject(new Error("socket")), { secret: true })
  await expect(
    secret.send(background(), { operation: "read", method: "GET", path: "/x" })
  ).rejects.toMatchObject({ cause: expect.objectContaining({ message: "fetch transport failed" }) })
  const plain = client(() => Promise.reject("down"))
  await expect(
    plain.send(background(), { operation: "read", method: "GET", path: "/x" })
  ).rejects.toMatchObject({ message: "transport" })
  const odd = client(() => "no" as never)
  await expect(
    odd.send(background(), { operation: "read", method: "GET", path: "/x" })
  ).rejects.toMatchObject({ message: "protocol" })
  const [ctx, cancel] = withCancelCause(background())
  cancel(new Error("stopped"))
  await expect(plain.send(ctx, { operation: "read", method: "GET", path: "/x" })).rejects.toThrow(
    "stopped"
  )
  const api = client(() => new Response("ok"))
  expect(() =>
    api.send(background(), { operation: "read", method: "TRACE" as never, path: "/x" })
  ).toThrow("fetch method")
  expect(() =>
    api.send(background(), { operation: "read", method: "GET", path: "relative" })
  ).toThrow("absolute path")
  expect(() =>
    api.send(background(), { operation: "read", method: "POST", path: "/x", json: {}, body: "a" })
  ).toThrow("mutually exclusive")
  expect(() =>
    api.send(background(), {
      operation: "read",
      method: "GET",
      path: "/x",
      query: { q: 1 as never }
    })
  ).toThrow("query values")
  const head = await api.send(background(), {
    operation: "read",
    method: "HEAD",
    path: "/x",
    body: "ignored",
    contentType: "text/plain"
  })
  expect(head.status).toBe(200)
})

test("reads newline frames and reports protocol and cancellation failures", async () => {
  const api = client(() => {
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("one\r\ntwo\n"))
          controller.close()
        }
      }),
      { status: 200 }
    )
  })
  const frames = await api.frames(background(), {
    operation: "read",
    method: "GET",
    path: "/frames"
  })
  expect(await frames.next(background())).toBe("one")
  expect(await frames.next(background())).toBe("two")
  expect(await frames.next(background())).toBeNull()
  frames.close()
  frames.close()

  const huge = client(() => new Response(new TextEncoder().encode("abcdef\n"), { status: 200 }))
  const overflow = await huge.frames(
    background(),
    { operation: "read", method: "GET", path: "/frames" },
    { maxFrameBytes: 2 }
  )
  await expect(overflow.next(background())).rejects.toMatchObject({ message: "protocol" })
  expect(() =>
    huge.frames(
      background(),
      { operation: "read", method: "GET", path: "/frames" },
      { maxFrameBytes: 0 }
    )
  ).toThrow(RangeError)

  const broken = client(() => new Response(new Uint8Array([0xff, 0x0a]), { status: 200 }))
  const bad = await broken.frames(background(), {
    operation: "read",
    method: "GET",
    path: "/frames"
  })
  await expect(bad.next(background())).rejects.toMatchObject({ message: "protocol" })

  const empty = client(() => new Response(null, { status: 200 }))
  const none = await empty.frames(background(), {
    operation: "read",
    method: "GET",
    path: "/frames"
  })
  expect(await none.next(background())).toBeNull()
  none.close()

  const denied = client(() => new Response("no", { status: 409 }))
  await expect(
    denied.frames(background(), { operation: "read", method: "GET", path: "/frames", allow: [409] })
  ).rejects.toMatchObject({ status: 409, body: null })

  const [ctx, cancel] = withCancelCause(background())
  const open = await api.frames(background(), { operation: "read", method: "GET", path: "/frames" })
  cancel(new Error("leave"))
  await expect(open.next(ctx)).rejects.toThrow("leave")
  open.close()
  await expect(open.next(background())).rejects.toMatchObject({ message: "protocol" })
})

test("turns invalid UTF-8 and a failed error body into the documented outcomes", async () => {
  const utf8 = client(() => new Response(new Uint8Array([0xff]), { status: 200 }))
  await expect(
    utf8.text(background(), { operation: "read", method: "GET", path: "/bin" })
  ).rejects.toMatchObject({ message: "protocol" })
  const failing = client(
    () => {
      const response = new Response("secret-body", { status: 500 })
      const body = response.body
      if (body !== null) {
        Object.defineProperty(response, "arrayBuffer", {
          value: () => Promise.reject(new Error("unread"))
        })
      }
      return response
    },
    { errorBodyBytes: 8 }
  )
  await expect(
    failing.send(background(), { operation: "read", method: "GET", path: "/bin" })
  ).rejects.toMatchObject({ body: null })
  const canceling = client(() => {
    const response = new Response("x", { status: 404 })
    if (response.body !== null) {
      Object.defineProperty(response.body, "cancel", {
        value: () => Promise.reject(new Error("cancel failed"))
      })
    }
    return response
  })
  expect(
    (
      await canceling.text(background(), {
        operation: "read",
        method: "GET",
        path: "/bin",
        allow: [404]
      })
    ).text
  ).toBe("")

  const brokenRead = client(() => {
    const response = new Response("ok", { status: 200 })
    Object.defineProperty(response, "arrayBuffer", {
      value: () => Promise.reject(new Error("unread"))
    })
    return response
  })
  await expect(
    brokenRead.text(background(), { operation: "read", method: "GET", path: "/bin" })
  ).rejects.toMatchObject({ message: "transport" })
  const allowedJson = client(() => new Response("no", { status: 404 }), { errorBodyBytes: 8 })
  expect(
    (
      await allowedJson.json(background(), {
        operation: "read",
        method: "GET",
        path: "/bin",
        allow: [404]
      })
    ).value
  ).toBeNull()
  const badJson = client(() => new Response(new Uint8Array([0xff]), { status: 200 }))
  await expect(
    badJson.json(background(), { operation: "read", method: "GET", path: "/bin" })
  ).rejects.toMatchObject({ message: "protocol" })
  const unreadJson = client(() => {
    const response = new Response("ok", { status: 200 })
    Object.defineProperty(response, "arrayBuffer", {
      value: () => Promise.reject(new Error("unread"))
    })
    return response
  })
  await expect(
    unreadJson.json(background(), { operation: "read", method: "GET", path: "/bin" })
  ).rejects.toMatchObject({ message: "transport" })
  const missed = client(() => new Response("no", { status: 404 }))
  await expect(
    missed.send(background(), {
      operation: "read",
      method: "GET",
      path: "/bin",
      allow: [400]
    })
  ).rejects.toMatchObject({ status: 404, body: null })
  const exposed = client(() => Promise.reject(new Error("socket")))
  await expect(
    exposed.send(background(), { operation: "read", method: "GET", path: "/bin" })
  ).rejects.toMatchObject({ cause: expect.objectContaining({ message: "socket" }) })

  let errCalls = 0
  const flipping = {
    deadline: () => [new Date(0), false] as const,
    done: () => null,
    err(): Error | null {
      errCalls += 1
      return errCalls === 3 ? new Error("once") : null
    },
    value: () => undefined
  }
  await expect(
    exposed.send(flipping as never, { operation: "read", method: "GET", path: "/bin" })
  ).rejects.toThrow("fetch canceled")

  const partial = client(() => new Response(new TextEncoder().encode("abc"), { status: 200 }))
  const trailing = await partial.frames(background(), {
    operation: "read",
    method: "GET",
    path: "/frames"
  })
  await expect(trailing.next(background())).rejects.toMatchObject({ message: "protocol" })
  await expect(trailing.next(background())).rejects.toMatchObject({ message: "protocol" })

  const failingRead = client(
    () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.error(new Error("read failed"))
          }
        }),
        { status: 200 }
      )
  )
  const brokenFrames = await failingRead.frames(background(), {
    operation: "read",
    method: "GET",
    path: "/frames"
  })
  await expect(brokenFrames.next(background())).rejects.toThrow("read failed")

  const hanging = client(
    () =>
      new Response(
        new ReadableStream({
          pull() {
            return new Promise(() => {})
          }
        }),
        { status: 200 }
      )
  )
  const openFrames = await hanging.frames(background(), {
    operation: "read",
    method: "GET",
    path: "/frames"
  })
  const [frameCtx, cancelFrames] = withCancelCause(background())
  const pendingFrame = openFrames.next(frameCtx)
  cancelFrames(new Error("leave"))
  await expect(pendingFrame).rejects.toThrow("leave")
  openFrames.close()

  const cancelFails = client(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("one\n"))
          },
          cancel() {
            return Promise.reject(new Error("cancel failed"))
          }
        }),
        { status: 200 }
      )
  )
  const closable = await cancelFails.frames(background(), {
    operation: "read",
    method: "GET",
    path: "/frames"
  })
  expect(await closable.next(background())).toBe("one")
  closable.close()
  await new Promise((resolve) => setTimeout(resolve, 0))
})
