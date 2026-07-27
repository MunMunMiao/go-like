import { newSourcedCase } from "../case"
import { transportHTTPService } from "../package-identities"

export const sourcedCase = newSourcedCase({
  id: "transport-http-unary-loopback",
  domain: "transport",
  source: {
    url: "https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API",
    retrievedAt: "2026-07-19",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "LikeGo HTTP transport completes a real unary Message roundtrip through standard Fetch and a Node listener.",
  runtimes: ["Node.js 26.5.0"],
  services: [transportHTTPService, "Node HTTP 26.5.0", "standard Fetch on Node.js 26.5.0"],
  assertions: [
    "The Server listener is bound before the first client request begins.",
    "The real Fetch exchange returns HTTP 200 from the listener's actual non-zero bound address.",
    "Request and response Message bodies cross a real TCP loopback unchanged.",
    "Request and response Message headers cross the same transport wire unchanged."
  ],
  cleanupEvidence: ["The unary Server start Promise settles and its exact port can be rebound."],
  suite: "transport-http-node",
  scenario: "unary-loopback"
})
