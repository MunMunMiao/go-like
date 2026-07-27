import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "cron-native-exhaustion-unobservable",
  domain: "cron",
  source: {
    url: "https://jsr.io/@hexagon/croner/doc",
    retrievedAt: "2026-07-18",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "A lifecycle factory resumes a native Croner job and preserves native maxRuns exhaustion without inventing a passive terminal event.",
  runtimes: ["Node.js 26.5.0"],
  services: ["Croner 10.0.1", "native timers"],
  assertions: [
    "The native callback receives the Croner context and maxRuns stops scheduling after two ticks.",
    "Croner catch observes the native callback failure while the Server start Promise stays pending until explicit stop."
  ],
  cleanupEvidence: ["Explicit stop settles the Server and native timer count returns to baseline."],
  suite: "cron-native",
  scenario: "native-factory-resume-and-exhaustion-unobservable"
})
