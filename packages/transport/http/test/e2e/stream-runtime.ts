import { spawn } from "node:child_process"

import { newClient, withEndpoint, withTransport } from "@go-like/client"
import { background } from "@go-like/context"
import { address, newServer, streamKeepAlive, transport } from "@go-like/server"
import { struct } from "@go-like/struct"
import { endpoint, isServiceError } from "@go-like/transport"

import { newNodeHTTPTransport } from "../../src/node"

for (const name of [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy"
]) {
  delete process.env[name]
}
process.env.NO_PROXY = "127.0.0.1,localhost,::1"
process.env.no_proxy = process.env.NO_PROXY

const Item = struct.object({ n: struct.number() })
const watch = endpoint("orders", "watch", Item, Item, true)
const fail = endpoint("orders", "fail", Item, Item, true)
const runtime = process.versions.bun === undefined ? "node" : "bun"

/** Throws one precise end-to-end failure. */
function verify(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/** Waits without keeping the process alive. */
function delay(ms: number): Promise<void> {
  return new Promise(function settle(resolve): void {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/** Reads one SSE response with curl so the bytes are the on-wire format. */
function curl(url: string): Promise<string> {
  return new Promise(function run(resolve, reject): void {
    const child = spawn(
      "curl",
      [
        "-N",
        "-sS",
        "--max-time",
        "3",
        "-X",
        "POST",
        "-H",
        "content-type: application/json",
        "-H",
        "accept: text/event-stream",
        "--data",
        '{"n":1}',
        url
      ],
      { env: process.env }
    )
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on("data", function chunk(value: Buffer): void {
      stdout.push(value)
    })
    child.stderr.on("data", function chunk(value: Buffer): void {
      stderr.push(value)
    })
    child.on("error", reject)
    child.on("close", function closed(code): void {
      if (code !== 0) {
        reject(new Error(`curl exited ${code}: ${Buffer.concat(stderr).toString("utf8")}`))
        return
      }
      resolve(Buffer.concat(stdout).toString("utf8"))
    })
  })
}

const node = newNodeHTTPTransport()
const server = newServer(transport(node), address("127.0.0.1:0"), streamKeepAlive(20))
server.registerHandler(watch, async function* (): AsyncGenerator<{ n: number }> {
  await delay(80)
  yield { n: 1 }
  await delay(80)
  yield { n: 2 }
})
let failStream = true
server.registerHandler(fail, async function* (): AsyncGenerator<{ n: number }> {
  if (failStream) throw new Error("explode")
  yield { n: 1 }
})
const pending = server.start(background())
try {
  const location = await server.endpoint(background())
  const watched = await curl(new URL("/orders/watch", location).toString())
  const failed = await curl(new URL("/orders/fail", location).toString())
  const comments = watched.split("\n").filter((line) => line.startsWith(":")).length
  verify(watched.startsWith(":\n\n"), "missing initial comment")
  verify(comments > 2, `expected heartbeats, saw ${comments} comments`)
  verify(watched.includes('data: {"n":1}\n\n'), "missing first data event")
  verify(watched.includes('data: {"n":2}\n\n'), "missing second data event")
  verify(watched.includes("event: end\n"), "missing end event")
  verify(failed.includes("event: error\n"), "missing error event")
  verify(failed.includes('"code":"internal"'), "missing internal code")
  verify(failed.includes('"status":500'), "missing error status")
  verify(!failed.includes("explode"), "handler text leaked onto the wire")

  const conn = newClient(withTransport(node), withEndpoint(location))
  try {
    const values: number[] = []
    for await (const event of await conn.stream(background(), watch, { n: 1 })) values.push(event.n)
    verify(JSON.stringify(values) === "[1,2]", `client stream values ${values.join(",")}`)
    let thrown: unknown = null
    try {
      for await (const _event of await conn.stream(background(), fail, { n: 1 })) {
        verify(false, "error stream yielded a value")
      }
    } catch (error) {
      thrown = error
    }
    verify(isServiceError(thrown), "error stream did not throw a ServiceError")
    if (!isServiceError(thrown)) throw new Error("unreachable")
    verify(thrown.code === "internal" && thrown.status === 500, "unexpected error stream failure")
    verify(!thrown.message.includes("explode"), "handler text leaked to the client")
  } finally {
    await conn.close(background())
  }

  console.log(`runtime=${runtime}`)
  console.log("--- curl watch ---")
  console.log(watched)
  console.log("--- curl error ---")
  console.log(failed)
} finally {
  await server.stop(background())
  await pending
}
