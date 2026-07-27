import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "registry-kubernetes-service-lifecycle",
  domain: "registry",
  source: {
    url: "https://kubernetes.io/docs/concepts/services-networking/endpoint-slices/",
    retrievedAt: "2026-07-21",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "The Kubernetes Registry completes ServiceInstance register, get, watch replacement, and deregister through a namespaced EndpointSlice.",
  runtimes: ["Bun 1.3.14"],
  services: ["K3s 1.36.2 Docker", "Kubernetes EndpointSlice API", "standard Fetch"],
  assertions: [
    "The real API round-trips the service instance.",
    "The watch publishes create, update replacement, and an explicit empty collection.",
    "Deleting the same-namespace owner Pod garbage-collects its managed EndpointSlice."
  ],
  cleanupEvidence: [
    "Managed slices, namespaces, RBAC, K3s container, volumes, and process trees are removed."
  ],
  suite: "registry-kubernetes-docker",
  scenario: "kubernetes-endpointslice-service-lifecycle"
})
