import { background } from "@go-like/context"
import { newMemoryTransport } from "@go-like/transport-memory"

const transport = newMemoryTransport()
const listener = await transport.listen(background(), "memory://portable-runtime")
const accepting = listener.accept(background(), async function echo(ctx, socket): Promise<void> {
  await socket.send(ctx, await socket.recv(ctx))
})
const client = await transport.dial(background(), listener.addr())
const requestBody = new Uint8Array([1, 2, 3])
await client.send(background(), { header: { runtime: "portable" }, body: requestBody })
requestBody[0] = 99
const response = await client.recv(background())
if (
  transport.kind() !== "memory" ||
  response.header.runtime !== "portable" ||
  response.body[0] !== 1
) {
  throw new Error("portable memory transport exchange failed")
}
await client.close(background())
await listener.close(background())
await accepting
