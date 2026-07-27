import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "resilience-token-bucket-refill",
  domain: "resilience",
  source: {
    url: "https://github.com/go-kratos/kratos/blob/668db92c2c001e9552594ba5a8aede8456af6d7e/middleware/ratelimit/ratelimit.go#L38-L57",
    retrievedAt: "2026-07-18",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "A non-blocking token bucket admits its configured burst, rejects excess work, and refills lazily after an interval.",
  runtimes: ["Bun 1.3.14"],
  services: ["standard monotonic clock"],
  assertions: [
    "The initial capacity admits exactly two calls.",
    "The next call is rejected with a positive retry delay.",
    "One complete interval lazily restores the configured token count without a resident timer."
  ],
  cleanupEvidence: ["The limiter refills lazily and leaves no resident native timer."],
  suite: "resilience-native",
  scenario: "token-bucket-capacity-refill"
})
