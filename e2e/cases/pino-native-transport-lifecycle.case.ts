import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "pino-native-transport-lifecycle",
  domain: "logging",
  source: {
    url: "https://github.com/pinojs/pino/blob/v10.3.1/docs/transports.md",
    retrievedAt: "2026-07-18",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "An official pino.transport ThreadStream writes its final record through the same lifecycle-only adapter.",
  runtimes: ["Node.js 26.5.0"],
  services: ["Pino 10.3.1", "thread-stream 4.2.0", "native worker and filesystem"],
  assertions: [
    "The application-created transport receives the official logger record.",
    "Server stop waits for the native transport terminal and its persisted record.",
    "A terminal ThreadStream transport is rejected without ownership calls or listener leaks."
  ],
  cleanupEvidence: ["The transport closes and the temporary directory is recursively removed."],
  suite: "pino-runtime",
  scenario: "pino-native-transport-lifecycle"
})
