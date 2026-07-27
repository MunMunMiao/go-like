import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "store-consul-crud-cas-ttl",
  domain: "store",
  source: {
    url: "https://developer.hashicorp.com/consul/api-docs/kv",
    retrievedAt: "2026-07-21",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "The Consul Store performs real CRUD, ModifyIndex CAS, stable prefix pagination, Session TTL expiry, and restart recovery.",
  runtimes: ["Bun 1.3.14"],
  services: ["Consul 2.0.2 Docker", "standard Fetch"],
  assertions: [
    "CRUD, stale-CAS rejection, pagination, TTL visibility, and restart persistence are all observed."
  ],
  cleanupEvidence: [
    "Provider KV, Sessions, process trees, and fixed-digest containers return to baseline."
  ],
  suite: "store-consul-docker",
  scenario: "consul-store-crud-cas-pagination-ttl"
})
