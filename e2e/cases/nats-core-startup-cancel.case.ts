import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "nats-core-startup-cancel",
  domain: "messaging-core",
  source: {
    url: "https://docs.nats.io/using-nats/developer/receiving",
    retrievedAt: "2026-07-18",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "Canceled startup rolls back only a factory-created unaccepted Subscription and leaves a direct application-owned Subscription untouched.",
  runtimes: ["Bun 1.3.14"],
  services: ["NATS Server 2.14.3 Docker", "NATS JavaScript 3.4.0"],
  assertions: [
    "The exact cancellation cause wins.",
    "A later publish is not delivered to the factory-created subscription after rollback.",
    "A direct Subscription rejected before acceptance remains live for application use and cleanup."
  ],
  assertionScenarios: [
    "startup-cancel-unconsumed-subscription-cleanup",
    "startup-cancel-unconsumed-subscription-cleanup",
    "startup-cancel-direct-subscription-preserved"
  ],
  cleanupEvidence: [
    "Factory rollback leaves the borrowed connection open.",
    "The application cleans up the rejected direct Subscription while the borrowed connection remains open."
  ],
  cleanupProofs: [
    "scenario:startup-cancel-unconsumed-subscription-cleanup",
    "scenario:startup-cancel-direct-subscription-preserved"
  ],
  suite: "nats-core-docker",
  scenario: "startup-cancel-unconsumed-subscription-cleanup"
})
