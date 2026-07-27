import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "jetstream-dlq-ordering",
  domain: "messaging-jetstream",
  source: {
    url: "https://docs.nats.io/nats-concepts/jetstream/consumers",
    retrievedAt: "2026-07-18",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "Application-owned dead-letter handling publishes with real PubAck before terminating the source message exactly once.",
  runtimes: ["Bun 1.3.14"],
  services: ["NATS Server 2.14.3 with JetStream", "NATS JavaScript 3.4.0"],
  assertions: [
    "A real initial application DLQ publish failure leaves the source unacked for redelivery.",
    "The recovered DLQ stream contains exactly one original payload and source ack pending is zero."
  ],
  cleanupEvidence: [
    "The lifecycle adapter stops both application-created iterators and all Docker resources are removed."
  ],
  suite: "nats-jetstream-docker",
  scenario: "dlq-real-publish-failure-redelivery-puback-term-exactly-once"
})
