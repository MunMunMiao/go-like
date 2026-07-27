import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "app-structural-server",
  domain: "app",
  source: {
    url: "https://github.com/go-kratos/kratos/blob/668db92c2c001e9552594ba5a8aede8456af6d7e/transport/transport.go#L16-L25",
    retrievedAt: "2026-07-18",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "A plain structurally compatible server joins the application without inheritance or decorators.",
  runtimes: ["Bun 1.3.14"],
  services: ["LikeGo App lifecycle"],
  assertions: [
    "Both plain server objects start in registration order.",
    "App.run remains active until App.stop settles both Server runtimes."
  ],
  cleanupEvidence: ["App.stop settles and the App.run Promise completes."],
  suite: "kernel-native",
  scenario: "core-plain-structural-server-composition"
})
