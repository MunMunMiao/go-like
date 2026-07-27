import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "otel-instrumentation-web-handler-parent-child",
  domain: "telemetry",
  source: {
    url: "https://developer.mozilla.org/en-US/docs/Web/API/Response/bodyUsed",
    retrievedAt: "2026-07-22",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "A standard Web handler propagates a root and handler span without taking body ownership.",
  runtimes: ["Bun 1.3.14"],
  services: [
    "OpenTelemetry JavaScript 2.10.0",
    "Collector 0.157.0 Docker",
    "standard Web handler",
    "Node HTTP listener"
  ],
  assertions: [
    "Collector receives the Web root and handler spans with exact parentage.",
    "Instrumentation leaves request and response bodies unread and unlocked at their ownership boundaries."
  ],
  cleanupEvidence: ["Both HTTP servers, provider, and Collector container reach terminal cleanup."],
  suite: "otel-instrumentation-docker",
  scenario: "standard-web-handler-parent-child"
})
