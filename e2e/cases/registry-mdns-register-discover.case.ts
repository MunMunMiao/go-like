import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "registry-mdns-register-discover",
  domain: "registry",
  source: {
    url: "https://www.rfc-editor.org/rfc/rfc6763.html",
    retrievedAt: "2026-07-19",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "A service published over real IPv4 and IPv6 multicast DNS is discovered with its complete LikeGo service payload while another domain remains isolated.",
  runtimes: ["Bun 1.3.14"],
  services: [
    "Node.js 24.18.0 Docker",
    "Node dgram UDP multicast",
    "mDNS IPv4 multicast",
    "mDNS IPv6 multicast"
  ],
  assertions: [
    "A newly registered service is discovered over real IPv4 multicast.",
    "The same lifecycle is discovered over real IPv6 multicast.",
    "An IPv6 ULA advertised by the publisher remains one identity when multicast arrives from its link-local source address.",
    "Service metadata, endpoint values, node data, and domain isolation round-trip exactly."
  ],
  cleanupEvidence: [
    "Publisher and observer processes, sockets, containers, and networks are removed."
  ],
  suite: "registry-mdns-docker",
  scenario: "register-discover"
})
