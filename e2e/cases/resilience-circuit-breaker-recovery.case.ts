import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "resilience-circuit-breaker-recovery",
  domain: "resilience",
  source: {
    url: "https://github.com/go-kratos/kratos/blob/668db92c2c001e9552594ba5a8aede8456af6d7e/middleware/circuitbreaker/circuitbreaker.go#L36-L66",
    retrievedAt: "2026-07-18",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "Consecutive failures open a circuit, reject work locally, and admit one successful half-open recovery probe.",
  runtimes: ["Bun 1.3.14"],
  services: ["native timers"],
  assertions: [
    "The configured failure threshold opens the circuit.",
    "An open circuit rejects with the shared circuitOpen sentinel without invoking the operation.",
    "After the reset timeout, one successful probe returns the circuit to closed."
  ],
  cleanupEvidence: ["The breaker schedules no background work and finishes with no active probe."],
  suite: "resilience-native",
  scenario: "circuit-open-half-open-recovery"
})
