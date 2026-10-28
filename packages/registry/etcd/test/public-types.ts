import type { Registry } from "@go-like/registry"
import {
  newEtcdRegistry,
  type EtcdFetch,
  type EtcdRegistry,
  type EtcdRegistryOptions
} from "../src/index"

const fetchCapability: EtcdFetch = async function fetchCapability(
  _input: RequestInfo | URL,
  _init?: RequestInit
): Promise<Response> {
  return new Response(null)
}

const options: EtcdRegistryOptions = {
  fetch: fetchCapability,
  address: "https://etcd.example",
  onRegistrationError(_error, _service): void {}
}

const registry: Registry = newEtcdRegistry(options)
const concrete: EtcdRegistry = newEtcdRegistry(options)
void registry
void concrete

// @ts-expect-error split registrar constructors are intentionally absent.
import("../src/index").then((module) => module.newEtcdRegistrar(options))
// @ts-expect-error split discovery constructors are intentionally absent.
import("../src/index").then((module) => module.newEtcdDiscovery(options))
