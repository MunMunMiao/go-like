import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "app-graceful-stop",
  domain: "app",
  source: {
    url: "https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#pod-termination",
    retrievedAt: "2026-07-18",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario: "Application shutdown requests every registered Server to stop.",
  runtimes: ["Bun 1.3.14"],
  services: ["LikeGo App lifecycle"],
  assertions: [
    "Both Server start methods are invoked in registration order.",
    "Both Server stop methods are invoked and their start Promises settle."
  ],
  cleanupEvidence: ["App.stop settles and the App.run Promise completes."],
  suite: "kernel-native",
  scenario: "core-graceful-stop"
})
