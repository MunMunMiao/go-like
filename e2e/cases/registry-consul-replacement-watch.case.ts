import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "registry-consul-replacement-watch",
  domain: "registry",
  source: {
    url: "https://developer.hashicorp.com/consul/api-docs/features/blocking",
    retrievedAt: "2026-07-18",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "A Consul discovery watch publishes complete replacement collections for create, update, and deregister.",
  runtimes: ["Bun 1.3.14"],
  services: ["Consul 2.0.2 Docker", "standard Fetch"],
  assertions: [
    "The watch first observes the registered service.",
    "Update replaces the prior instance and deregistration publishes an explicit empty collection.",
    "The public watcher exposes only next and stop."
  ],
  cleanupEvidence: ["Watcher and blocking requests stop, and the service is deregistered."],
  suite: "registry-consul-docker",
  scenario: "replacement-snapshot-watch"
})
