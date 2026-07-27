import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "winston-native-file-lifecycle",
  domain: "logging",
  source: {
    url: "https://github.com/winstonjs/winston/blob/v3.19.0/README.md",
    retrievedAt: "2026-07-18",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "An application-created Winston Logger and File transport retain native logging while LikeGo owns only Server start and stop lifecycle.",
  runtimes: ["Node.js 26.5.0"],
  services: ["Winston 3.19.0", "Winston File transport", "native filesystem"],
  assertions: [
    "The application writes one structured record through the native Winston Logger and File transport.",
    "Concurrent stop callers join the same native terminal while the Server start Promise remains pending."
  ],
  cleanupEvidence: [
    "The native Logger reaches writable finish after its File transport flushes.",
    "Every lifecycle listener installed by the adapter returns to its baseline count.",
    "The application-owned temporary log directory is removed after the record is verified."
  ],
  suite: "winston-runtime",
  scenario: "winston-native-file-lifecycle"
})
