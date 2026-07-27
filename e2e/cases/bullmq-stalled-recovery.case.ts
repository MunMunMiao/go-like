import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "bullmq-stalled-recovery",
  domain: "durable-job",
  source: {
    url: "https://docs.bullmq.io/guide/jobs/stalled",
    retrievedAt: "2026-07-18",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "A job locked by a crashed independent Worker is detected as stalled and recovered by the application-configured Worker.",
  runtimes: ["Bun 1.3.14"],
  services: ["BullMQ 5.81.2", "Redis 8.8.1 Docker"],
  assertions: [
    "The raw Worker process exits while holding the active lock.",
    "The application-configured Worker completes the same job with advanced stalled counters."
  ],
  cleanupEvidence: ["Worker connections return to baseline and no child process remains."],
  suite: "bullmq-docker",
  scenario: "independent-raw-worker-crash-and-stalled-recovery"
})
