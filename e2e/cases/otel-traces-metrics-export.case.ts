import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "otel-traces-metrics-export",
  domain: "telemetry",
  source: {
    url: "https://opentelemetry.io/docs/languages/js/exporters/",
    retrievedAt: "2026-07-18",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "Local official providers export traces and metrics over OTLP HTTP to a real Collector.",
  runtimes: ["Bun 1.3.14"],
  services: ["OpenTelemetry JavaScript 2.10.0", "Collector 0.157.0 Docker"],
  assertions: [
    "Collector logs contain the initial span and counter.",
    "Borrowed service Resource attributes arrive."
  ],
  cleanupEvidence: ["Providers shut down and the Collector container is removed."],
  suite: "otel-docker",
  scenario: "otlp-traces-and-metrics-export"
})
