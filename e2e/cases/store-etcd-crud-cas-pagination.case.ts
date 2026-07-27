import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "store-etcd-crud-cas-pagination",
  domain: "store",
  source: {
    url: "https://etcd.io/docs/v3.7/learning/api/",
    retrievedAt: "2026-07-21",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "The etcd Store performs real CRUD, transaction-backed CAS, and stable prefix pagination through the JSON gateway.",
  runtimes: ["Bun 1.3.14"],
  services: ["etcd 3.7.1 Docker JSON gateway", "standard Fetch"],
  assertions: [
    "CRUD succeeds, a stale revision conflicts, and both pages form one stable key traversal."
  ],
  cleanupEvidence: [
    "Keys, leases, process trees, and the fixed-digest etcd container are removed."
  ],
  suite: "store-etcd-docker",
  scenario: "etcd-store-crud-cas-pagination"
})
