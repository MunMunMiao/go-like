import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "registry-etcd-lost-response-readback",
  domain: "registry",
  source: {
    url: "https://etcd.io/docs/v3.7/learning/api/",
    retrievedAt: "2026-07-21",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "The etcd Registry accepts a lost transaction response only after exact service readback.",
  runtimes: ["Bun 1.3.14"],
  services: ["etcd 3.7.1 Docker JSON gateway", "standard Fetch"],
  assertions: [
    "The real transaction commits before its response is deliberately lost.",
    "Exact readback confirms the service before the operation succeeds."
  ],
  cleanupEvidence: ["The service key and fixed-digest etcd container are removed."],
  suite: "registry-etcd-docker",
  scenario: "lost-transaction-response-exact-readback"
})
