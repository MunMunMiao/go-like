import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "bullmq-noncooperative-force",
  domain: "durable-job",
  source: {
    url: "https://docs.bullmq.io/guide/workers/graceful-shutdown",
    retrievedAt: "2026-07-18",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "An application processor ignores its official AbortSignal, so Worker stop reports its bounded provider timeout while the Server runtime remains observable.",
  runtimes: ["Bun 1.3.14"],
  services: ["BullMQ 5.81.2", "Redis 8.8.1 Docker"],
  assertions: [
    "The official BullMQ processor AbortSignal receives the Worker lifecycle force request.",
    "App.stop preserves the BullMQ shutdown-timeout Error while the native Worker remains pending.",
    "Releasing the application processor settles native terminal with the original adapter timeout identity."
  ],
  cleanupEvidence: [
    "The application-configured Worker's connections close before the application Queue."
  ],
  suite: "bullmq-docker",
  scenario: "noncooperative-provider-timeout-until-handler-terminal"
})
