import { background } from "@likego/context"
import { newEtcdRegistry } from "@likego/registry-etcd"

let requests = 0

/** Implements the exact JSON-gateway range subset used by this published smoke. */
async function fetchCapability(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = input instanceof Request ? input : new Request(input, init)
  if (request.redirect !== "error") throw new Error("published etcd Request may follow redirects")
  if (new URL(request.url).pathname !== "/v3/kv/range") {
    return new Response(null, { status: 404 })
  }
  requests += 1
  return Response.json({ header: { revision: "1" }, kvs: [], count: "0" })
}

const registry = newEtcdRegistry({
  fetch: fetchCapability,
  address: "https://etcd.example"
})
const services = await registry.getService(background(), "missing")
if (services.length !== 0 || requests !== 1) {
  throw new Error("published etcd behavior differs")
}
console.log(`LIKEGO_REGISTRY_ETCD_PUBLISHED_RUNTIME=${JSON.stringify({ valid: true, requests })}`)
