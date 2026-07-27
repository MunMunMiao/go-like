import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "fetch-node-graceful-drain",
  domain: "app",
  source: {
    url: "https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#pod-termination",
    retrievedAt: "2026-07-18",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "Graceful HTTP drain finishes accepted work and refuses new connections after stop.",
  runtimes: ["Node.js 26.5.0"],
  services: ["@hono/node-server 2.0.11", "Node HTTP listener"],
  assertions: [
    "stop and the Server start Promise settle after the active listener drains.",
    "A new connection is refused after terminal shutdown."
  ],
  cleanupEvidence: ["The listener port can be rebound immediately."],
  suite: "web-node-native",
  scenario: "graceful-drain-refuses-new-connections"
})
