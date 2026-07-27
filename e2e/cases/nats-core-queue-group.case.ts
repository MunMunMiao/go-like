import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "nats-core-queue-group",
  domain: "messaging-core",
  source: {
    url: "https://docs.nats.io/using-nats/developer/receiving/queues",
    retrievedAt: "2026-07-18",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "Two subscribers in one queue group distribute messages without duplicating a delivery.",
  runtimes: ["Bun 1.3.14"],
  services: ["NATS Server 2.14.3 Docker", "NATS JavaScript 3.4.0"],
  assertions: [
    "Twenty messages are distributed across both workers.",
    "Each publication is delivered to one queue member."
  ],
  cleanupEvidence: [
    "Both subscriptions stop and the borrowed connection remains application-owned."
  ],
  suite: "nats-core-docker",
  scenario: "queue-group-distribution"
})
