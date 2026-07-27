import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "fetch-node-hard-force",
  domain: "app",
  source: {
    url: "https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#pod-termination",
    retrievedAt: "2026-07-18",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "An owner hard bound force-closes a response body that refuses cooperative cancellation.",
  runtimes: ["Node.js 26.5.0"],
  services: ["Node HTTP listener", "standard ReadableStream"],
  assertions: ["The server reports LIKEGO_NODE_SERVER_FORCE_CLOSE after its hard bound."],
  cleanupEvidence: [
    "No late rejection remains after forced terminal settlement.",
    "Every accepted Web Server start Promise reaches terminal."
  ],
  suite: "web-node-native",
  scenario: "hard-force-noncooperative-body"
})
