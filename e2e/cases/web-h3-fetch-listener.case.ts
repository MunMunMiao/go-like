import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "web-h3-fetch-listener",
  domain: "web",
  source: {
    url: "https://h3.dev/guide/api/h3",
    retrievedAt: "2026-07-18",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario: "H3.toWebHandler is accepted as a cross-runtime one-argument Fetch handler.",
  runtimes: ["Node.js 26.5.0"],
  services: ["H3 1.15.11", "@hono/node-server 2.0.11", "Node HTTP listener"],
  assertions: ["GET /status returns the H3 route response through the live listener."],
  cleanupEvidence: ["The managed listener closes before process exit."],
  suite: "h3-node",
  scenario: "h3-fetch-live-listener"
})
