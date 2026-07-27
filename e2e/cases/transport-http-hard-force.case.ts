import { newSourcedCase } from "../case"
import { transportHTTPService } from "../package-identities"

export const sourcedCase = newSourcedCase({
  id: "transport-http-hard-force",
  domain: "transport",
  source: {
    url: "https://nodejs.org/api/http.html",
    retrievedAt: "2026-07-19",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "The HTTP owner starts graceful close before force-cleaning a non-terminating accepted request.",
  runtimes: ["Node.js 26.5.0"],
  services: [transportHTTPService, "Node HTTP 26.5.0"],
  assertions: [
    "Graceful close remains pending until the owner explicitly crosses its force boundary.",
    "Native graceful close begins before force-close destroys active connections.",
    "The forced client request, handler, socket, and native listener all reach terminal."
  ],
  cleanupEvidence: [
    "No active handler or TCP resource remains and the forced listener port can be rebound."
  ],
  suite: "transport-http-node",
  scenario: "hard-force-cleanup"
})
