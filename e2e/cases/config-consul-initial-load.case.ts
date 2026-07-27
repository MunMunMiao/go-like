import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "config-consul-initial-load",
  domain: "config",
  source: {
    url: "https://developer.hashicorp.com/consul/api-docs/kv",
    retrievedAt: "2026-07-18",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "Configuration startup loads one exact JSON document and revision from real Consul KV.",
  runtimes: ["Bun 1.3.14"],
  services: ["Consul 2.0.2 Docker", "standard Fetch"],
  assertions: ["Release one is atomically published with an opaque Consul revision."],
  cleanupEvidence: ["The watcher and fixed-digest Consul container are removed."],
  suite: "config-consul-docker",
  scenario: "consul-kv-initial-load"
})
