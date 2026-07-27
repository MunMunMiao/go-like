import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "registry-zookeeper-sigkill-expiry",
  domain: "registry",
  source: {
    url: "https://zookeeper.apache.org/doc/current/zookeeperOver.html",
    retrievedAt: "2026-07-21",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "A ZooKeeper Registry publisher terminated by SIGKILL loses its ephemeral registration after server-side session expiry without application cleanup code.",
  runtimes: ["Bun 1.3.14"],
  services: ["ZooKeeper 3.9.5 Docker", "node-zookeeper-client 1.1.3"],
  assertions: [
    "An independent publisher becomes discoverable, is killed with SIGKILL, and its ephemeral service record disappears through real ZooKeeper session expiry."
  ],
  cleanupEvidence: [
    "The killed publisher is reaped and no owned znode, ZooKeeper session, container, or process remains."
  ],
  suite: "registry-zookeeper-docker",
  scenario: "sigkill-publisher-ephemeral-expiry"
})
