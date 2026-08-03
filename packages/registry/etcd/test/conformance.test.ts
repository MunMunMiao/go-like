import type { Registry, ServiceInstance } from "@likego/registry"
import { test } from "bun:test"

import { registryConformanceCases, type RegistryConformanceSubject } from "../../src/testing"
import { newEtcdRegistry } from "../src/index"
import { fakeEtcd, type FakeEtcd } from "./helpers"

/** Creates one provider connected to a deterministic shared gateway. */
function registry(etcd: FakeEtcd): Registry {
  return newEtcdRegistry({
    fetch: etcd.fetch,
    address: "https://etcd.example",
    retryInitialMs: 2,
    retryMaximumMs: 10
  })
}

/** Creates one public conformance revision without provider-specific fields. */
function fixture(revision: "initial" | "updated"): ServiceInstance {
  return {
    id: "orders-1",
    name: "etcd-conformance",
    version: "v1",
    metadata: { revision },
    endpoints: [revision === "initial" ? "http://127.0.0.1:8080/" : "http://127.0.0.1:8081/"]
  }
}

const subject: RegistryConformanceSubject = {
  convergenceTimeoutMs: 3_000,
  createRegistry(): Registry {
    return registry(fakeEtcd())
  },
  createSharedRegistries(): readonly [Registry, Registry] {
    const etcd = fakeEtcd()
    return Object.freeze([registry(etcd), registry(etcd)])
  },
  service: fixture
}

for (const conformance of registryConformanceCases(subject)) {
  test(`provider conformance: ${conformance.name}`, conformance.run)
}
