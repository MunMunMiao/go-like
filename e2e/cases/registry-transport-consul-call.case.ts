import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "registry-transport-consul-call",
  domain: "registry",
  source: {
    url: "https://github.com/micro/go-micro/blob/db4401d306039be2614e0e3657c6a5c6473feb3b/client/client.go",
    retrievedAt: "2026-07-20",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "Two Core Apps bind current unary Servers, publish their bound ServiceInstances through Consul, and a current Client discovers, selects, and calls them across deregistration.",
  runtimes: ["Bun 1.3.14"],
  services: ["Consul 2.0.2 Docker", "LikeGo HTTP Transport", "LikeGo Server", "standard Fetch"],
  assertions: [
    "Each App binds and starts its Server before registering its dynamic address.",
    "Consul discovery and the initial watcher snapshot expose nodes a,b.",
    "Four real calls select nodes in a,b,a,b order.",
    "After App a deregisters, the watcher converges to b and the next real call selects b.",
    "Registry register and deregister operations return void, and each deregistration precedes Server stop.",
    "Transport clients are reused per endpoint and each resident client closes exactly once."
  ],
  cleanupEvidence: ["Registrations, ports and Docker resources return to baseline."],
  suite: "registry-transport-consul-docker",
  scenario: "consul-discovery-http-call-lifecycle"
})
