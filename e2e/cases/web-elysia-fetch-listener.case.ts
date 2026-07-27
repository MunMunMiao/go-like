import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "web-elysia-fetch-listener",
  domain: "web",
  source: {
    url: "https://elysiajs.com/essential/handler",
    retrievedAt: "2026-07-18",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario: "Elysia app.fetch is accepted directly by the Node Fetch host.",
  runtimes: ["Node.js 26.5.0"],
  services: ["Elysia 1.4.29", "@hono/node-server 2.0.11", "Node HTTP listener"],
  assertions: ["GET /users/99 returns Elysia route data through the live listener."],
  cleanupEvidence: ["The managed listener closes before process exit."],
  suite: "elysia-node",
  scenario: "elysia-fetch-live-listener"
})
