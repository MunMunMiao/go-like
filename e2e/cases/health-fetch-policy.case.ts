import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "health-fetch-policy",
  domain: "health",
  source: {
    url: "https://kubernetes.io/docs/concepts/configuration/liveness-readiness-startup-probes/",
    retrievedAt: "2026-07-18",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "Health endpoints implement GET and HEAD parity, reject unsupported methods, and disable caching.",
  runtimes: ["Bun 1.3.14"],
  services: ["standard Fetch", "LikeGo probe registry"],
  assertions: [
    "HEAD has status parity and no body.",
    "POST returns 405 with Allow.",
    "Unknown path returns 404 and health responses use no-store."
  ],
  cleanupEvidence: ["All Fetch responses settle and native timer resources return to baseline."],
  suite: "kernel-native",
  scenario: "health-fetch-routing-head-and-cache-policy"
})
