import { background } from "@go-like/context"
import {
  address,
  handler,
  newServer,
  transport,
  type Server as ServiceServer
} from "@go-like/server"
import type { Message } from "@go-like/transport"
import { newNodeHTTPTransport } from "@go-like/transport-http/node"
import { hostname, newNodeServer, nodeShutdownTimeout, port } from "@go-like/web/node"
import { readdir } from "node:fs/promises"

const AdmittedMarker = "GO_LIKE_SOAK_WEB_DRAIN_ADMITTED="
const ReadyMarker = "GO_LIKE_SOAK_WEB_READY="
const ResultMarker = "GO_LIKE_SOAK_WEB_RESULT="
const release = Promise.withResolvers<void>()
const unhandled: unknown[] = []
let admittedRequests = 0
let drainedRequests = 0
let released = false
let stopping: Promise<void> | null = null

async function startService(label: string): Promise<{
  readonly endpoint: string
  readonly running: Promise<void>
  readonly server: ServiceServer
}> {
  const server = newServer(
    transport(newNodeHTTPTransport()),
    address("127.0.0.1:0"),
    handler("soak", "Ping", async function ping(): Promise<Message> {
      return { header: {}, body: new TextEncoder().encode(label) }
    })
  )
  const running = server.start(background())
  void running.catch((error) => unhandled.push(error))
  return { endpoint: await server.endpoint(background()), running, server }
}

async function fdCount(): Promise<number | null> {
  const directory = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd"
  try {
    return (await readdir(directory)).length
  } catch {
    return null
  }
}

process.on("unhandledRejection", (reason) => unhandled.push(reason))

const server = newNodeServer(
  async function fetchHandler(request): Promise<Response> {
    const path = new URL(request.url).pathname
    if (path === "/__go-like/soak/runtime") {
      const memory = process.memoryUsage()
      return Response.json({
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        activeHandles: process.getActiveResourcesInfo().length,
        fdCount: await fdCount()
      })
    }
    if (path === "/drain") {
      admittedRequests += 1
      process.stdout.write(`${AdmittedMarker}${JSON.stringify({ admittedRequests })}\n`)
      await release.promise
      drainedRequests += 1
      return new Response("drained")
    }
    return new Response("go-like")
  },
  hostname("0.0.0.0"),
  port(0),
  nodeShutdownTimeout(5_000)
)
const running = server.start(background())
void running.catch((error) => unhandled.push(error))
const [firstService, secondService] = await Promise.all([startService("a"), startService("b")])
process.stdout.write(
  `${ReadyMarker}${JSON.stringify({
    endpoint: await server.endpoint(background()),
    serviceEndpoints: [firstService.endpoint, secondService.endpoint]
  })}\n`
)

async function stop(): Promise<void> {
  if (stopping !== null) return await stopping
  stopping = (async function stopOwner(): Promise<void> {
    const stoppedBeforeRelease = await Promise.race([
      server.stop(background()).then(() => true),
      release.promise.then(() => false)
    ])
    if (stoppedBeforeRelease) throw new Error("web server stopped before the in-flight request")
    await server.stop(background())
    await running
    await Promise.all([
      firstService.server.stop(background()),
      secondService.server.stop(background())
    ])
    await Promise.all([firstService.running, secondService.running])
    process.stdout.write(
      `${ResultMarker}${JSON.stringify({
        admittedRequests,
        drainedRequests,
        serverTerminal: true,
        unhandledRejections: unhandled.length
      })}\n`
    )
    process.stdin.pause()
  })()
  return await stopping
}

let input = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk: string) => {
  input += chunk
  const lines = input.split(/\r?\n/u)
  input = lines.pop() ?? ""
  for (const line of lines) {
    if (line === "release") {
      released = true
      release.resolve()
    } else if (line === "stop") {
      void stop().catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
        process.exitCode = 1
        process.stdin.pause()
      })
    }
  }
})

process.once("SIGTERM", () => {
  if (!released) release.resolve()
  void stop().finally(() => process.exit())
})
