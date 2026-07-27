import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "config-consul-last-good",
  domain: "config",
  source: {
    url: "https://developer.hashicorp.com/consul/api-docs/features/blocking",
    retrievedAt: "2026-07-18",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario: "A Consul outage keeps the exact last-good immutable configuration value.",
  runtimes: ["Bun 1.3.14"],
  services: ["Consul 2.0.2 Docker", "standard Fetch"],
  assertions: [
    "Stopping Consul causes retryable Fetch failures.",
    "The published release-one value identity and content remain unchanged."
  ],
  cleanupEvidence: ["The restarted test container and watcher are removed."],
  suite: "config-consul-docker",
  scenario: "outage-preserves-last-good"
})
