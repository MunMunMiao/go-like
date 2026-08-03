import { randomUUID } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { isAbsolute } from "node:path"

import {
  closeOwnedDockerContext,
  createContainer,
  createNetwork,
  ownedDockerContextFromEnvironment,
  readContainerLogs
} from "../../harness/owned-docker"

const mode = process.argv[2]
if (
  mode !== "registration-only" &&
  mode !== "network-then-wait" &&
  mode !== "sanitizer-canary" &&
  mode !== "mark-started"
) {
  throw new Error("example-task Docker fixture mode is invalid")
}

if (mode === "mark-started") {
  const markerPath = process.argv[3]
  if (markerPath === undefined || !isAbsolute(markerPath)) {
    throw new Error("example-task scenario marker path is invalid")
  }
  await writeFile(markerPath, "scenario-started\n", { flag: "wx", mode: 0o600 })
}

const ownedDocker = await ownedDockerContextFromEnvironment(process.env)
try {
  if (mode === "network-then-wait") {
    await createNetwork(ownedDocker, [`likego-e2e-network-${randomUUID()}`])
    await Bun.sleep(24 * 60 * 60 * 1_000)
  }
  if (mode === "sanitizer-canary") {
    const canary = process.argv[3]
    const environmentCanary = process.env.LIKEGO_C6_SECRET
    if (canary === undefined || canary.length === 0 || environmentCanary !== canary) {
      throw new Error("example-task sanitizer fixture canary is unavailable")
    }
    const container = await createContainer(
      ownedDocker,
      [
        "--env",
        `LIKEGO_C6_SECRET=${canary}`,
        "--entrypoint",
        "sh",
        "redis:8.10.0-alpine@sha256:978f0e01593e65eed801f2402944efcd936d43b5027e4908a7897baf88ed6241",
        "-c",
        'printf "%s\\n" "$LIKEGO_C6_SECRET"; sleep 1'
      ],
      { knownSecrets: [canary] }
    )
    await Bun.sleep(100)
    const logs = await readContainerLogs(ownedDocker, container, {
      knownSecrets: [canary],
      maximumCharacters: 256
    })
    process.stdout.write(`fixture-stdout:${canary}:${logs}\n`)
    process.stderr.write(`fixture-stderr:${canary}\n`)
    throw new AggregateError(
      [new Error(`nested:${canary}`), new Error(`cleanup password=${canary}`)],
      `fixture token=${canary}`
    )
  }
} finally {
  await closeOwnedDockerContext(ownedDocker)
}
