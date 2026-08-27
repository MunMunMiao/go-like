import { resolve } from "node:path"

import { runE2e } from "./executor"
import { errorSummary } from "./harness/diagnostics"

export { runE2e } from "./executor"

if (import.meta.main) {
  const controller = new AbortController()
  const interrupt = (name: string) => controller.abort(new Error(`E2E interrupted by ${name}`))
  const onSigint = () => interrupt("SIGINT")
  const onSigterm = () => interrupt("SIGTERM")
  process.once("SIGINT", onSigint)
  process.once("SIGTERM", onSigterm)
  try {
    await runE2e(resolve(import.meta.dir, ".."), process.argv.slice(2), controller.signal)
  } catch (error) {
    process.stderr.write(`${errorSummary(error)}\n`)
    process.exitCode = 1
  } finally {
    process.removeListener("SIGINT", onSigint)
    process.removeListener("SIGTERM", onSigterm)
  }
}
