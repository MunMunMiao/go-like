import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "config-etcd-watch-compaction",
  domain: "config",
  source: {
    url: "https://etcd.io/docs/v3.7/learning/api/",
    retrievedAt: "2026-07-21",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "Configuration loads an exact etcd revision, observes update and delete events, and relists after watch compaction.",
  runtimes: ["Bun 1.3.14"],
  services: ["etcd 3.7.1 Docker JSON gateway", "standard Fetch"],
  assertions: [
    "The source observes initial, update, delete, and compacted-watch recovery against real etcd."
  ],
  cleanupEvidence: [
    "The watched key, watcher, process tree, and fixed-digest container are removed."
  ],
  suite: "config-etcd-docker",
  scenario: "config-etcd-load-watch-delete-compaction"
})
