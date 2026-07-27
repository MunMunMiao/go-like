import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "jetstream-startup-cancel",
  domain: "messaging-jetstream",
  source: {
    url: "https://docs.nats.io/nats-concepts/jetstream/consumers",
    retrievedAt: "2026-07-18",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "Canceled startup rolls back only factory-created unaccepted ConsumerMessages and leaves a direct application-owned iterator untouched.",
  runtimes: ["Bun 1.3.14"],
  services: ["NATS Server 2.14.3 with JetStream", "NATS JavaScript 3.4.0"],
  assertions: [
    "The cancellation cause is preserved.",
    "The factory-created iterator is stopped while its durable remains application-owned and inspectable.",
    "Direct ConsumerMessages rejected before acceptance remain live for application use and cleanup."
  ],
  assertionScenarios: [
    "startup-cancel-official-unconsumed-iterator-rollback",
    "startup-cancel-official-unconsumed-iterator-rollback",
    "startup-cancel-direct-consumer-messages-preserved"
  ],
  cleanupEvidence: [
    "Factory rollback does not delete the borrowed connection or durable.",
    "The application cleans up rejected direct ConsumerMessages without deleting the borrowed connection or durable."
  ],
  cleanupProofs: [
    "scenario:startup-cancel-official-unconsumed-iterator-rollback",
    "scenario:startup-cancel-direct-consumer-messages-preserved"
  ],
  suite: "nats-jetstream-docker",
  scenario: "startup-cancel-official-unconsumed-iterator-rollback"
})
