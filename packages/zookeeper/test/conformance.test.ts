import type { Registry, ServiceInstance } from "@go-like/core/registry"
import { test } from "bun:test"

import { registryConformance, type RegistryConformanceSubject } from "@go-like/core/testing"
import { newZookeeperRegistry } from "../src/registry/index"
import { fakeZookeeper, fixture, type FakeZookeeper } from "./helpers"

/** Creates one provider connected to a deterministic shared ensemble. */
function registry(zookeeper: FakeZookeeper): Registry {
  return newZookeeperRegistry({
    address: "fake:2181",
    client: zookeeper.factory,
    retryInitialMs: 2,
    retryMaximumMs: 10,
    reconcileIntervalMs: 100
  })
}

const subject: RegistryConformanceSubject = {
  convergenceTimeoutMs: 3_000,
  createRegistry(): Registry {
    return registry(fakeZookeeper())
  },
  createSharedRegistries(): readonly [Registry, Registry] {
    const zookeeper = fakeZookeeper()
    return Object.freeze([registry(zookeeper), registry(zookeeper)])
  },
  service(revision): ServiceInstance {
    return fixture(revision)
  }
}

for (const conformance of registryConformance(subject)) {
  test(`provider conformance: ${conformance.name}`, conformance.run)
}
