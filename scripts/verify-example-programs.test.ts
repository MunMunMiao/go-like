import { createServer, type Server } from "node:net"

import { expect, test } from "bun:test"

import { portIsReleased } from "./example-program-port"

/** Closes one local TCP server after all probe sockets have disconnected. */
async function close(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>(function wait(resolve, reject) {
    server.close(function closed(error): void {
      if (error === undefined) resolve()
      else reject(error)
    })
  })
}

test("port release detection rejects a listener that never answers HTTP", async () => {
  const server = createServer()
  const port = await new Promise<number>(function listen(resolve, reject) {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", function listening(): void {
      const address = server.address()
      if (address === null || typeof address === "string") {
        reject(new Error("test server did not publish a TCP port"))
        return
      }
      resolve(address.port)
    })
  })
  try {
    expect(await portIsReleased(port)).toBe(false)
    await close(server)
    expect(await portIsReleased(port)).toBe(true)
  } finally {
    await close(server)
  }
}, 8_000)
