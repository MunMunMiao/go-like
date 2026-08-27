import { background } from "@go-like/context"
import type { Registry, ServiceInstance, Watcher } from "@go-like/registry"
import {
  newConsulRegistry,
  type ConsulFetch,
  type ConsulRegistry,
  type ConsulRegistryOptions
} from "../src/index"

const fetchCapability: ConsulFetch = async function fetchCapability(
  _input: RequestInfo | URL,
  _init?: RequestInit
): Promise<Response> {
  return new Response(null)
}

const options: ConsulRegistryOptions = {
  fetch: fetchCapability,
  address: "https://consul.example",
  onRegistrationError(_error, _service): Promise<void> {
    return Promise.resolve()
  }
}

const registry: Registry = newConsulRegistry(options)
const concrete: ConsulRegistry = newConsulRegistry(options)
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

// @ts-expect-error legacy split registrar constructor is intentionally absent.
import("../src/index").then((module) => module.newConsulRegistrar(options))
// @ts-expect-error legacy split discovery constructor is intentionally absent.
import("../src/index").then((module) => module.newConsulDiscovery(options))
