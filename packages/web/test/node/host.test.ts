import { createServer, request } from "node:http"

import { expect, test } from "bun:test"
import { background } from "@go-like/context"

import { newNodeServer, nodeShutdownTimeout, port } from "../../src/node"

/** Reserves and releases one loopback TCP port for a deterministic host test. */
async function availablePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", resolve)
  })
  const address = probe.address()
  if (address === null || typeof address === "string") {
    throw new Error("port probe did not bind a TCP address")
  }
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    })
  })
  return address.port
}

interface HTTPResult {
  readonly body: string
  readonly status: number
}

/** Sends one non-pooled Node request so the accepted socket reaches close. */
function requestOnce(port: number, path: string): Promise<HTTPResult> {
  return new Promise<HTTPResult>((resolve, reject) => {
    const outgoing = request(
      {
        agent: false,
        headers: { connection: "close" },
        host: "127.0.0.1",
        path,
        port
      },
      (incoming) => {
        const chunks: Buffer[] = []
        incoming.on("data", (chunk: Buffer) => {
          chunks.push(chunk)
        })
        incoming.on("end", () => {
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            status: incoming.statusCode ?? 0
          })
        })
      }
    )
    outgoing.once("error", reject)
    outgoing.end()
  })
}

/** Waits until one loopback HTTP listener accepts requests. */
async function requestWhenReady(port: number, path: string): Promise<HTTPResult> {
  const deadline = Date.now() + 2_000
  let failure: unknown = null
  while (Date.now() < deadline) {
    try {
      return await requestOnce(port, path)
    } catch (error) {
      failure = error
      await Bun.sleep(5)
    }
  }
  throw new Error("Node Web listener did not become ready", { cause: failure })
}

test("endpoint binds once and shares the listener with start", async () => {
  const server = newNodeServer(() => new Response("endpoint"), nodeShutdownTimeout(0))
  const endpoint = await server.endpoint(background())
  const running = server.start(background())

  try {
    const url = new URL(endpoint)
    const response = await requestOnce(Number(url.port), "/")
    expect(response.status).toBe(200)
    expect(response.body).toBe("endpoint")
    expect(await server.endpoint(background())).toBe(endpoint)
  } finally {
    await Bun.sleep(10)
    await server.stop(background())
    await expect(running).rejects.toMatchObject({ code: "GO_LIKE_NODE_SERVER_FORCE_CLOSE" })
  }

  await expect(server.start(background())).rejects.toMatchObject({
    name: "NodeServerAlreadyStartedError"
  })
})

test("clean stop during startup settles and releases the real Node port", async () => {
  const listenPort = await availablePort()
  const server = newNodeServer(() => new Response("unused"), port(listenPort))
  const starting = server.start(background())
  const stopping = server.stop(background())

  const outcome = await Promise.race([
    Promise.all([starting, stopping]).then(() => "settled" as const),
    Bun.sleep(500).then(() => "timeout" as const)
  ])
  expect(outcome).toBe("settled")

  const rebound = createServer()
  await new Promise<void>((resolve, reject) => {
    rebound.once("error", reject)
    rebound.listen(listenPort, "127.0.0.1", resolve)
  })
  await new Promise<void>((resolve, reject) => {
    rebound.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    })
  })
})

test("delegates the one-argument Fetch ABI to the upstream Node host without replacing globals", async () => {
  const originalRequest = Request
  const originalResponse = Response
  const observed: { arguments: number; request: Request | null } = {
    arguments: 0,
    request: null
  }
  const listenPort = await availablePort()
  const server = newNodeServer(
    function handler(request) {
      observed.arguments = arguments.length
      observed.request = request
      return Response.json(
        { path: new URL(request.url).pathname },
        { headers: { connection: "close" } }
      )
    },
    port(listenPort),
    nodeShutdownTimeout(0)
  )
  const running = server.start(background())

  try {
    const response = await requestWhenReady(listenPort, "/upstream")
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toEqual({ path: "/upstream" })
    expect(observed.arguments).toBe(1)
    expect(observed.request).toBeInstanceOf(originalRequest)
    expect(Request).toBe(originalRequest)
    expect(Response).toBe(originalResponse)
  } finally {
    await Bun.sleep(10)
    await server.stop(background())
    await expect(running).rejects.toMatchObject({ code: "GO_LIKE_NODE_SERVER_FORCE_CLOSE" })
  }

  const rebound = createServer((_request, response) => response.end("rebound"))
  await new Promise<void>((resolve, reject) => {
    rebound.once("error", reject)
    rebound.listen(listenPort, "127.0.0.1", resolve)
  })
  await new Promise<void>((resolve, reject) => {
    rebound.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    })
  })
})

test("rejects an occupied port without waiting for a close event from a listener that never activated", async () => {
  const listenPort = await availablePort()
  const owner = newNodeServer(
    () => new Response("owner", { headers: { connection: "close" } }),
    port(listenPort),
    nodeShutdownTimeout(0)
  )
  const ownerRunning = owner.start(background())
  await requestWhenReady(listenPort, "/")
  await Bun.sleep(10)

  try {
    const occupied = newNodeServer(() => new Response("occupied"), port(listenPort))
    const failure = await occupied.start(background()).catch((error: unknown) => error)
    const primary = failure instanceof AggregateError ? failure.cause : failure
    expect(primary).toMatchObject({ code: "EADDRINUSE" })
  } finally {
    await owner.stop(background())
    await expect(ownerRunning).rejects.toMatchObject({ code: "GO_LIKE_NODE_SERVER_FORCE_CLOSE" })
  }
})
