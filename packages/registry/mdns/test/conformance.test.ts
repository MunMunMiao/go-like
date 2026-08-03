import { test } from "bun:test"

import type { Registry, ServiceInstance } from "@likego/registry"

import { registryConformanceCases, type RegistryConformanceSubject } from "../../src/testing"
import { queryTimeout } from "../src/options"
import { newMDNSRegistry } from "../src/registry"
import { newMemoryMDNSNetwork } from "../src/testing"

/** Creates one conformance ServiceInstance revision without changing its identity. */
function fixture(revision: "initial" | "updated"): ServiceInstance {
  return {
    id: "node-1",
    name: "mdns-conformance",
    version: revision === "initial" ? "v1" : "v2",
    metadata: { revision },
    endpoints: [revision === "initial" ? "http://127.0.0.1:8080" : "http://127.0.0.1:8081"]
  }
}

const subject: RegistryConformanceSubject = {
  convergenceTimeoutMs: 5_000,
  createRegistry(): Registry {
    const network = newMemoryMDNSNetwork()
    return newMDNSRegistry(network.host("single"), queryTimeout(5))
  },
  createSharedRegistries(): readonly [Registry, Registry] {
    const network = newMemoryMDNSNetwork()
    return Object.freeze([
      newMDNSRegistry(network.host("first"), queryTimeout(10)),
      newMDNSRegistry(network.host("second"), queryTimeout(10))
    ])
  },
  service: fixture
}

for (const conformance of registryConformanceCases(subject)) {
  test(`provider conformance: ${conformance.name}`, conformance.run, 15_000)
}
