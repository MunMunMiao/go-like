import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "context-deadline-timeout",
  domain: "context",
  source: {
    url: "https://pkg.go.dev/context",
    retrievedAt: "2026-07-18",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "A timeout context publishes a deadline and terminates with deadlineExceeded.",
  runtimes: ["Bun 1.3.14"],
  services: ["native timers", "standard AbortSignal"],
  assertions: [
    "deadline() reports a Date.",
    "err() and cause() both report deadlineExceeded after expiry."
  ],
  cleanupEvidence: ["The timeout is canceled and native timer count returns to baseline."],
  suite: "kernel-native",
  scenario: "context-deadline-timeout-sentinel"
})
