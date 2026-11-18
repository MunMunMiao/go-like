import type { Registry, ServiceInstance } from "@go-like/core/registry"
import { test } from "bun:test"

import { registryConformance, type RegistryConformanceSubject } from "@go-like/core/testing"
import { newEtcdRegistry } from "../../src/registry/index"
import { fakeEtcd, type FakeEtcd } from "./helpers"
import { newEtcdClient } from "../../src/index"

/** Creates one provider connected to a deterministic shared gateway. */
function registry(etcd: FakeEtcd): Registry {
  return newEtcdRegistry(
    newEtcdClient({
      fetch: etcd.fetch,
      address: "https://etcd.example"
    }),
    {
      retryInitialMs: 2,
      retryMaximumMs: 10
    }
  )
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

for (const conformance of registryConformance(subject)) {
  test(`provider conformance: ${conformance.name}`, conformance.run)
}
