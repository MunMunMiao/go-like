import { resolve } from "node:path"

import { runCommand } from "../../harness/process"

const secret = process.env.LIKEGO_E2E_CANARY ?? "missing-secret"
const root = resolve(import.meta.dir, "../../..")
const result = await runCommand(root, {
  cwd: ".",
  command: [process.execPath, resolve(import.meta.dir, "diagnostics.ts"), "failure"],
  environment: { LIKEGO_E2E_CANARY: secret },
  forwardOutput: true,
  knownSecrets: [secret],
  timeoutMs: 2_000
})

process.stdout.write(`RESULT=${JSON.stringify(result)}\n`)
if (result.exitCode !== 17) process.exitCode = 1
