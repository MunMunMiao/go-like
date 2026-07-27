import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "store-etcd-lease-restart",
  domain: "store",
  source: {
    url: "https://etcd.io/docs/v3.7/learning/api/",
    retrievedAt: "2026-07-21",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "Real etcd leases expire or revoke their attached Store keys while persistent data survives provider stop and server restart.",
  runtimes: ["Bun 1.3.14"],
  services: ["etcd 3.7.1 Docker JSON gateway", "standard Fetch"],
  assertions: [
    "Lease expiry, proactive revoke, and restart persistence are independently observed."
  ],
  cleanupEvidence: [
    "Keys, leases, process trees, and the fixed-digest etcd container are removed."
  ],
  suite: "store-etcd-docker",
  scenario: "etcd-store-lease-restart"
})
