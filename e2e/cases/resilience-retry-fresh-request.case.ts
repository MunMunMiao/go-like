import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "resilience-retry-fresh-request",
  domain: "resilience",
  source: {
    url: "https://github.com/go-kratos/kratos/blob/668db92c2c001e9552594ba5a8aede8456af6d7e/contrib/registry/etcd/registry.go#L183-L223",
    retrievedAt: "2026-07-18",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "An explicitly authorized retry recreates one Fetch Request per bounded attempt and applies capped exponential backoff.",
  runtimes: ["Bun 1.3.14"],
  services: ["standard Fetch", "native timers"],
  assertions: [
    "Exactly three attempts run before the successful response is returned.",
    "Every attempt creates and consumes a distinct Request body inside the operation.",
    "The backoff sequence starts at the configured delay and respects its cap."
  ],
  cleanupEvidence: [
    "The retry completes its exact Request sequence and leaves no pending native timer."
  ],
  suite: "resilience-native",
  scenario: "retry-fresh-request-bounded-backoff"
})
