import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { lstat, unlink } from "node:fs/promises"
import { join, resolve } from "node:path"

const Root = resolve(import.meta.dir, "..")
const FixtureCwd = resolve(Root, "e2e/fixtures/example-task-cli")
const Entry = resolve(Root, "e2e/example-task.ts")
const Preload = Bun.pathToFileURL(resolve(FixtureCwd, "preload.ts")).href
const ModeKey = "LIKEGO_TEST_EXAMPLE_TASK_CLI_MODE"
const MarkerKey = "LIKEGO_TEST_SCENARIO_MARKER"
const EvidencePrefix = "LIKEGO_EXAMPLE_TASK_CLI_FIXTURE="
const TimeoutMs = 20_000

interface DirectCliCase {
  readonly mode: "scenario-failure" | "timeout" | "cleanup-failure"
  readonly scenarioMode: "fail" | "wait" | "pass"
  readonly expected: Readonly<Record<string, unknown>>
}

interface DirectCliObservation {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly marker: string
  readonly evidence: Readonly<Record<string, unknown>>
}

const DirectCliCases = Object.freeze([
  Object.freeze({
    mode: "scenario-failure" as const,
    scenarioMode: "fail" as const,
    expected: Object.freeze({
      status: "failed",
      classification: "failed",
      wrapperEntered: true,
      acknowledged: true,
      resultStatus: "failed",
      cleanupFailureCodes: []
    })
  }),
  Object.freeze({
    mode: "timeout" as const,
    scenarioMode: "wait" as const,
    expected: Object.freeze({
      status: "timed-out",
      classification: "failed",
      wrapperEntered: true,
      acknowledged: true,
      resultStatus: "failed",
      cleanupFailureCodes: []
    })
  }),
  Object.freeze({
    mode: "cleanup-failure" as const,
    scenarioMode: "pass" as const,
    expected: Object.freeze({
      status: "failed",
      classification: "passed",
      wrapperEntered: true,
      acknowledged: true,
      resultStatus: "passed",
      cleanupFailureCodes: ["example-docker-backstop-failed"]
    })
  })
] satisfies readonly DirectCliCase[])

function fixtureEnvironment(
  selected: DirectCliCase,
  markerPath: string
): Readonly<Record<string, string | undefined>> {
  const environment: Record<string, string | undefined> = {
    ...process.env,
    BUN_OPTIONS: `--preload=${Preload}`,
    [ModeKey]: selected.mode,
    [MarkerKey]: markerPath
  }
  for (const key of Object.keys(environment)) {
    if (key === "DOCKER_CONFIG" || key.startsWith("DOCKER_")) delete environment[key]
  }
  return Object.freeze(environment)
}

function parseEvidence(stdout: string): Readonly<Record<string, unknown>> {
  const lines = stdout.split(/\r?\n/u).filter((line) => line.startsWith(EvidencePrefix))
  if (lines.length !== 1 || lines[0] === undefined) {
    throw new Error("direct CLI fixture did not publish exactly one aggregate evidence line")
  }
  const value: unknown = JSON.parse(lines[0].slice(EvidencePrefix.length))
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("direct CLI fixture aggregate evidence is invalid")
  }
  return value as Readonly<Record<string, unknown>>
}

async function runDirectCli(selected: DirectCliCase): Promise<DirectCliObservation> {
  const markerPath = join(FixtureCwd, `.scenario-${selected.mode}-${randomUUID()}.marker`)
  const child = Bun.spawn(
    [process.execPath, Entry, "--", "bun", "scenario.ts", selected.scenarioMode],
    {
      cwd: FixtureCwd,
      env: fixtureEnvironment(selected, markerPath),
      stdout: "pipe",
      stderr: "pipe"
    }
  )
  let timeout: ReturnType<typeof setTimeout> | null = null
  try {
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        child.kill("SIGKILL")
        reject(new Error(`direct CLI fixture exceeded ${TimeoutMs}ms`))
      }, TimeoutMs)
    })
    const [exitCode, stdout, stderr] = await Promise.race([
      Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text()
      ]),
      deadline
    ])
    const marker = Bun.file(markerPath)
    if (!(await marker.exists())) {
      throw new Error(
        `direct CLI fixture exited ${exitCode} without running its scenario\nstdout:\n${stdout}\nstderr:\n${stderr}`
      )
    }
    return Object.freeze({
      exitCode,
      stdout,
      stderr,
      marker: await marker.text(),
      evidence: parseEvidence(stdout)
    })
  } finally {
    if (timeout !== null) clearTimeout(timeout)
    if (child.exitCode === null) child.kill("SIGKILL")
    await child.exited.catch(() => {})
    await unlink(markerPath).catch(() => {})
  }
}

for (const selected of DirectCliCases) {
  test(
    `direct CLI fails closed for ${selected.mode} without Docker`,
    async () => {
      const observed = await runDirectCli(selected)
      expect(observed.exitCode).not.toBe(0)
      expect(observed.marker).toBe(`${selected.scenarioMode}\n`)
      expect(observed.evidence).toMatchObject({ mode: selected.mode, ...selected.expected })
      expect(observed.stdout).not.toContain("Docker pair")
      expect(observed.stderr).not.toContain("Docker pair")
      expect(observed.stdout).not.toContain("Maximum call stack")
      expect(observed.stderr).not.toContain("Maximum call stack")
    },
    TimeoutMs + 5_000
  )
}

test("direct CLI no-Docker fixture is static and leaves no scenario markers", async () => {
  expect((await lstat(resolve(FixtureCwd, "scenario.ts"))).isFile()).toBe(true)
  expect((await lstat(resolve(FixtureCwd, "preload.ts"))).isFile()).toBe(true)
  expect((await lstat(resolve(FixtureCwd, "package.json"))).isFile()).toBe(true)
  const markers = Array.from(new Bun.Glob(".scenario-*.marker").scanSync({ cwd: FixtureCwd }))
  expect(markers).toEqual([])
})
