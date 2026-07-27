import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "cron-explicit-stop-no-fabricated-drain",
  domain: "cron",
  source: {
    url: "https://jsr.io/@hexagon/croner/doc",
    retrievedAt: "2026-07-18",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "Explicit lifecycle stop prevents future Croner scheduling and cancels the runtime Context without claiming that a running native callback drained.",
  runtimes: ["Node.js 26.5.0"],
  services: ["Croner 10.0.1", "LikeGo Context"],
  assertions: [
    "LikeGo stop and done settle while the held native callback remains busy.",
    "The runtime Context is canceled and the callback later settles only after application release."
  ],
  cleanupEvidence: [
    "The application releases the callback and native timer count returns to baseline."
  ],
  suite: "cron-native",
  scenario: "explicit-stop-does-not-fabricate-native-callback-drain"
})
