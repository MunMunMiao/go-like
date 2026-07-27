import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "fetch-node-client-abort",
  domain: "context",
  source: {
    url: "https://hono.dev/docs/getting-started/nodejs",
    retrievedAt: "2026-07-18",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "A client disconnect is handled by the official Fetch host before LikeGo closes the listener lifecycle.",
  runtimes: ["Node.js 26.5.0"],
  services: ["@hono/node-server 2.0.11", "TCP client", "standard AbortSignal"],
  assertions: [
    "The official host observes the client socket abort and cancels the standard response body.",
    "The Server can still stop and settle its start Promise."
  ],
  cleanupEvidence: [
    "No late unhandled rejection remains after every Server settles.",
    "Every accepted Web Server start Promise reaches terminal."
  ],
  suite: "web-node-native",
  scenario: "client-abort-cancels-response-body"
})
