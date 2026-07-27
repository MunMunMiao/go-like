import { resolve } from "node:path"

import { runSuite, suiteDefinitions } from "./suites"

function selectedSuites(args: readonly string[]): readonly string[] {
  const definitions = suiteDefinitions()
  if (args.length === 1 && args[0] === "--docker") {
    return definitions
      .filter((definition) => definition.docker && definition.id !== "examples")
      .map((definition) => definition.id)
  }
  if (args.length === 0) return definitions.map((definition) => definition.id)

  const selected: string[] = []
  for (let index = 0; index < args.length; index += 2) {
    const suite = args[index + 1]
    if (args[index] !== "--suite" || suite === undefined) {
      throw new Error("E2E arguments must be repeated --suite <name> pairs")
    }
    if (!definitions.some((definition) => definition.id === suite)) {
      throw new Error(`unknown E2E suite ${suite}`)
    }
    if (!selected.includes(suite)) selected.push(suite)
  }
  return Object.freeze(selected)
}

export async function runE2e(
  root: string,
  args: readonly string[],
  signal?: AbortSignal
): Promise<void> {
  for (const suite of selectedSuites(args)) {
    signal?.throwIfAborted()
    process.stderr.write(`[e2e] ${suite}\n`)
    await runSuite(root, suite, signal)
  }
}

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
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
    process.exitCode = 1
  } finally {
    process.removeListener("SIGINT", onSigint)
    process.removeListener("SIGTERM", onSigterm)
  }
}
