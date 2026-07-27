import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "store-file-process-crash",
  domain: "store",
  source: {
    url: "https://nodejs.org/api/fs.html",
    retrievedAt: "2026-07-21",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "A killed File Store owner leaves a lock and incomplete temp, fails closed until explicit recovery, and never replaces the last complete snapshot.",
  runtimes: ["Bun 1.3.14"],
  services: ["Node filesystem", "LikeGo File Store"],
  assertions: [
    "The independent owner is killed, stale ownership is rejected, and the last complete snapshot is restored."
  ],
  cleanupEvidence: ["The child process, lock, temp file, and isolated directory are removed."],
  suite: "store-file-process",
  scenario: "file-store-process-crash-recovery"
})
