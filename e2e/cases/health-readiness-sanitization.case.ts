import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "health-readiness-sanitization",
  domain: "health",
  source: {
    url: "https://kubernetes.io/docs/concepts/configuration/liveness-readiness-startup-probes/",
    retrievedAt: "2026-07-18",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "A failed dependency removes readiness without leaking its private failure details.",
  runtimes: ["Bun 1.3.14"],
  services: ["standard Fetch", "LikeGo probe registry"],
  assertions: [
    "Liveness remains 200.",
    "Readiness returns 503 and names the public probe only.",
    "Credential-bearing error details are absent."
  ],
  cleanupEvidence: ["Both probe responses settle and native timer resources return to baseline."],
  suite: "kernel-native",
  scenario: "health-readiness-failure-is-sanitized"
})
