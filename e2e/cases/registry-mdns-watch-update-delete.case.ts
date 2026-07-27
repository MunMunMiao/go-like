import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "registry-mdns-watch-update-delete",
  domain: "registry",
  source: {
    url: "https://www.rfc-editor.org/rfc/rfc6762.html",
    retrievedAt: "2026-07-19",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "A real multicast DNS watcher observes update, prior-generation restoration, and final deletion for both supported address families.",
  runtimes: ["Bun 1.3.14"],
  services: ["mDNS IPv4 multicast", "mDNS IPv6 multicast"],
  assertions: [
    "A replacement registration emits an update.",
    "Stopping the replacement restores the prior generation.",
    "Stopping the final owner emits a delete over IPv4 and IPv6."
  ],
  cleanupEvidence: [
    "The watcher reaches terminal and both family-specific multicast sockets are closed."
  ],
  suite: "registry-mdns-docker",
  scenario: "watch-update-delete"
})
