import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "nats-core-raw-pubsub",
  domain: "messaging-core",
  source: {
    url: "https://docs.nats.io/using-nats/developer/receiving",
    retrievedAt: "2026-07-18",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "Core NATS delivers the official raw Msg payload and subject through an application-created subscription.",
  runtimes: ["Bun 1.3.14"],
  services: ["NATS Server 2.14.3 Docker", "NATS JavaScript 3.4.0"],
  assertions: ["The raw subject and payload match the publication."],
  cleanupEvidence: [
    "The lifecycle-owned subscription stops while the borrowed connection remains application-owned."
  ],
  suite: "nats-core-docker",
  scenario: "raw-pub-sub"
})
