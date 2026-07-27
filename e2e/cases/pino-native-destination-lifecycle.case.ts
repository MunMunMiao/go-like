import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "pino-native-destination-lifecycle",
  domain: "logging",
  source: {
    url: "https://github.com/pinojs/pino/blob/v10.3.1/docs/api.md",
    retrievedAt: "2026-07-18",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "An application-created official Pino destination keeps native logging semantics while LikeGo owns only flush/end/close lifecycle.",
  runtimes: ["Node.js 26.5.0"],
  services: ["Pino 10.3.1", "Pino-owned SonicBoom 4.2.1", "native filesystem"],
  assertions: [
    "The official logger preserves the structured field and Pino redaction.",
    "The adapter accepts the structural file destination created by Pino without importing its implementation dependency.",
    "Server stop flushes and ends the transferred destination before the final file is read.",
    "A terminal Pino file destination is rejected without ownership calls or listener leaks.",
    "A Pino file destination already ending asynchronously is rejected before ownership transfer.",
    "Prototype and own-method mutations after the construction snapshot are rejected without ownership transfer.",
    "Logger stream-binding drift is rejected before ownership transfer.",
    "Synchronous listener-registration re-entry cannot bypass the second admission check.",
    "Lifecycle changes during start revalidation cannot bypass the final admission check.",
    "Owner drain and force keep the construction-captured Logger and destination call targets after method drift.",
    "Owner-time Logger stream drift fails closed while the transferred destination is still cleaned."
  ],
  cleanupEvidence: ["The destination closes and the temporary directory is recursively removed."],
  suite: "pino-runtime",
  scenario: "pino-native-destination-lifecycle"
})
