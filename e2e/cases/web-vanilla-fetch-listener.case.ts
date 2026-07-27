import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "web-vanilla-fetch-listener",
  domain: "web",
  source: {
    url: "https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API",
    retrievedAt: "2026-07-18",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario: "A plain one-argument Fetch handler is hosted by a real Node listener.",
  runtimes: ["Node.js 26.5.0"],
  services: ["@hono/node-server 2.0.11", "Node HTTP listener", "standard Fetch"],
  assertions: ["GET /live returns the expected JSON method and path."],
  cleanupEvidence: [
    "Server stop settles the resident start operation and releases the listener before process exit."
  ],
  suite: "vanilla-node",
  scenario: "vanilla-fetch-live-listener"
})
