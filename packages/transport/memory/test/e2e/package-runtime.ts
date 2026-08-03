import * as memory from "@likego/transport-memory"

if (Object.keys(memory).join(",") !== "newMemoryTransport") {
  throw new Error(`unexpected @likego/transport-memory exports: ${Object.keys(memory).join(",")}`)
}
const transport = memory.newMemoryTransport()
if (transport.kind() !== "memory" || transport.string() !== "memory") {
  throw new Error("built @likego/transport-memory identity runtime failed")
}
