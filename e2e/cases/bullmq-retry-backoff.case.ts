import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "bullmq-retry-backoff",
  domain: "durable-job",
  source: {
    url: "https://docs.bullmq.io/guide/retrying-failing-jobs",
    retrievedAt: "2026-07-18",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "A real Redis-backed BullMQ job retries the configured number of times with fixed backoff.",
  runtimes: ["Bun 1.3.14"],
  services: ["BullMQ 5.81.2", "Redis 8.8.1"],
  assertions: [
    "The processor runs three times.",
    "attemptsMade and elapsed fixed backoff match the job options.",
    "The application Queue remains usable after Worker stop."
  ],
  cleanupEvidence: [
    "The application-configured Worker's connections return to the Queue baseline."
  ],
  suite: "bullmq-docker",
  scenario: "retry-attempts-fixed-backoff-and-borrowed-queue"
})
