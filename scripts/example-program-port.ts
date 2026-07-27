import { createConnection } from "node:net"

/** Returns whether one loopback TCP port stops accepting connections inside the retry window. */
export async function portIsReleased(port: number): Promise<boolean> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const released = await new Promise<boolean>(function connect(resolve) {
      const socket = createConnection({ host: "127.0.0.1", port })
      let settled = false
      function finish(value = false): void {
        if (settled) return
        settled = true
        socket.destroy()
        resolve(value)
      }
      socket.setTimeout(250, finish)
      socket.once("connect", finish)
      socket.once("error", function failed(error): void {
        finish(error instanceof Error && "code" in error && error.code === "ECONNREFUSED")
      })
    })
    if (released) return true
    await Bun.sleep(100)
  }
  return false
}
