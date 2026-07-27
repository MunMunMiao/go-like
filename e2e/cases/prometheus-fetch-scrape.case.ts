import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "prometheus-fetch-scrape",
  domain: "metrics",
  source: {
    url: "https://github.com/prometheus/client_js/blob/main/README.md",
    retrievedAt: "2026-07-18",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "An isolated official Prometheus Registry is rendered through a standard LikeGo Web Handler.",
  runtimes: ["Node.js 26.5.0"],
  services: ["prom-client 15.1.3", "standard Web Handler"],
  assertions: ["The counter scrape returns 200 and contains the incremented sample."],
  cleanupEvidence: ["The application-owned Registry is cleared after the scrape."],
  suite: "prometheus-runtime",
  scenario: "prometheus-registry-handler-scrape"
})
