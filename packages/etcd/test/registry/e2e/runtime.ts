import { background } from "@go-like/core/context"
import { newEtcdRegistry } from "@go-like/etcd/registry"
import { newEtcdClient } from "@go-like/etcd"

let requests = 0

/** Implements the exact JSON-gateway range subset used by this published runtime check. */
async function fetchCapability(request: Request): Promise<Response> {
  if (request.redirect !== "error") throw new Error("published etcd Request may follow redirects")
  if (new URL(request.url).pathname !== "/v3/kv/range") {
    return new Response(null, { status: 404 })
  }
  requests += 1
  return Response.json({ header: { revision: "1" }, kvs: [], count: "0" })
}

const registry = newEtcdRegistry(
  newEtcdClient({
    fetch: fetchCapability,
    address: "https://etcd.example"
  })
)
const services = await registry.getService(background(), "missing")
if (services.length !== 0 || requests !== 1) {
  throw new Error("published etcd behavior differs")
}
console.log("registry-etcd-runtime ok")
