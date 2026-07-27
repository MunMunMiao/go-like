import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "registry-mdns-crash-expiry",
  domain: "registry",
  source: {
    url: "https://www.rfc-editor.org/rfc/rfc6762.html",
    retrievedAt: "2026-07-19",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "Killing a real multicast DNS publisher without a goodbye lets its short-lived cache entry expire and emits a watcher delete.",
  runtimes: ["Bun 1.3.14"],
  services: ["Node.js 24.18.0 Docker", "mDNS IPv4 multicast", "Docker packet capture"],
  assertions: [
    "The publisher owns a live UDP 5353 socket before SIGKILL.",
    "The publisher exits from SIGKILL without emitting a TTL-zero goodbye.",
    "The observer emits delete after the captured two-second record expires."
  ],
  cleanupEvidence: [
    "The crash observer closes its socket and the killed publisher container is removed."
  ],
  suite: "registry-mdns-docker",
  scenario: "crash-expiry"
})
