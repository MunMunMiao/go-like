import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "store-consul-acl-redaction",
  domain: "store",
  source: {
    url: "https://developer.hashicorp.com/consul/api-docs/session",
    retrievedAt: "2026-07-21",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "A default-deny Consul accepts authenticated Store and Session operations while rejecting anonymous access without leaking the token.",
  runtimes: ["Bun 1.3.14"],
  services: ["Consul 2.0.2 Docker with ACLs", "standard Fetch"],
  assertions: [
    "Anonymous access is denied and the credential appears only in the intended header."
  ],
  cleanupEvidence: [
    "Authenticated KV, Sessions, process trees, and the ACL container are removed."
  ],
  suite: "store-consul-docker",
  scenario: "consul-store-acl-redaction"
})
