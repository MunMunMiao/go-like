import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "registry-mdns-collision-rescue",
  domain: "registry",
  source: {
    url: "https://www.rfc-editor.org/rfc/rfc6762.html",
    retrievedAt: "2026-07-19",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "Conflicting multicast DNS content fails closed while a cooperating responder preserves the service until the final owner stops.",
  runtimes: ["Bun 1.3.14"],
  services: ["Node dgram UDP multicast", "mDNS IPv4 multicast", "mDNS IPv6 multicast"],
  assertions: [
    "Conflicting identity content terminates with the registry protocol error.",
    "A cooperating responder rescues the cached service without a false delete.",
    "Collision rejection and rescue are proven for IPv4 and IPv6."
  ],
  cleanupEvidence: [
    "Collider, cooperator, publisher, and observer resources are removed after both family runs."
  ],
  suite: "registry-mdns-docker",
  scenario: "collision-rescue"
})
