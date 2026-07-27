import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "registry-kubernetes-watch-recovery",
  domain: "registry",
  source: {
    url: "https://kubernetes.io/docs/reference/kubernetes-api/discovery/endpoint-slice-v1/",
    retrievedAt: "2026-07-21",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "A Kubernetes Registry watch receiving ResourceExpired 410 performs a fresh list, reopens the watch, and observes later EndpointSlice creation.",
  runtimes: ["Bun 1.3.14"],
  services: ["K3s 1.36.2 Docker", "Kubernetes EndpointSlice API", "standard Fetch"],
  assertions: [
    "The real API returns 410 and the watcher proves relist, re-watch, and a subsequent create event."
  ],
  cleanupEvidence: [
    "Managed slices, namespaces, RBAC, K3s container, volumes, and process trees are removed."
  ],
  suite: "registry-kubernetes-docker",
  scenario: "kubernetes-watch-410-recovery"
})
