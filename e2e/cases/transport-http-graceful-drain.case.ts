import { newSourcedCase } from "../case"
import { transportHTTPService } from "../package-identities"

export const sourcedCase = newSourcedCase({
  id: "transport-http-graceful-drain",
  domain: "transport",
  source: {
    url: "https://github.com/micro/go-micro/blob/db4401d306039be2614e0e3657c6a5c6473feb3b/transport/http_transport.go",
    retrievedAt: "2026-07-19",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "HTTP server stop waits for an already accepted internal transport handler before true listener terminal.",
  runtimes: ["Node.js 26.5.0"],
  services: [transportHTTPService, "Node HTTP 26.5.0"],
  assertions: [
    "Graceful stop remains pending before the accepted handler is released.",
    "Canceling one stop caller does not cancel the shared owner drain, and a second stop joins it.",
    "The stopped listener rejects a fresh TCP connection while the accepted handler drains.",
    "The accepted handler returns its Message response before stop and the Server start Promise settle."
  ],
  cleanupEvidence: [
    "The gracefully drained listener reaches terminal with no active handler and releases its port."
  ],
  suite: "transport-http-node",
  scenario: "graceful-drain"
})
