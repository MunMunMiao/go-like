import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "context-without-cancel-value",
  domain: "context",
  source: {
    url: "https://pkg.go.dev/context",
    retrievedAt: "2026-07-18",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "withoutCancel keeps request values while detaching deadline and cancellation ancestry.",
  runtimes: ["Bun 1.3.14"],
  services: ["standard AbortSignal"],
  assertions: [
    "The detached context retains the exact value.",
    "It has no deadline, done signal, or cancellation error."
  ],
  cleanupEvidence: [
    "The parent reaches aborted while the detached context remains unaffected and timer-free."
  ],
  suite: "kernel-native",
  scenario: "context-without-cancel-retains-values"
})
