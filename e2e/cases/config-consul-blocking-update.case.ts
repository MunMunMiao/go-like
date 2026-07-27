import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "config-consul-blocking-update",
  domain: "config",
  source: {
    url: "https://developer.hashicorp.com/consul/api-docs/features/blocking",
    retrievedAt: "2026-07-18",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "A real Consul blocking query publishes a later KV update without polling duplication.",
  runtimes: ["Bun 1.3.14"],
  services: ["Consul 2.0.2 Docker", "standard Fetch"],
  assertions: [
    "Release three is published after the blocking response advances.",
    "Nested JSON values are preserved."
  ],
  cleanupEvidence: ["The Config watcher reaches done and the container count is zero."],
  suite: "config-consul-docker",
  scenario: "blocking-query-publishes-change"
})
