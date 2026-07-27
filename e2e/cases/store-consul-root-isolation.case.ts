import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "store-consul-root-isolation",
  domain: "store",
  source: {
    url: "https://developer.hashicorp.com/consul/api-docs/kv",
    retrievedAt: "2026-07-21",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "The Consul Store scopes prefix access to one configured root, keeps cursors root-bound, and fails closed on malformed owned data.",
  runtimes: ["Bun 1.3.14"],
  services: ["Consul 2.0.2 Docker", "standard Fetch"],
  assertions: [
    "External keys are ignored, configured roots stay isolated, cross-root cursors are rejected, and corrupt owned records fail closed."
  ],
  cleanupEvidence: [
    "Provider KV, Sessions, process trees, and the fixed-digest container return to baseline."
  ],
  suite: "store-consul-docker",
  scenario: "consul-store-root-isolation"
})
