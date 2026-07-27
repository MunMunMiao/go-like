import { background } from "@likego/context"
import { executor, newHTTPTransport } from "@likego/transport-http"

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
await client.send(background(), { header: {}, body: new Uint8Array([1]) })
const response = await client.recv(background())
await client.close(background())

if (response.body[0] !== 1) throw new Error(`${runtime} HTTP transport smoke failed`)
if (redirect !== "manual") {
  throw new Error(`${runtime} HTTP transport redirect policy is ${redirect}`)
}
console.log(JSON.stringify({ runtime, transport: transport.string(), redirect }))
