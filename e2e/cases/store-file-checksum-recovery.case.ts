import { newSourcedCase } from "../case"

export const sourcedCase = newSourcedCase({
  id: "store-file-checksum-recovery",
  domain: "store",
  source: {
    url: "https://nodejs.org/api/fs.html",
    retrievedAt: "2026-07-21",
    quoteBoundary: "Link only; behavior paraphrased; no verbatim source copied."
  },
  normalizedScenario:
    "A checksummed File Store snapshot rejects corruption without losing the last valid snapshot after operator restoration.",
  runtimes: ["Bun 1.3.14"],
  services: ["Node filesystem", "LikeGo File Store"],
  assertions: [
    "Checksum corruption fails closed and restoring the exact valid bytes recovers the record."
  ],
  cleanupEvidence: ["The lock, temp file, and isolated filesystem directory are removed."],
  suite: "store-file-process",
  scenario: "file-store-checksum-fail-closed"
})
