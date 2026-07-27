import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "nats-core-reconnect",
  domain: "messaging-core",
  source: {
    url: "https://docs.nats.io/using-nats/developer/connecting",
    retrievedAt: "2026-07-18",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "An application-created Core subscription under lifecycle ownership resumes after a real NATS server stop and restart.",
  runtimes: ["Bun 1.3.14"],
  services: ["NATS Server 2.14.3 Docker", "NATS JavaScript 3.4.0"],
  assertions: [
    "Disconnect and reconnect status events are observed.",
    "A post-restart message reaches the existing subscription."
  ],
  cleanupEvidence: [
    "The borrowed connection closes only in application cleanup and the container is removed."
  ],
  suite: "nats-core-docker",
  scenario: "transient-outage-reconnect"
})
