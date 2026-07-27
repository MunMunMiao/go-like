import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "jetstream-max-deliver",
  domain: "messaging-jetstream",
  source: {
    url: "https://docs.nats.io/nats-concepts/jetstream/consumers",
    retrievedAt: "2026-07-18",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "An application consumer leaves a message unacknowledged and native JetStream enforces the configured MaxDeliver count.",
  runtimes: ["Bun 1.3.14"],
  services: ["NATS Server 2.14.3 with JetStream", "NATS JavaScript 3.4.0"],
  assertions: [
    "Observed delivery counts are exactly one then two.",
    "No third delivery occurs after the wait window."
  ],
  cleanupEvidence: [
    "The lifecycle-owned iterator stops and the application-owned durable remains inspectable."
  ],
  suite: "nats-jetstream-docker",
  scenario: "explicit-ack-max-deliver"
})
