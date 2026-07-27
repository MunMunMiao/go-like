import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "otel-instrumentation-collector-export",
  domain: "telemetry",
  source: {
    url: "https://opentelemetry.io/docs/languages/js/propagation/",
    retrievedAt: "2026-07-22",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "The real OpenTelemetry Collector receives every emitted instrumentation span.",
  runtimes: ["Bun 1.3.14"],
  services: ["OpenTelemetry JavaScript 2.10.0", "Collector 0.157.0 Docker"],
  assertions: [
    "The Collector receives all five spans emitted by the unary and standard Web handler paths.",
    "The exported span names remain observable before provider shutdown."
  ],
  cleanupEvidence: ["The telemetry provider and Collector container both reach terminal cleanup."],
  suite: "otel-instrumentation-docker",
  scenario: "otel-collector-export"
})
