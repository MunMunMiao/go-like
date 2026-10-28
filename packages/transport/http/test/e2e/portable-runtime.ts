import { background } from "@go-like/context"
import { executor, newHTTPTransport } from "@go-like/transport-http"

const runtime = "Bun" in globalThis ? "bun" : "Deno" in globalThis ? "deno" : "node"
let redirect = ""
const run = Object.assign(
  async function execute(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    redirect = new Request(input, init).redirect
    return new Response(new Uint8Array([1]), { status: 200 })
  },
  {
    preconnect(): void {}
  }
)
const transport = newHTTPTransport(executor(run))
const client = await transport.dial(background(), "service.test:8080")
const bytes = new Uint8Array([1])
const copy = new ArrayBuffer(bytes.byteLength)
new Uint8Array(copy).set(bytes)
const response = await client.fetch(
  background(),
  new Request("http://service.test:8080/echo/call", { method: "POST", body: copy })
)
const payload = new Uint8Array(await response.arrayBuffer())
await client.close(background())

if (payload[0] !== 1) throw new Error(`${runtime} HTTP transport runtime failed`)
if (redirect !== "manual") {
  throw new Error(`${runtime} HTTP transport redirect policy is ${redirect}`)
}
console.log(JSON.stringify({ runtime, transport: transport.string(), redirect }))
