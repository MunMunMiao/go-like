import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "bullmq-queue-ownership-cleanup",
  domain: "durable-job",
  source: {
    url: "https://docs.bullmq.io/guide/workers/graceful-shutdown",
    retrievedAt: "2026-07-18",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "The application-owned Queue stays usable until the application closes it after every application-configured Worker.",
  runtimes: ["Bun 1.3.14"],
  services: ["BullMQ 5.81.2", "Redis 8.8.1 Docker"],
  assertions: [
    "A final job remains queryable after all Worker Servers stop.",
    "The Queue remains usable until the application closes it after Worker connections return to baseline."
  ],
  cleanupEvidence: ["The application closes Queue last and Redis reports zero persistent clients."],
  suite: "bullmq-docker",
  scenario: "application-closes-queue-last-and-zero-connections"
})
