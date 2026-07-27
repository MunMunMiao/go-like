import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "fetch-node-streaming-response",
  domain: "web",
  source: {
    url: "https://hono.dev/docs/getting-started/nodejs",
    retrievedAt: "2026-07-18",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "The official @hono/node-server host streams a standard ReadableStream while LikeGo owns only listener shutdown.",
  runtimes: ["Node.js 26.5.0"],
  services: ["@hono/node-server 2.0.11", "standard ReadableStream"],
  assertions: [
    "The first chunk arrives before the delayed second chunk.",
    "Both standard ReadableStream chunks retain order and content."
  ],
  cleanupEvidence: [
    "The response reaches reader.closed and releases its reader lock.",
    "The server listener port is rebound after terminal shutdown."
  ],
  suite: "web-node-native",
  scenario: "incremental-readable-stream-response"
})
