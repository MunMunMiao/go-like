import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "bullmq-redis-recovery",
  domain: "durable-job",
  source: {
    url: "https://docs.bullmq.io/guide/workers",
    retrievedAt: "2026-07-18",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "An application-configured Worker survives a real Redis stop and restart and processes new work after reconnect.",
  runtimes: ["Bun 1.3.14"],
  services: ["BullMQ 5.81.2", "Redis 8.8.1 Docker"],
  assertions: [
    "Outage errors are observable without terminating residency.",
    "A job added after restart completes."
  ],
  cleanupEvidence: ["Worker connections return to baseline and the Redis container is removed."],
  suite: "bullmq-docker",
  scenario: "redis-stop-start-recovery-with-observational-errors"
})
