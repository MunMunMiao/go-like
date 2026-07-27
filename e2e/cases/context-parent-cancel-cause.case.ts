import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "context-parent-cancel-cause",
  domain: "context",
  source: {
    url: "https://pkg.go.dev/context",
    retrievedAt: "2026-07-18",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "A parent cancellation propagates to its child while preserving the first explicit cause.",
  runtimes: ["Bun 1.3.14"],
  services: ["standard AbortSignal"],
  assertions: [
    "The child exposes the canceled sentinel.",
    "cause(child) retains the exact parent Error."
  ],
  cleanupEvidence: [
    "The child cancellation signal reaches its terminal aborted state with no timer residue."
  ],
  suite: "kernel-native",
  scenario: "context-parent-cancel-cause-propagation"
})
