import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "registry-etcd-sigkill-lease-expiry",
  domain: "registry",
  source: {
    url: "https://etcd.io/docs/v3.7/learning/api/",
    retrievedAt: "2026-07-21",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "A service published by a killed process disappears from real etcd when its lease expires.",
  runtimes: ["Bun 1.3.14"],
  services: ["etcd 3.7.1 Docker JSON gateway", "standard Fetch"],
  assertions: [
    "SIGKILL stops the publisher without deregistration.",
    "Lease expiry removes its service."
  ],
  cleanupEvidence: [
    "Registration keys, watchers, child processes, and the fixed-digest container are removed."
  ],
  suite: "registry-etcd-docker",
  scenario: "sigkill-publisher-lease-expiry"
})
