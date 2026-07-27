import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "jetstream-ackack",
  domain: "messaging-jetstream",
  source: {
    url: "https://docs.nats.io/nats-concepts/jetstream",
    retrievedAt: "2026-07-18",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "A durable consumer receives the official raw JsMsg and confirms its explicit acknowledgement with the server.",
  runtimes: ["Bun 1.3.14"],
  services: ["NATS Server 2.14.3 with JetStream", "NATS JavaScript 3.4.0"],
  assertions: [
    "Raw subject, payload, and consumer metadata are intact.",
    "ackAck receives server confirmation and ack pending reaches zero."
  ],
  cleanupEvidence: [
    "The lifecycle-owned iterator stops without deleting the application-owned durable or connection."
  ],
  suite: "nats-jetstream-docker",
  scenario: "durable-explicit-raw-jsmsg-ackack"
})
