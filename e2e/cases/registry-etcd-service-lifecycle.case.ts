import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "registry-etcd-service-lifecycle",
  domain: "registry",
  source: {
    url: "https://etcd.io/docs/v3.7/learning/api/",
    retrievedAt: "2026-07-21",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "A LikeGo service instance completes register, get, watch update, and deregister against real etcd.",
  runtimes: ["Bun 1.3.14"],
  services: ["etcd 3.7.1 Docker JSON gateway", "standard Fetch"],
  assertions: [
    "Registration is returned by getService.",
    "The watch publishes the updated replacement and then an explicit empty collection."
  ],
  cleanupEvidence: [
    "Registration keys, watchers, process trees, and the fixed-digest container are removed."
  ],
  suite: "registry-etcd-docker",
  scenario: "service-instance-register-get-watch-update-deregister"
})
