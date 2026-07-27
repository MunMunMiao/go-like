import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "otel-outage-business-progress",
  domain: "telemetry",
  source: {
    url: "https://opentelemetry.io/docs/languages/js/exporters/",
    retrievedAt: "2026-07-18",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "Collector outage is observed for both signals without blocking application work.",
  runtimes: ["Bun 1.3.14"],
  services: ["OpenTelemetry JavaScript 2.10.0", "Collector 0.157.0 Docker"],
  assertions: [
    "Trace and metric exporter failures are observed.",
    "Business span and counter calls both return during outage."
  ],
  cleanupEvidence: ["The restarted Collector is removed after provider shutdown."],
  suite: "otel-docker",
  scenario: "collector-outage-does-not-block-business"
})
