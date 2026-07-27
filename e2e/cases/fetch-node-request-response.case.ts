import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "fetch-node-request-response",
  domain: "web",
  source: {
    url: "https://hono.dev/docs/getting-started/nodejs",
    retrievedAt: "2026-07-18",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "The official @hono/node-server Fetch host preserves a live Request/Response exchange while LikeGo manages only listener lifecycle.",
  runtimes: ["Node.js 26.5.0"],
  services: ["@hono/node-server 2.0.11", "standard Fetch"],
  assertions: [
    "POST body reaches the Fetch Request through the official host unchanged.",
    "Response status, body, and headers reach the client unchanged through the official host.",
    "The Web server handler receives exactly one Request argument."
  ],
  cleanupEvidence: [
    "The listener owner reaches terminal shutdown.",
    "The released port is rebound by a real Node server."
  ],
  assertionScenarios: [
    "request-response-method-body-headers",
    "request-response-method-body-headers",
    "exact-one-argument-fetch-abi"
  ],
  suite: "web-node-native",
  scenario: "request-response-method-body-headers"
})
