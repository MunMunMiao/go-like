import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "otel-shutdown-flush",
  domain: "telemetry",
  source: {
    url: "https://opentelemetry.io/docs/languages/js/exporters/",
    retrievedAt: "2026-07-18",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "Provider shutdown naturally flushes final trace and metric data exactly once.",
  runtimes: ["Bun 1.3.14"],
  services: ["OpenTelemetry JavaScript 2.10.0", "Collector 0.157.0 Docker"],
  assertions: [
    "The final span and counter are present after stop and done.",
    "The shutdown span appears exactly once."
  ],
  cleanupEvidence: ["Both providers settle and the Collector container count is zero."],
  suite: "otel-docker",
  scenario: "shutdown-flushes-both-signals"
})
