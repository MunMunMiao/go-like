import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "registry-zookeeper-service-lifecycle",
  domain: "registry",
  source: {
    url: "https://zookeeper.apache.org/doc/current/zookeeperProgrammers.html",
    retrievedAt: "2026-07-21",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "A LikeGo service instance completes register, get, watch update, and deregister against real ZooKeeper.",
  runtimes: ["Bun 1.3.14"],
  services: ["ZooKeeper 3.9.5 Docker", "node-zookeeper-client 1.1.3"],
  assertions: [
    "Registration is returned by getService.",
    "The watcher publishes registration, replacement, and an empty collection after deregistration."
  ],
  cleanupEvidence: [
    "Owned znodes, ZooKeeper sessions, the container, and the process tree are removed."
  ],
  suite: "registry-zookeeper-docker",
  scenario: "service-instance-register-get-watch-update-deregister"
})
