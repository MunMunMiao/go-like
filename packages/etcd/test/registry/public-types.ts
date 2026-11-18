import type { Registry } from "@go-like/core/registry"

import { newEtcdClient } from "../../src/index"
import {
  newEtcdRegistry,
  type EtcdRegistry,
  type EtcdRegistryOptions
} from "../../src/registry/index"

const client = newEtcdClient({
  address: "https://etcd.example",
  async fetch(): Promise<Response> {
    return new Response(null)
  }
})

const options: EtcdRegistryOptions = {
  onRegistrationError(_error, _service): void {}
}

const registry: Registry = newEtcdRegistry(client, options)
const concrete: EtcdRegistry = newEtcdRegistry(client)
void registry
void concrete

// @ts-expect-error split registrar constructors are intentionally absent.
import("../../src/registry/index").then((module) => module.newEtcdRegistrar(client))
// @ts-expect-error split discovery constructors are intentionally absent.
import("../../src/registry/index").then((module) => module.newEtcdDiscovery(client))
