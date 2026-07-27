import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "otel-instrumentation-unary-parent-child",
  domain: "telemetry",
  source: {
    url: "https://opentelemetry.io/docs/languages/js/propagation/",
    retrievedAt: "2026-07-22",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "A real LikeGo unary HTTP call propagates one trace from the root through client and server spans.",
  runtimes: ["Bun 1.3.14"],
  services: ["OpenTelemetry JavaScript 2.10.0", "Collector 0.157.0 Docker", "Node HTTP listener"],
  assertions: [
    "Collector receives the root, client, and server spans in one trace.",
    "The real HTTP response headers and body reach the caller unchanged."
  ],
  cleanupEvidence: [
    "The unary HTTP Server, telemetry provider, and Collector reach terminal cleanup."
  ],
  suite: "otel-instrumentation-docker",
  scenario: "client-http-server-parent-child"
})
