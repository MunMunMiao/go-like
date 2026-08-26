import { createAdaptorServer, type ServerType } from "../../src/node-fetch-bridge"
import { Agent, request as nodeRequest, type IncomingHttpHeaders } from "node:http"
import { Socket } from "node:net"
import { inspect } from "node:util"
import { expect, test } from "bun:test"

interface HTTPResult {
  readonly body: string
  readonly headers: IncomingHttpHeaders
  readonly status: number
}

async function listen(server: ServerType): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (address === null || typeof address === "string") {
    throw new Error("bridge server did not bind a TCP address")
  }
  return address.port
}

function request(
  port: number,
  path: string,
  options: {
    readonly body?: string
    readonly headers?: Record<string, string>
    readonly method?: string
    readonly agent?: Agent | false
  } = {}
): Promise<HTTPResult> {
  return new Promise<HTTPResult>((resolve, reject) => {
    const outgoing = nodeRequest(
      {
        agent: options.agent ?? false,
        headers: options.headers,
        host: "127.0.0.1",
        method: options.method ?? "GET",
        path,
        port
      },
      (incoming) => {
        const chunks: Buffer[] = []
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk))
        incoming.on("end", () => {
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            headers: incoming.headers,
            status: incoming.statusCode ?? 0
          })
        })
      }
    )
    outgoing.once("error", reject)
    if (options.body !== undefined) outgoing.write(options.body)
    outgoing.end()
  })
}

async function rawRequest(port: number, requestText: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const socket = new Socket()
    let response = ""
    socket.setEncoding("utf8")
    socket.on("data", (chunk: string) => {
      response += chunk
    })
    socket.once("error", reject)
    socket.once("end", () => resolve(response))
    socket.connect(port, "127.0.0.1", () => socket.write(requestText))
  })
}

async function rawRequestAndDestroy(port: number, requestText: string, waitMs = 10): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new Socket()
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve()
    }
    socket.once("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ECONNRESET") finish()
      else reject(error)
    })
    socket.once("close", finish)
    socket.connect(port, "127.0.0.1", () => {
      socket.write(requestText, () => {
        setTimeout(() => socket.destroy(), waitMs)
      })
    })
  })
}

async function rawRequestWithChunksAndDestroy(
  port: number,
  chunks: readonly string[],
  waitMs = 10
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new Socket()
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve()
    }
    socket.once("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ECONNRESET") finish()
      else reject(error)
    })
    socket.once("close", finish)
    socket.connect(port, "127.0.0.1", () => {
      let index = 0
      const writeNext = (): void => {
        const chunk = chunks[index]
        if (chunk === undefined) {
          setTimeout(() => socket.destroy(), waitMs)
          return
        }
        index += 1
        socket.write(chunk, writeNext)
      }
      writeNext()
    })
  })
}

async function rawRequestAndWaitForServerClose(port: number, requestText: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const socket = new Socket()
    let response = ""
    let settled = false
    let timer: ReturnType<typeof setTimeout>
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(response)
    }
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      reject(error)
    }
    timer = setTimeout(fail, 1_500, new Error("server did not close the response connection"))
    socket.setEncoding("utf8")
    socket.on("data", (chunk: string) => {
      response += chunk
    })
    socket.once("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ECONNRESET") finish()
      else fail(error)
    })
    socket.once("close", finish)
    socket.connect(port, "127.0.0.1", () => socket.write(requestText))
  })
}

async function rawRequestUntilClose(
  port: number,
  requestText: string,
  body?: Uint8Array
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const socket = new Socket()
    let response = ""
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(new Error("server did not close the incomplete request body"))
    }, 1_500)
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(response)
    }
    socket.setEncoding("utf8")
    socket.on("data", (chunk: string) => {
      response += chunk
    })
    socket.once("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ECONNRESET") finish()
      else reject(error)
    })
    socket.once("close", finish)
    socket.connect(port, "127.0.0.1", () => {
      if (body) socket.write(requestText, () => socket.write(body))
      else socket.write(requestText)
    })
  })
}

async function rawRequestAndDestroyAfterFirstData(
  port: number,
  requestText: string
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const socket = new Socket()
    let response = ""
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(response)
    }
    socket.setEncoding("utf8")
    socket.on("data", (chunk: string) => {
      response += chunk
      if (response.includes("first")) setTimeout(finish, 25)
    })
    socket.once("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ECONNRESET") finish()
      else reject(error)
    })
    socket.once("close", finish)
    socket.connect(port, "127.0.0.1", () => socket.write(requestText))
  })
}

async function rawRequestWithPausedClient(
  port: number,
  requestText: string,
  pauseMs: number
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const socket = new Socket()
    let response = ""
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(response)
    }
    socket.setEncoding("utf8")
    socket.on("data", (chunk: string) => {
      response += chunk
    })
    socket.once("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ECONNRESET") finish()
      else reject(error)
    })
    socket.once("close", finish)
    socket.connect(port, "127.0.0.1", () => {
      socket.pause()
      socket.write(requestText)
      setTimeout(() => socket.resume(), pauseMs)
    })
  })
}

function timed<T>(promise: Promise<T>, timeoutMs = 1000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)
    )
  ])
}

async function withBridge(
  fetch: (request: Request) => Response | Promise<Response>,
  run: (port: number, server: ServerType) => Promise<void>
): Promise<void> {
  const server = createAdaptorServer({ fetch, hostname: "127.0.0.1" })
  await listen(server)
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("bridge address unavailable")
  try {
    await run(address.port, server)
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  }
}

test("bridges request URL, headers, response headers, and status over node:http", async () => {
  await withBridge(
    (request) => {
      expect(request.method).toBe("GET")
      expect(request.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/orders\?state=open$/u)
      expect(request.headers.get("x-request-id")).toBe("request-1")
      const headers = new Headers({ "x-response": "present" })
      headers.append("set-cookie", "a=1")
      headers.append("set-cookie", "b=2")
      return new Response("found", { headers, status: 201 })
    },
    async (port) => {
      const response = await request(port, "/orders?state=open", {
        headers: { "x-request-id": "request-1" }
      })
      expect(response.status).toBe(201)
      expect(response.body).toBe("found")
      expect(response.headers["x-response"]).toBe("present")
      expect(response.headers["set-cookie"]).toEqual(["a=1", "b=2"])
    }
  )
})

test("reads a POST body once and exposes standard Request body state", async () => {
  await withBridge(
    async (request) => {
      const body = await request.text()
      const secondRead = await request.text().then(
        () => "unexpected-success",
        (error: unknown) => (error instanceof Error ? error.message : String(error))
      )
      return Response.json({ body, bodyUsed: request.bodyUsed, secondRead })
    },
    async (port) => {
      const response = await request(port, "/payload", {
        body: "payload",
        headers: { "content-type": "text/plain", "content-length": "7" },
        method: "POST"
      })
      expect(response.status).toBe(200)
      expect(JSON.parse(response.body)).toEqual({
        body: "payload",
        bodyUsed: true,
        secondRead: "Body is unusable"
      })
    }
  )
})

test("materializes standard Request metadata and preserves clone semantics", async () => {
  await withBridge(
    (request) => {
      const clone = request.clone()
      return Response.json({
        bodyIsNull: request.body === null,
        bodyUsed: request.bodyUsed,
        cache: request.cache,
        cloneBodyIsNull: clone.body === null,
        cloneMethod: clone.method,
        credentials: request.credentials,
        destination: request.destination,
        integrity: request.integrity,
        instanceOfRequest: request instanceof Request,
        method: request.method,
        mode: request.mode,
        redirect: request.redirect,
        referrer: request.referrer,
        referrerPolicy: request.referrerPolicy,
        signalAborted: request.signal.aborted,
        url: request.url
      })
    },
    async (port) => {
      const response = await request(port, "/metadata")
      expect(response.status).toBe(200)
      expect(JSON.parse(response.body)).toMatchObject({
        bodyIsNull: true,
        bodyUsed: false,
        cache: "default",
        cloneBodyIsNull: true,
        cloneMethod: "GET",
        credentials: "include",
        destination: "",
        integrity: "",
        instanceOfRequest: true,
        method: "GET",
        mode: "cors",
        redirect: "follow",
        referrer: "",
        referrerPolicy: "",
        signalAborted: false,
        url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/metadata$/u)
      })
    }
  )
})

test("materializes GET state without consuming a request body", async () => {
  await withBridge(
    (request) =>
      Response.json({
        bodyIsNull: request.body === null,
        bodyUsed: request.bodyUsed,
        signalAborted: request.signal.aborted,
        text: "" as string
      }),
    async (port) => {
      const response = await request(port, "/get-state")
      expect(JSON.parse(response.body)).toEqual({
        bodyIsNull: true,
        bodyUsed: false,
        signalAborted: false,
        text: ""
      })
    }
  )
})

test("materializes TRACE requests before and after direct body reads", async () => {
  await withBridge(
    async (request) => {
      const path = new URL(request.url).pathname
      if (path === "/trace-cache") {
        const native = new Request(request)
        return new Response(null, {
          headers: {
            "x-body-is-null": String(request.body === null),
            "x-method": request.method,
            "x-native-method": native.method
          },
          status: 204
        })
      }
      await request.text()
      const native = new Request(request)
      return new Response(null, {
        headers: {
          "x-body-is-null": String(request.body === null),
          "x-method": request.method,
          "x-native-method": native.method
        },
        status: 204
      })
    },
    async (port) => {
      const cached = await request(port, "/trace-cache", { method: "TRACE" })
      expect(cached.status).toBe(204)
      expect(cached.headers["x-body-is-null"]).toBe("true")
      expect(cached.headers["x-method"]).toBe("TRACE")
      expect(cached.headers["x-native-method"]).toBe("TRACE")

      const afterRead = await request(port, "/trace-after-read", { method: "TRACE" })
      expect(afterRead.status).toBe(204)
      expect(afterRead.headers["x-body-is-null"]).toBe("true")
      expect(afterRead.headers["x-method"]).toBe("TRACE")
      expect(afterRead.headers["x-native-method"]).toBe("TRACE")
    }
  )
})

test("supports direct body formats, form data, and post-read body recovery", async () => {
  await withBridge(
    async (request) => {
      const path = new URL(request.url).pathname
      if (path === "/array-buffer") {
        return new Response(new TextDecoder().decode(await request.arrayBuffer()))
      }
      if (path === "/blob") {
        const blob = await request.blob()
        return Response.json({ size: blob.size, text: await blob.text(), type: blob.type })
      }
      if (path === "/json") return Response.json(await request.json())
      if (path === "/form") {
        const form = await request.formData()
        return Response.json({ name: form.get("name"), role: form.get("role") })
      }
      if (path === "/direct-state") {
        const body = await request.text()
        const recovered = request.body
        return Response.json({
          body,
          bodyLocked: recovered?.locked ?? false,
          bodyUsed: request.bodyUsed,
          hasBody: recovered !== null
        })
      }
      return new Response("not found", { status: 404 })
    },
    async (port) => {
      const arrayBuffer = await request(port, "/array-buffer", { body: "bytes", method: "POST" })
      expect(arrayBuffer.body).toBe("bytes")

      const blob = await request(port, "/blob", {
        body: "blob-body",
        headers: { "content-type": "text/custom" },
        method: "POST"
      })
      expect(JSON.parse(blob.body)).toEqual({ size: 9, text: "blob-body", type: "text/custom" })

      const json = await request(port, "/json", {
        body: JSON.stringify({ ok: true }),
        headers: { "content-type": "application/json" },
        method: "POST"
      })
      expect(JSON.parse(json.body)).toEqual({ ok: true })

      const form = await request(port, "/form", {
        body: "name=mun&role=cat",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST"
      })
      expect(JSON.parse(form.body)).toEqual({ name: "mun", role: "cat" })

      const directState = await request(port, "/direct-state", {
        body: "direct",
        method: "POST"
      })
      expect(JSON.parse(directState.body)).toEqual({
        body: "direct",
        bodyLocked: true,
        bodyUsed: true,
        hasBody: true
      })
    }
  )
})

test("recovers a complete body after the client closes the socket", async () => {
  const bodies: string[] = []
  const waiters: Array<() => void> = []
  await withBridge(
    async (request) => {
      bodies.push(await request.text())
      waiters.shift()?.()
      return new Response("ok")
    },
    async (port) => {
      const waitForBody = (): Promise<void> =>
        timed(
          new Promise<void>((resolve) => {
            if (bodies.length > 0 && waiters.length === 0) resolve()
            else waiters.push(resolve)
          })
        )

      await rawRequestAndDestroy(
        port,
        "POST /recovered HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 11\r\nConnection: close\r\n\r\nhello-world",
        10
      )
      await waitForBody()
      expect(bodies).toEqual(["hello-world"])

      await rawRequestWithChunksAndDestroy(
        port,
        [
          "POST /recovered HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 11\r\nConnection: close\r\n\r\nhello-",
          "world"
        ],
        10
      )
      await timed(
        new Promise<void>((resolve) => {
          if (bodies.length === 2) resolve()
          else waiters.push(resolve)
        })
      )
      expect(bodies).toEqual(["hello-world", "hello-world"])
    }
  )
})

test("reads a complete buffered body after the handler yields before reading", async () => {
  let releaseRead: (() => void) | undefined
  const readGate = new Promise<void>((resolve) => {
    releaseRead = resolve
  })
  await withBridge(
    async (request) => {
      await readGate
      return new Response(await request.text())
    },
    async (port) => {
      const response = timed(
        request(port, "/buffered-before-read", {
          body: "buffered-body",
          headers: { "content-length": "13" },
          method: "POST"
        })
      )
      await new Promise<void>((resolve) => setTimeout(resolve, 25))
      releaseRead?.()
      const result = await response
      expect(result.status).toBe(200)
      expect(result.body).toBe("buffered-body")
    }
  )
})

test("recovers a buffered lazy body after the client closes before reading", async () => {
  let releaseRead: (() => void) | undefined
  const readGate = new Promise<void>((resolve) => {
    releaseRead = resolve
  })
  const observed = timed(
    new Promise<{ body?: string; error?: string }>((resolve) => {
      void withBridge(
        async (request) => {
          await readGate
          try {
            const body = await request.text()
            resolve({ body })
            return new Response("ok")
          } catch (error) {
            resolve({ error: error instanceof Error ? error.message : String(error) })
            return new Response("failed", { status: 500 })
          }
        },
        async (port) => {
          await rawRequestAndDestroy(
            port,
            "POST /lazy-recovered HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 11\r\nConnection: close\r\n\r\nhello-world",
            10
          )
          releaseRead?.()
        }
      ).catch((error: unknown) => {
        resolve({ error: error instanceof Error ? error.message : String(error) })
      })
    })
  )
  const result = await observed
  expect(result).toEqual({ body: "hello-world" })
})

test("rejects a truncated body after a real client disconnect", async () => {
  let observed: { body?: string; error?: string } | undefined
  await withBridge(
    async (request) => {
      try {
        observed = { body: await request.text() }
      } catch (error) {
        observed = { error: error instanceof Error ? error.message : String(error) }
      }
      return new Response("ignored")
    },
    async (port) => {
      await rawRequestAndDestroy(
        port,
        "POST /truncated HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 11\r\nConnection: close\r\n\r\nhello",
        10
      )
      await timed(
        new Promise<void>((resolve) => {
          const check = (): void => {
            if (observed !== undefined) resolve()
            else setTimeout(check, 1)
          }
          check()
        })
      )
    }
  )
  expect(observed).toEqual({ error: "aborted" })
})

test("streams a delayed response body without losing chunks", async () => {
  await withBridge(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            await Promise.resolve()
            controller.enqueue(new TextEncoder().encode("first"))
            await new Promise<void>((resolve) => setTimeout(resolve, 5))
            controller.enqueue(new TextEncoder().encode("second"))
            controller.close()
          }
        })
      ),
    async (port) => {
      const response = await request(port, "/delayed")
      expect(response.status).toBe(200)
      expect(response.body).toBe("firstsecond")
    }
  )
})

test("hands a delayed non-chunked response body to the streaming writer", async () => {
  await withBridge(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            await new Promise<void>((resolve) => setTimeout(resolve, 20))
            controller.enqueue(new TextEncoder().encode("delayed"))
            controller.close()
          }
        })
      ),
    async (port) => {
      const response = await timed(request(port, "/delayed-non-chunked"))
      expect(response.status).toBe(200)
      expect(response.body).toBe("delayed")
    }
  )
})

test("closes a real response stream after a later reader error", async () => {
  await withBridge(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("first"))
          },
          async pull(controller) {
            await new Promise<void>((resolve) => setTimeout(resolve, 20))
            controller.error(new Error("late stream failure"))
          }
        }),
        { headers: { "transfer-encoding": "chunked" } }
      ),
    async (port) => {
      const response = await timed(
        rawRequestAndWaitForServerClose(
          port,
          "GET /late-stream-error HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
        ),
        2000
      )
      expect(response).toContain("first")
    }
  )
})

test("uses lazy request streams and preserves TRACE after direct body consumption", async () => {
  await withBridge(
    async (request) => {
      const path = new URL(request.url).pathname
      if (path === "/lazy") {
        const cloned = request.clone()
        return Response.json({ method: cloned.method, text: await cloned.text() })
      }
      const text = await request.text()
      return Response.json({ body: request.body === null, method: request.method, text })
    },
    async (port) => {
      const lazy = await request(port, "/lazy", { body: "lazy-body", method: "POST" })
      expect(JSON.parse(lazy.body)).toEqual({ method: "POST", text: "lazy-body" })

      const traced = await request(port, "/trace-body", { method: "TRACE" })
      expect(traced.status).toBe(200)
      expect(JSON.parse(traced.body)).toEqual({ body: true, method: "TRACE", text: "" })
      expect(traced.headers["content-length"]).toBe("40")
    }
  )
})

test("recovers a body that was fully buffered before a direct read", async () => {
  let releaseRead: (() => void) | undefined
  const readGate = new Promise<void>((resolve) => {
    releaseRead = resolve
  })
  let observed: { body?: string; error?: string } | undefined
  await withBridge(
    async (request) => {
      await readGate
      try {
        observed = { body: await request.text() }
      } catch (error) {
        observed = { error: error instanceof Error ? error.message : String(error) }
      }
      return new Response("ok")
    },
    async (port) => {
      await rawRequestAndDestroy(
        port,
        "POST /buffered-direct HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 11\r\nConnection: close\r\n\r\nhello-world",
        100
      )
      releaseRead?.()
      await timed(
        new Promise<void>((resolve) => {
          const check = (): void => {
            if (observed !== undefined) resolve()
            else setTimeout(check, 1)
          }
          check()
        })
      )
    }
  )
  expect(observed).toEqual({ body: "hello-world" })
})

test("constructs a replacement after direct TRACE consumption", async () => {
  await withBridge(
    async (request) => {
      const RequestConstructor = Object.getPrototypeOf(Object.getPrototypeOf(request))
        .constructor as typeof Request
      await request.text()
      const replacement = new RequestConstructor(request, { method: "POST", body: "replacement" })
      return new Response(null, {
        headers: {
          "x-replacement-body": await replacement.text(),
          "x-replacement-method": replacement.method
        },
        status: 204
      })
    },
    async (port) => {
      const response = await request(port, "/trace-replacement", { method: "TRACE" })
      expect(response.status).toBe(204)
      expect(response.headers["x-replacement-body"]).toBe("replacement")
      expect(response.headers["x-replacement-method"]).toBe("POST")
    }
  )
})

test("treats a premature response stream close as a client abort", async () => {
  await withBridge(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("first"))
          },
          async pull(controller) {
            await new Promise<void>((resolve) => setTimeout(resolve, 20))
            controller.error(
              Object.assign(new Error("premature"), { code: "ERR_STREAM_PREMATURE_CLOSE" })
            )
          }
        }),
        { headers: { "transfer-encoding": "chunked" } }
      ),
    async (port) => {
      const response = await timed(
        rawRequestAndWaitForServerClose(
          port,
          "GET /premature-response HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
        ),
        2000
      )
      expect(response).toContain("first")
    }
  )
})

test("force-closes a real incomplete unread request body", async () => {
  await withBridge(
    () => new Response("ok"),
    async (port) => {
      const response = await timed(
        rawRequestUntilClose(
          port,
          "POST /incomplete-unread HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100000000\r\nConnection: keep-alive\r\n\r\nhello"
        ),
        2000
      )
      expect(response).toMatch(/HTTP\/1\.1 200 /u)
      expect(response).toContain("\r\n\r\nok")
    }
  )
})

test("force-closes incomplete request bodies after synchronous 500 and construction 400", async () => {
  for (const scenario of [
    { name: "sync-fetch-error", target: "/sync-fetch-error", status: 500 },
    { name: "malformed-absolute-url", target: "http://%zz", status: 400 }
  ] as const) {
    await withBridge(
      () => {
        if (scenario.status === 500) throw new Error("sync fetch failure")
        return new Response("unexpected")
      },
      async (port) => {
        const started = Date.now()
        const response = await rawRequestUntilClose(
          port,
          `POST ${scenario.target} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100000000\r\nConnection: keep-alive\r\n\r\nhello`
        )
        expect(response).toMatch(new RegExp(`HTTP/1\\.1 ${scenario.status} `, "u"))
        expect(Date.now() - started).toBeLessThan(1_000)
      }
    )
  }
})

test("force-closes an unread request body over the drain byte budget", async () => {
  const body = new Uint8Array(64 * 1024 * 1024 + 1)
  await withBridge(
    () => new Response("ok"),
    async (port) => {
      const response = await timed(
        rawRequestUntilClose(
          port,
          `POST /oversized-unread HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: ${body.length}\r\nConnection: keep-alive\r\n\r\n`,
          body
        ),
        2000
      )
      expect(response).toMatch(/HTTP\/1\.1 200 /u)
      expect(response).toContain("\r\n\r\nok")
    }
  )
})

test("drains and releases close listeners across repeated keep-alive requests", async () => {
  const agent = new Agent({ keepAlive: true, maxSockets: 1 })
  const warnings: Error[] = []
  const onWarning = (warning: Error): void => {
    if (warning.name === "MaxListenersExceededWarning") warnings.push(warning)
  }
  process.on("warning", onWarning)
  try {
    await withBridge(
      () => new Response("ok"),
      async (port, server) => {
        let connectionCount = 0
        let socket: Socket | undefined
        server.on("connection", (connection) => {
          connectionCount += 1
          socket = connection
        })
        const first = await request(port, "/unread", {
          agent,
          body: "unread-body".repeat(128),
          headers: { "content-length": String("unread-body".repeat(128).length) },
          method: "POST"
        })
        expect(first.status).toBe(200)
        expect(first.body).toBe("ok")
        if (!socket) throw new Error("keep-alive server socket was not observed")
        const stableCloseListeners = socket.listenerCount("close")

        for (let index = 1; index < 12; index++) {
          const reused = await request(port, `/reused-${index}`, { agent })
          expect(reused.status).toBe(200)
          expect(reused.body).toBe("ok")
          expect(socket.listenerCount("close")).toBe(stableCloseListeners)
        }
        await new Promise<void>((resolve) => setTimeout(resolve))
        expect(connectionCount).toBe(1)
        expect(warnings).toEqual([])
      }
    )
  } finally {
    process.off("warning", onWarning)
    agent.destroy()
  }
})

test("uses the configured hostname and rejects malformed absolute request targets", async () => {
  await withBridge(
    (request) => new Response(request.url),
    async (port) => {
      const hostless = await rawRequest(port, "GET /hostless HTTP/1.0\r\nConnection: close\r\n\r\n")
      expect(hostless).toMatch(/HTTP\/1\.1 200 /u)
      expect(hostless).toContain("\r\n\r\nhttp://127.0.0.1/hostless")

      const malformed = await rawRequest(
        port,
        "GET http://%zz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"
      )
      expect(malformed).toMatch(/HTTP\/1\.1 400 /u)
    }
  )
})

test("normalizes TRACE and streams a readable response", async () => {
  await withBridge(
    (request) => {
      if (request.method === "TRACE") return new Response(null, { status: 204 })
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("first"))
          controller.enqueue(new TextEncoder().encode("second"))
          controller.close()
        }
      })
      return new Response(stream)
    },
    async (port) => {
      const traced = await request(port, "/trace", { method: "TRACE" })
      expect(traced.status).toBe(204)
      expect(traced.body).toBe("")
      const streamed = await request(port, "/stream")
      expect(streamed.status).toBe(200)
      expect(streamed.body).toBe("firstsecond")
    }
  )
})

test("cancels a response stream when a real client closes after headers", async () => {
  let cancelCalls = 0
  let release: (() => void) | undefined
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  await withBridge(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("first"))
          },
          async pull(controller) {
            await pending
            controller.enqueue(new TextEncoder().encode("late"))
          },
          cancel() {
            cancelCalls += 1
          }
        }),
        { headers: { "transfer-encoding": "chunked" } }
      ),
    async (port) => {
      const response = await timed(
        rawRequestAndDestroyAfterFirstData(
          port,
          "GET /cancel-response HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
        )
      )
      expect(response).toMatch(/HTTP\/1\.1 200 /u)
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
      expect(cancelCalls).toBe(1)
      release?.()
    }
  )
})

test("maps an actual response stream error to an empty completed response", async () => {
  await withBridge(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error("stream failed"))
          }
        })
      ),
    async (port) => {
      const response = await request(port, "/stream-error")
      expect(response.status).toBe(200)
      expect(response.body).toBe("")
    }
  )
})

test("continues a large response after real client backpressure", async () => {
  const chunk = new Uint8Array(64 * 1024)
  let pulls = 0
  await withBridge(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1
            controller.enqueue(chunk)
            if (pulls === 128) controller.close()
          }
        }),
        { headers: { "transfer-encoding": "chunked" } }
      ),
    async (port) => {
      const response = await timed(
        rawRequestWithPausedClient(
          port,
          "GET /backpressure HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
          25
        ),
        5000
      )
      expect(pulls).toBe(128)
      expect(response).toContain("0\r\n\r\n")
    }
  )
})

test("covers raw URL forms, method normalization, and host validation", async () => {
  await withBridge(
    (request) =>
      Response.json({
        method: request.method,
        url: request.url,
        host: request.headers.get("host")
      }),
    async (port) => {
      const dotSegments = await rawRequest(
        port,
        "GET /a/../b HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
      )
      expect(dotSegments).toContain('"url":"http://127.0.0.1/b"')

      const absolute = await rawRequest(
        port,
        `GET http://127.0.0.1:${port}/absolute HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`
      )
      expect(absolute).toContain(`"url":"http://127.0.0.1:${port}/absolute"`)

      const custom = await request(port, "/custom", { method: "PURGE" })
      expect(JSON.parse(custom.body).method).toBe("PURGE")

      const query = await rawRequest(
        port,
        "QUERY /query HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
      )
      expect(query).toContain('"method":"QUERY"')

      const normalizedHost = await rawRequest(
        port,
        "GET /normalized-host HTTP/1.1\r\nHost: foo:08080\r\nConnection: close\r\n\r\n"
      )
      expect(normalizedHost).toContain('"url":"http://foo:8080/normalized-host"')

      const invalidHost = await rawRequest(
        port,
        "GET /invalid-host HTTP/1.1\r\nHost: 127.1:80\r\nConnection: close\r\n\r\n"
      )
      expect(invalidHost).toMatch(/HTTP\/1\.1 400 /u)
    }
  )
})

test("maps invalid JSON and native method rejection to safe HTTP errors", async () => {
  let unsupportedReached = false
  await withBridge(
    async (request) => {
      const path = new URL(request.url).pathname
      if (path === "/json") return Response.json(await request.json())
      unsupportedReached = true
      return new Response(await request.text())
    },
    async (port) => {
      const invalidJson = await request(port, "/json", {
        body: "not-json",
        headers: { "content-type": "application/json" },
        method: "POST"
      })
      expect(invalidJson.status).toBe(500)

      const unsupported = await request(port, "/unsupported", { method: "TRACK" })
      expect(unsupported.status).toBe(400)
      expect(unsupportedReached).toBe(false)
    }
  )
})

test("exposes replacement requests, metadata, body locks, and inspect output", async () => {
  await withBridge(
    async (request) => {
      const replacement = new Request(request, { body: "replacement", method: "POST" })
      const replacementStream = new Request(request, {
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("stream-replacement"))
            controller.close()
          }
        }),
        method: "POST"
      })
      const direct = await request.text()
      const body = request.body
      const bodyLockedBeforeRead = body?.locked ?? false
      const formDataError = await request.formData().then(
        () => "unexpected-success",
        (error: unknown) => (error instanceof Error ? error.message : String(error))
      )
      return Response.json({
        direct,
        formDataError,
        inspect: inspect(request),
        metadata: {
          cache: request.cache,
          credentials: request.credentials,
          destination: request.destination,
          integrity: request.integrity,
          keepalive: request.keepalive,
          mode: request.mode,
          redirect: request.redirect,
          referrer: request.referrer,
          referrerPolicy: request.referrerPolicy
        },
        replacement: await replacement.text(),
        replacementStream: await replacementStream.text(),
        bodyLockedBeforeRead,
        bodyUsed: request.bodyUsed
      })
    },
    async (port) => {
      const response = await request(port, "/replacement", {
        body: "original",
        method: "POST"
      })
      const result = JSON.parse(response.body)
      expect(response.status).toBe(200)
      expect(result.direct).toBe("original")
      expect(result.formDataError).toBe("Body already used")
      expect(result.replacement).toBe("replacement")
      expect(result.replacementStream).toBe("stream-replacement")
      expect(result.bodyLockedBeforeRead).toBe(false)
      expect(result.bodyUsed).toBe(true)
      expect(result.metadata).toMatchObject({
        cache: "default",
        credentials: "include",
        destination: "",
        mode: "cors",
        redirect: "follow",
        referrer: "",
        referrerPolicy: ""
      })
      expect(result.inspect).toContain("Request (lightweight)")
    }
  )
})

test("covers null responses and locked response streams", async () => {
  await withBridge(
    (request) => {
      const path = new URL(request.url).pathname
      if (path === "/locked") {
        const stream = new ReadableStream({
          start(controller) {
            controller.close()
          }
        })
        stream.getReader()
        return new Response(stream)
      }
      return new Response(null, { status: 204, headers: { "x-empty": "yes" } })
    },
    async (port) => {
      const empty = await request(port, "/empty")
      expect(empty.status).toBe(204)
      expect(empty.body).toBe("")
      expect(empty.headers["x-empty"]).toBe("yes")

      const locked = await request(port, "/locked")
      expect(locked.status).toBe(500)
    }
  )
})

test("maps request, timeout, and response failures to safe HTTP outcomes", async () => {
  await withBridge(
    (request) => {
      const path = new URL(request.url).pathname
      if (path === "/request-error") throw new Error("request failed")
      if (path === "/timeout") {
        const error = new Error("deadline")
        error.name = "TimeoutError"
        return Promise.reject(error)
      }
      if (path === "/response-error") return null as unknown as Response
      return new Response("ok")
    },
    async (port) => {
      const requestFailure = await request(port, "/request-error")
      expect(requestFailure.status).toBe(500)
      expect(requestFailure.body).toBe("")

      const timeout = await request(port, "/timeout")
      expect(timeout.status).toBe(504)
      expect(timeout.body).toBe("")

      const responseFailure = await request(port, "/response-error")
      expect(responseFailure.status).toBe(500)
      expect(responseFailure.body).toContain("null is not an object")
    }
  )
})

test("rejects a consumed request replacement without losing valid replacements", async () => {
  await withBridge(
    async (request) => {
      const RequestConstructor = Object.getPrototypeOf(Object.getPrototypeOf(request))
        .constructor as typeof Request
      await request.text()
      const reuseError = await Promise.resolve()
        .then(() => new RequestConstructor(request))
        .then(
          () => "unexpected-success",
          (error: unknown) => (error instanceof Error ? error.message : String(error))
        )
      const replacement = await new RequestConstructor(request, {
        body: "replacement",
        method: "POST"
      }).text()
      const streamReplacement = await new RequestConstructor(request, {
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("stream-replacement"))
            controller.close()
          }
        }),
        method: "POST"
      }).text()
      return Response.json({ reuseError, replacement, streamReplacement })
    },
    async (port) => {
      const response = await request(port, "/request-reuse", {
        body: "original",
        method: "POST"
      })
      expect(response.status).toBe(200)
      expect(JSON.parse(response.body)).toEqual({
        reuseError: "Cannot construct a Request with a Request object that has already been used.",
        replacement: "replacement",
        streamReplacement: "stream-replacement"
      })
    }
  )
})
