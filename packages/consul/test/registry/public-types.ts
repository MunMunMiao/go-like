import { background } from "@go-like/core/context"
import type { Registry, ServiceInstance, Watcher } from "@go-like/core/registry"

import { newConsulClient } from "../../src/index"
import {
  newConsulRegistry,
  type ConsulRegistry,
  type ConsulRegistryOptions
} from "../../src/registry/index"

const fetchCapability = async function fetchCapability(request: Request): Promise<Response> {
  return new Response(request.url)
}

const client = newConsulClient({
  fetch: fetchCapability,
  address: "https://consul.example"
})
const options: ConsulRegistryOptions = {
  onRegistrationError(_error, _service): Promise<void> {
    return Promise.resolve()
  }
}

const registry: Registry = newConsulRegistry(client, options)
const concrete: ConsulRegistry = newConsulRegistry(client, options)
const instance: ServiceInstance = {
  id: "orders-1",
  name: "orders",
  version: "v1",
  metadata: {},
  endpoints: ["http://127.0.0.1:8080/"]
}
const registered: Promise<void> = registry.register(background(), instance)
const deregistered: Promise<void> = registry.deregister(background(), instance)
const discovered: Promise<readonly ServiceInstance[]> = registry.getService(
  background(),
  instance.name
)
const watcher: Promise<Watcher> = registry.watch(background(), instance.name)
void [concrete, registered, deregistered, discovered, watcher]

// @ts-expect-error Fetch accepts exactly one standard Request at the application boundary.
fetchCapability("https://consul.example")
// @ts-expect-error legacy split registrar constructor is intentionally absent.
import("../../src/registry/index").then((module) => module.newConsulRegistrar(client))
// @ts-expect-error legacy split discovery constructor is intentionally absent.
import("../../src/registry/index").then((module) => module.newConsulDiscovery(client))
