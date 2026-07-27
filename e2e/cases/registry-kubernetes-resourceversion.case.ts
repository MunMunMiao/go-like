import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "registry-kubernetes-resourceversion",
  domain: "registry",
  source: {
    url: "https://kubernetes.io/docs/reference/kubernetes-api/discovery/endpoint-slice-v1/",
    retrievedAt: "2026-07-21",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "Every Kubernetes Registry EndpointSlice update and delete is protected by resourceVersion CAS.",
  runtimes: ["Bun 1.3.14"],
  services: ["K3s 1.36.2 Docker", "Kubernetes EndpointSlice API", "standard Fetch"],
  assertions: [
    "A stale update returns 409.",
    "Provider updates and deletes carry the current resourceVersion precondition."
  ],
  cleanupEvidence: [
    "Managed slices, namespaces, RBAC, K3s container, volumes, and process trees are removed."
  ],
  suite: "registry-kubernetes-docker",
  scenario: "kubernetes-resourceversion-cas"
})
