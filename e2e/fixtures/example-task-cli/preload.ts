import { mock } from "bun:test"
import { resolve } from "node:path"

import * as DockerPairs from "../../harness/docker-pairs"
import * as Examples from "../../examples"

import type { ExamplesRunOptions } from "../../examples"
import { runCommand } from "../../harness/process"

const FixtureModeKey = "GO_LIKE_TEST_EXAMPLE_TASK_CLI_MODE"
const FixtureModes = Object.freeze(["scenario-failure", "timeout", "cleanup-failure"] as const)
type FixtureMode = (typeof FixtureModes)[number]

function fixtureMode(value: string | undefined): FixtureMode {
  if (FixtureModes.includes(value as FixtureMode)) return value as FixtureMode
  throw new Error("example-task CLI preload requires one explicit fixture mode")
}

const mode = fixtureMode(process.env[FixtureModeKey])
const runSingleExampleLocalRoot = Examples.runSingleExampleLocalRoot
const dockerPairsUrl = Bun.pathToFileURL(
  resolve(import.meta.dir, "../../harness/docker-pairs.ts")
).href
const examplesUrl = Bun.pathToFileURL(resolve(import.meta.dir, "../../examples.ts")).href

mock.module(dockerPairsUrl, () => ({
  ...DockerPairs,
  cleanupDockerPair: async (): Promise<void> => {}
}))

mock.module(examplesUrl, () => ({
  ...Examples,
  runSingleExampleLocalRoot: async (input: {
    readonly root?: string | undefined
    readonly cwd: string
    readonly scenarioArgv: readonly string[]
    readonly signal?: AbortSignal | undefined
  }) => {
    const options: ExamplesRunOptions = Object.freeze({
      timeoutMs: mode === "timeout" ? 1_000 : 5_000,
      gracePeriodMs: mode === "timeout" ? 1_000 : 100,
      hardTerminationReserveMs: 7_000,
      dockerCleanupTimeoutMs: 1_000,
      pollIntervalMs: 5,
      workerDriverDrainMs: mode === "timeout" ? 2_000 : 1_000,
      runner: runCommand,
      dockerBackstop: async () => {
        if (mode === "cleanup-failure") {
          throw new Error("example-task-cli:root-backstop-failed")
        }
      }
    })
    const result = await runSingleExampleLocalRoot({ ...input, options })
    const record = result.examples[0]
    process.stdout.write(
      `GO_LIKE_EXAMPLE_TASK_CLI_FIXTURE=${JSON.stringify({
        mode,
        status: result.status,
        classification: record?.classification ?? null,
        wrapperEntered: record?.wrapperEntered ?? false,
        acknowledged: record?.acknowledged ?? false,
        resultStatus: record?.result?.status ?? null,
        resultAborted: record?.result?.aborted ?? false,
        commandTermination: record?.command?.termination ?? null,
        cleanupFailureCodes: result.cleanupFailures.map((failure) => failure.code)
      })}\n`
    )
    return result
  }
}))
