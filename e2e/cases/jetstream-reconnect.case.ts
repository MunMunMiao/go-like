import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "jetstream-reconnect",
  domain: "messaging-jetstream",
  source: {
    url: "https://docs.nats.io/nats-concepts/jetstream",
    retrievedAt: "2026-07-18",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "A durable pull consumer resumes after a real JetStream server stop, restart, and durable reprovision.",
  runtimes: ["Bun 1.3.14"],
  services: ["NATS Server 2.14.3 with JetStream", "NATS JavaScript 3.4.0"],
  assertions: [
    "Disconnect and reconnect events are observed.",
    "A post-restart message is consumed and acknowledged by the existing application iterator."
  ],
  cleanupEvidence: [
    "The borrowed connection, durable, and container follow explicit cleanup ownership."
  ],
  suite: "nats-jetstream-docker",
  scenario: "transient-outage-reconnect"
})
