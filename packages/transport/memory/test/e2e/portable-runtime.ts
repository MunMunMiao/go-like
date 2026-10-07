import { background } from "@go-like/context"
import { newMemoryTransport } from "@go-like/transport-memory"

const transport = newMemoryTransport()
const listener = await transport.listen(background(), "memory://portable-runtime")
const serving = listener.serve(background(), async function echo(_ctx, request): Promise<Response> {
  const bytes = new Uint8Array(await request.arrayBuffer())
  return new Response(bytes, { headers: { "x-runtime": request.headers.get("x-runtime") ?? "" } })
})
const client = await transport.dial(background(), listener.addr())
const response = await client.fetch(
  background(),
  new Request(new URL("/echo", listener.addr()), {
    method: "POST",
    body: new Uint8Array([1, 2, 3]),
    headers: { "x-runtime": "portable" }
  })
)
const body = new Uint8Array(await response.arrayBuffer())
if (
  transport.kind() !== "memory" ||
  response.headers.get("x-runtime") !== "portable" ||
  body[0] !== 1 ||
  body[1] !== 2 ||
  body[2] !== 3
) {
  throw new Error("portable memory transport exchange failed")
}
await client.close(background())
await listener.close(background())
await serving
