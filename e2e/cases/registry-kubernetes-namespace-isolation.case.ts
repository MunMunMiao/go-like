import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "registry-kubernetes-namespace-isolation",
  domain: "registry",
  source: {
    url: "https://kubernetes.io/docs/reference/access-authn-authz/rbac/",
    retrievedAt: "2026-07-21",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "A namespaced Kubernetes Registry leaves foreign EndpointSlices unchanged and keeps every provider request in its configured collection.",
  runtimes: ["Bun 1.3.14"],
  services: ["K3s 1.36.2 Docker", "Kubernetes EndpointSlice API", "standard Fetch"],
  assertions: ["The provider never mutates the foreign slice or leaves its namespaced API path."],
  cleanupEvidence: [
    "Managed slices, namespaces, Role bindings, container, volumes, and process trees are removed."
  ],
  suite: "registry-kubernetes-docker",
  scenario: "kubernetes-namespace-foreign-isolation"
})
