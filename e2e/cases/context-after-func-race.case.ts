import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "context-after-func-race",
  domain: "context",
  source: {
    url: "https://pkg.go.dev/context",
    retrievedAt: "2026-07-18",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "afterFunc and its stop function have exactly one winner before and after cancellation.",
  runtimes: ["Bun 1.3.14"],
  services: ["microtask queue", "standard AbortSignal"],
  assertions: [
    "Stopping before cancellation prevents the callback.",
    "Cancellation admission makes a later stop return false and runs once."
  ],
  cleanupEvidence: ["Both callback races settle and native timer resources return to baseline."],
  suite: "kernel-native",
  scenario: "context-after-func-stop-race"
})
