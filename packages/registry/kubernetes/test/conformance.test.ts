import type { Registry, ServiceInstance } from "@go-like/registry"
import { test } from "bun:test"

import { registryConformanceCases, type RegistryConformanceSubject } from "../../src/testing"
import { newKubernetesRegistry } from "../src/index"
import { fakeKubernetes, type FakeKubernetes } from "./helpers"

/** Creates one provider connected to a deterministic shared API server. */
function registry(api: FakeKubernetes): Registry {
  return newKubernetesRegistry({
    fetch: api.fetch,
    address: "https://kubernetes.example",
    namespace: "go-like-test",
    retryInitialMs: 1,
    retryMaximumMs: 4,
    watchTimeoutSeconds: 5
  })
}

/** Creates one public conformance revision. */
function fixture(revision: "initial" | "updated"): ServiceInstance {
  return {
    id: "node-1",
    name: "kubernetes-conformance",
    version: "v1",
    metadata: { revision },
    endpoints: [revision === "initial" ? "http://10.42.0.10:8080/" : "http://10.42.0.10:8081/"]
  }
}

const subject: RegistryConformanceSubject = {
  convergenceTimeoutMs: 3_000,
  createRegistry(): Registry {
    return registry(fakeKubernetes())
  },
  createSharedRegistries(): readonly [Registry, Registry] {
    const api = fakeKubernetes()
    return Object.freeze([registry(api), registry(api)])
  },
  service: fixture
}

for (const conformance of registryConformanceCases(subject)) {
  test(`provider conformance: ${conformance.name}`, conformance.run)
}
