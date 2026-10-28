import * as memory from "@go-like/transport-memory"

if (Object.keys(memory).join(",") !== "newMemoryTransport") {
  throw new Error(`unexpected @go-like/transport-memory exports: ${Object.keys(memory).join(",")}`)
}
const transport = memory.newMemoryTransport()
if (transport.kind() !== "memory" || transport.string() !== "memory") {
  throw new Error("built @go-like/transport-memory identity runtime failed")
}
