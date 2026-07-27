import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "registry-consul-service-roundtrip",
  domain: "registry",
  source: {
    url: "https://developer.hashicorp.com/consul/commands/services/register",
    retrievedAt: "2026-07-18",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "A LikeGo service instance round-trips through real Consul registration and discovery without exposing provider handles.",
  runtimes: ["Bun 1.3.14"],
  services: ["Consul 2.0.2 Docker", "standard Fetch"],
  assertions: [
    "Registration and deregistration retain the public void contract.",
    "Discovery reproduces the original service instance under one deterministic remote identity."
  ],
  cleanupEvidence: ["The registration is removed and the Consul container terminates."],
  suite: "registry-consul-docker",
  scenario: "service-instance-roundtrip"
})
