import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "registry-consul-private-ttl-heartbeat",
  domain: "registry",
  source: {
    url: "https://developer.hashicorp.com/consul/api-docs/agent/check",
    retrievedAt: "2026-07-18",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "The Consul provider renews its private TTL health check without exposing an ownership handle.",
  runtimes: ["Bun 1.3.14"],
  services: ["Consul 2.0.2 Docker", "TTL health check"],
  assertions: [
    "The private heartbeat renews the real Consul TTL check at least twice.",
    "Registration still returns void and exposes no provider handle."
  ],
  cleanupEvidence: ["The service registration and Consul container are removed."],
  suite: "registry-consul-docker",
  scenario: "private-ttl-heartbeat"
})
