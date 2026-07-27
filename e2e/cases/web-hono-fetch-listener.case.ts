import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "web-hono-fetch-listener",
  domain: "web",
  source: {
    url: "https://hono.dev/docs/api/hono",
    retrievedAt: "2026-07-18",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario: "Hono app.fetch is accepted directly by the Node Fetch host.",
  runtimes: ["Node.js 26.5.0"],
  services: ["Hono 4.12.32", "@hono/node-server 2.0.11", "Node HTTP listener"],
  assertions: ["GET /users/99 returns Hono route data through the live listener."],
  cleanupEvidence: ["The managed listener closes before process exit."],
  suite: "hono-node",
  scenario: "hono-fetch-live-listener"
})
