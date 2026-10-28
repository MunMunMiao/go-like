import type { Registry, ServiceInstance } from "@go-like/registry"
import { test } from "bun:test"

import { registryConformanceCases, type RegistryConformanceSubject } from "../../src/testing"
import { newConsulRegistry } from "../src/index"
import { fakeAgent, type FakeAgent } from "./helpers"

/** Creates one provider connected to a deterministic shared Agent. */
function registry(agent: FakeAgent): Registry {
  return newConsulRegistry({
    fetch: agent.fetch,
    address: "https://consul.example",
    waitMs: 20,
    minimumQueryIntervalMs: 2,
    retryInitialMs: 2,
    retryMaximumMs: 10
  })
}

/** Creates one public conformance revision without provider-specific fields. */
function fixture(revision: "initial" | "updated"): ServiceInstance {
  return {
    id: "orders-1",
    name: "consul-conformance",
    version: "v1",
    metadata: { revision },
    endpoints: [revision === "initial" ? "http://127.0.0.1:8080/" : "http://127.0.0.1:8081/"]
  }
}

const subject: RegistryConformanceSubject = {
  convergenceTimeoutMs: 3_000,
  createRegistry(): Registry {
    return registry(fakeAgent())
  },
  createSharedRegistries(): readonly [Registry, Registry] {
    const agent = fakeAgent()
    return Object.freeze([registry(agent), registry(agent)])
  },
  service: fixture
}

for (const conformance of registryConformanceCases(subject)) {
  test(`provider conformance: ${conformance.name}`, conformance.run)
}
