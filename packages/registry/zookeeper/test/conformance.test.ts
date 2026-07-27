import type { Registry, ServiceInstance } from "@likego/registry"
import { test } from "bun:test"

import { registryConformanceCases, type RegistryConformanceSubject } from "../../src/testing"
import { newZookeeperRegistry } from "../src/index"
import { fakeZookeeper, fixture, type FakeZookeeper } from "./helpers"

/** Creates one provider connected to a deterministic shared ensemble. */
function registry(zookeeper: FakeZookeeper): Registry {
  return newZookeeperRegistry({
    address: "fake:2181",
    clientFactory: zookeeper.factory,
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

for (const conformance of registryConformanceCases(subject)) {
  test(`provider conformance: ${conformance.name}`, conformance.run)
}
