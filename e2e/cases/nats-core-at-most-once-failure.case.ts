import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "nats-core-at-most-once-failure",
  domain: "messaging-core",
  source: {
    url: "https://docs.nats.io/nats-concepts/jetstream/consumers",
    retrievedAt: "2026-07-18",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "An application-owned Core NATS consumer failure remains at-most-once; the lifecycle adapter invents no redelivery policy.",
  runtimes: ["Bun 1.3.14"],
  services: ["NATS Server 2.14.3 Docker", "NATS JavaScript 3.4.0"],
  assertions: [
    "The application consumer error is observed outside the lifecycle adapter.",
    "The failed Core message is not redelivered."
  ],
  cleanupEvidence: ["The subscription and real container are removed."],
  suite: "nats-core-docker",
  scenario: "at-most-once-handler-failure-isolation"
})
