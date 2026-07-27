import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "config-consul-reconcile",
  domain: "config",
  source: {
    url: "https://developer.hashicorp.com/consul/api-docs/features/blocking",
    retrievedAt: "2026-07-18",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "After Consul restarts with a lower index, the watcher resets safely and reconciles the new configuration.",
  runtimes: ["Bun 1.3.14"],
  services: ["Consul 2.0.2 Docker", "standard Fetch"],
  assertions: [
    "The recovered key publishes release two despite index regression.",
    "Observed revisions advance after reconciliation."
  ],
  cleanupEvidence: ["No active blocking request or container remains."],
  suite: "config-consul-docker",
  scenario: "restart-reconciles-new-index"
})
