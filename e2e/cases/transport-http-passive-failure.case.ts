import { newSourcedCase } from "../case"
import { transportHTTPService } from "../package-identities"

export const sourcedCase = newSourcedCase({
  id: "transport-http-passive-failure",
  domain: "transport",
  source: {
    url: "https://nodejs.org/api/http.html",
    retrievedAt: "2026-07-19",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "A running Node HTTP host actively drains after a passive native error and preserves the first Error identity.",
  runtimes: ["Node.js 26.5.0"],
  services: [transportHTTPService, "Node HTTP 26.5.0"],
  assertions: [
    "The passive native Error remains the exact Server start rejection identity.",
    "The host and serving terminal barriers preserve the same native Error identity.",
    "The error path actively closes the native listener instead of treating the event as terminal by itself."
  ],
  cleanupEvidence: [
    "The failed Server reaches terminal with zero active handlers or sockets and releases its exact bound port."
  ],
  suite: "transport-http-node",
  scenario: "passive-host-failure"
})
