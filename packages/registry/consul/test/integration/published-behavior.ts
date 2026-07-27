import { background } from "@likego/context"
import type { ServiceInstance } from "@likego/registry"
import { newConsulRegistry, type ConsulFetch } from "@likego/registry-consul"

/** Reads one own data field from an untrusted JSON object. */
function own(value: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value
}

/** Requires one runtime invariant. */
function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

let carrier: Readonly<Record<string, unknown>> | null = null
let index = 1

const fetch: ConsulFetch = async function memoryAgent(input, init): Promise<Response> {
  const request = input instanceof Request ? input : new Request(input, init)
  const url = new URL(request.url)
  if (url.pathname === "/v1/agent/service/register") {
    const value: unknown = await request.json()
    ensure(typeof value === "object" && value !== null && !Array.isArray(value), "invalid body")
    carrier = {
      ID: own(value, "ID"),
      Service: own(value, "Name"),
      Address: own(value, "Address"),
      Port: own(value, "Port"),
      Tags: own(value, "Tags"),
      Meta: own(value, "Meta")
    }
    index += 1
    return new Response(null)
  }
  if (url.pathname.startsWith("/v1/agent/check/pass/")) return new Response(null)
  if (url.pathname.startsWith("/v1/agent/service/deregister/")) {
    carrier = null
    index += 1
    return new Response(null)
  }
  if (url.pathname.startsWith("/v1/agent/service/")) {
    return carrier === null
      ? new Response(null, { status: 404 })
      : Response.json(carrier, { headers: { "X-Consul-Index": String(index) } })
  }
  if (url.pathname === "/v1/agent/checks") {
    const id = carrier === null ? null : own(carrier, "ID")
    return Response.json(
      typeof id === "string" ? { [`service:${id}`]: { Status: "passing" } } : {},
      { headers: { "X-Consul-Index": String(index) } }
    )
  }
  if (url.pathname.startsWith("/v1/health/service/")) {
    return Response.json(carrier === null ? [] : [{ Service: carrier }], {
      headers: { "X-Consul-Index": String(index) }
    })
  }
  if (url.pathname === "/v1/catalog/services") {
    const name = carrier === null ? null : own(carrier, "Service")
    const tags = carrier === null ? null : own(carrier, "Tags")
    return Response.json(typeof name === "string" ? { [name]: tags } : {}, {
      headers: { "X-Consul-Index": String(index) }
    })
  }
  return new Response(null, { status: 404 })
}

const instance: ServiceInstance = {
  id: "runtime-1",
  name: "runtime",
  version: "v1",
  metadata: { lane: "published" },
  endpoints: ["http://127.0.0.1:8080/"]
}
const registry = newConsulRegistry({ fetch, address: "https://consul.example" })
const result = await registry.register(background(), instance)
ensure(result === undefined, "register exposed a private handle")
ensure(
  JSON.stringify(await registry.getService(background(), instance.name)) ===
    JSON.stringify([instance]),
  "published getService did not round-trip ServiceInstance"
)
await registry.deregister(background(), instance)
ensure(
  (await registry.getService(background(), instance.name)).length === 0,
  "published deregister retained the service"
)

console.log(
  `LIKEGO_REGISTRY_CONSUL_PUBLISHED_RUNTIME=${JSON.stringify({
    valid: true,
    registerReturnedVoid: true,
    serviceInstanceRoundTrip: true,
    deregisterReturnedVoid: true
  })}`
)
