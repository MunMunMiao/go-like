import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "registry-mdns-wire-cleanup",
  domain: "registry",
  source: {
    url: "https://nodejs.org/api/dgram.html",
    retrievedAt: "2026-07-19",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "Packet captures and kernel tables prove correct Node UDP multicast hop limits, DNS record lifetimes, cache flushes, wire namespace, and terminal cleanup.",
  runtimes: ["Bun 1.3.14"],
  services: [
    "Node.js 24.18.0 Docker",
    "Node dgram UDP multicast",
    "mDNS IPv4 multicast",
    "mDNS IPv6 multicast",
    "Docker packet capture"
  ],
  assertions: [
    "IPv4 TTL and IPv6 hop limit are 255 while DNS records retain independent positive and goodbye TTLs.",
    "Positive and goodbye records carry cache flush and canonical LikeGo owner and target names.",
    "Managed TXT uses Likego-Wire-Version 1 and excludes the legacy Micro namespace.",
    "A stopped observer receives no late multicast packet."
  ],
  cleanupEvidence: [
    "Descriptor, UDP and UDP6 rows, containers, networks, process trees, and protected-container state are clean."
  ],
  suite: "registry-mdns-docker",
  scenario: "wire-cleanup"
})
