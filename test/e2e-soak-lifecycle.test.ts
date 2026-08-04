import { expect, test } from "bun:test"
import { join, resolve } from "node:path"

import { finalizeWithCleanup } from "../e2e/harness/cleanup"
import { errorSummary } from "../e2e/harness/diagnostics"
import { runCommand, type CommandResult } from "../e2e/harness/process"
import { createTempDirectory, removeTempDirectory } from "../e2e/harness/temp"
import {
  checked,
  collectSoakCleanupFailures,
  K6Image,
  k6RunCommand,
  K6Version,
  k6VersionCommand,
  K6Workload,
  loadMetrics,
  parseK6Version,
  preflightK6,
  type SoakCleanupActions
} from "../e2e/soak"

const Root = resolve(import.meta.dir, "..")

function commandResult(stdout: string, overrides: Partial<CommandResult> = {}): CommandResult {
  return Object.freeze({
    exitCode: 0,
    signal: null,
    termination: "exit",
    timedOut: false,
    abortReason: null,
    durationMs: 1,
    stdout,
    stderr: "",
    cleanupFailures: Object.freeze([]),
    containment: "not-claimed",
    residual: "zero-observed",
    ...overrides
  })
}

test("k6 workload is committed TypeScript with isolated globals", async () => {
  const workload = await Bun.file(join(Root, "e2e/load/k6-http.ts")).text()
  const webHost = await Bun.file(join(Root, "e2e/load/web-host.ts")).text()
  const loadConfig = await Bun.file(join(Root, "e2e/load/tsconfig.json")).json()
  const e2eConfig = await Bun.file(join(Root, "e2e/tsconfig.json")).json()

  expect(await Bun.file(join(Root, "e2e/load/k6-http.js")).exists()).toBe(false)
  expect(loadConfig.extends).toBeUndefined()
  expect(loadConfig.compilerOptions.types).toEqual(["k6"])
  expect(loadConfig.files).toEqual(["k6-http.ts"])
  expect(e2eConfig.exclude).toContain("load/k6-http.ts")
  expect(workload).toContain('executor: "constant-arrival-rate"')
  expect(workload).toContain("__ENV.GO_LIKE_SOAK_DURATION")
  expect(workload).toContain("__ENV.GO_LIKE_SOAK_RATE")
  expect(workload).toContain('checks: ["rate==1"]')
  expect(workload).toContain('"status is 200"')
  expect(workload).toContain('"body is go-like"')
  expect(webHost).not.toContain("catch(() => {})")
})

test("k6 uses the fixed image and direct TypeScript workload argv", () => {
  expect(K6Image).toBe(
    "grafana/k6:2.1.0@sha256:65c920dc067d5e2e00befbf982af6ad6ad0117034e8b1c65817c7975c52d4669"
  )
  expect(K6Workload).toBe("/scripts/k6-http.ts")
  expect(k6VersionCommand("owner")).toEqual([
    "docker",
    "run",
    "--rm",
    "--label",
    "io.go-like.e2e.owner=owner",
    K6Image,
    "version"
  ])
  expect(k6RunCommand("/repo", "owner", "container", 10_000, "31000", "/stage")).toEqual([
    "docker",
    "run",
    "--rm",
    "--name",
    "container",
    "--label",
    "io.go-like.e2e.owner=owner",
    "--add-host",
    "host.docker.internal:host-gateway",
    "--env",
    "GO_LIKE_SOAK_DURATION=10000ms",
    "--env",
    "GO_LIKE_SOAK_URL=http://host.docker.internal:31000/",
    "--volume",
    "/repo/e2e/load/k6-http.ts:/scripts/k6-http.ts:ro",
    "--volume",
    "/stage:/results",
    K6Image,
    "run",
    "--quiet",
    "--summary-export=/results/k6-summary.json",
    "/scripts/k6-http.ts"
  ])
})

test("k6 version preflight is exact and rejects drift before another command", async () => {
  expect(parseK6Version("k6 v2.1.0 (commit/example, go1.26.4, linux/arm64)\n")).toBe(K6Version)
  expect(() => parseK6Version("k6 v2.1.1")).toThrow("expected k6 2.1.0")
  expect(() => parseK6Version("prefix k6 v2.1.0")).toThrow("cannot parse k6 version")

  const commands: string[][] = []
  const runner: typeof runCommand = async (_root, definition) => {
    commands.push([...definition.command])
    return commandResult("k6 v9.9.9\n")
  }
  await expect(preflightK6("owner", new AbortController().signal, runner)).rejects.toThrow(
    "expected k6 2.1.0"
  )
  expect(commands).toEqual([[...k6VersionCommand("owner")]])
})

test("k6 command failures are bounded, redacted, and include process cleanup", () => {
  const canary = "soak-canary-secret"
  let failure: unknown = null
  try {
    checked(
      commandResult("", {
        exitCode: 17,
        stderr: `failed ${canary}`,
        cleanupFailures: [
          {
            code: "process-cleanup-failed",
            category: "process-cleanup",
            summary: `cleanup ${canary}`
          }
        ]
      }),
      "k6 short lifecycle",
      [canary]
    )
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(Error)
  expect((failure as Error).message).not.toContain(canary)
  expect((failure as Error).message).toContain("<redacted>")
  expect(() =>
    checked(commandResult("", { exitCode: null, termination: "timeout", timedOut: true }), "k6")
  ).toThrow("termination=timeout")
})

test.each([
  ["nonzero", { exitCode: 17 }],
  ["timeout", { exitCode: null, termination: "timeout" as const, timedOut: true }],
  ["abort", { exitCode: null, termination: "abort" as const, abortReason: "aborted" }],
  [
    "drain failure",
    {
      cleanupFailures: [
        {
          code: "stream-drain-failed",
          category: "stream-drain" as const,
          summary: "stream drain failed"
        }
      ]
    }
  ]
] as const)("k6 %s is never accepted as a successful lifecycle", (_label, overrides) => {
  expect(() => checked(commandResult("", overrides), "k6")).toThrow()
})

type CleanupActionName = keyof SoakCleanupActions

const CleanupLabels: Readonly<Record<CleanupActionName, string>> = Object.freeze({
  probeStop: "client probe stop",
  probeWait: "client probe wait",
  samplerStop: "resource sampler stop",
  samplerWait: "resource sampler wait",
  client: "client cleanup",
  webRelease: "Node Web host release",
  webStop: "Node Web host stop",
  webResult: "Node Web host terminal wait",
  webTerminate: "Node Web host force terminate",
  webTerminateWait: "Node Web host force termination wait",
  docker: "Docker owner cleanup",
  temp: "soak stage cleanup",
  listeners: "signal listener cleanup",
  observer: "unhandled rejection observer cleanup"
})

const GracefulOrder: readonly CleanupActionName[] = Object.freeze([
  "probeStop",
  "probeWait",
  "samplerStop",
  "samplerWait",
  "client",
  "webRelease",
  "webStop",
  "webResult",
  "docker",
  "temp",
  "listeners",
  "observer"
])

function cleanupActions(
  events: CleanupActionName[],
  failure: CleanupActionName | null,
  canary: string,
  graceful = true,
  reject = false
): SoakCleanupActions {
  const action =
    (name: CleanupActionName): (() => void | Promise<void>) =>
    () => {
      events.push(name)
      if (name !== failure) return
      const error = new Error(`${name} token=${canary}`)
      if (reject) return Promise.reject(error)
      throw error
    }
  return Object.freeze({
    probeStop: action("probeStop"),
    probeWait: action("probeWait"),
    samplerStop: action("samplerStop"),
    samplerWait: action("samplerWait"),
    client: action("client"),
    webRelease: graceful ? action("webRelease") : null,
    webStop: graceful ? action("webStop") : null,
    webResult: graceful ? action("webResult") : null,
    webTerminate: action("webTerminate"),
    webTerminateWait: action("webTerminateWait"),
    docker: action("docker"),
    temp: action("temp"),
    listeners: action("listeners"),
    observer: action("observer")
  })
}

test.each(Object.keys(CleanupLabels) as CleanupActionName[])(
  "%s cleanup failure is ordered, aggregated, sanitized, and does not skip later cleanup",
  async (failedAction) => {
    const canary = `soak-cleanup-${failedAction}`
    const events: CleanupActionName[] = []
    const fallback = failedAction === "webTerminate" || failedAction === "webTerminateWait"
    const failures = await collectSoakCleanupFailures(
      cleanupActions(events, failedAction, canary, !fallback)
    )
    expect(failures.map((failure) => failure.label)).toContain(CleanupLabels[failedAction])
    expect(events.at(-2)).toBe("listeners")
    expect(events.at(-1)).toBe("observer")
    if (["webRelease", "webStop", "webResult"].includes(failedAction)) {
      expect(events).toContain("webTerminate")
      expect(events).toContain("webTerminateWait")
    }

    expect(() => finalizeWithCleanup(null, failures, "short lifecycle")).toThrow()
    const primary = new Error("primary")
    let aggregate: unknown = null
    try {
      finalizeWithCleanup(primary, failures, "short lifecycle")
    } catch (error) {
      aggregate = error
    }
    expect(aggregate).toBeInstanceOf(AggregateError)
    expect((aggregate as AggregateError).errors).toEqual([
      primary,
      ...failures.map((failure) => failure.error)
    ])
    expect(errorSummary(aggregate, { knownSecrets: [canary] })).not.toContain(canary)
  }
)

test.each(
  ["probeWait", "samplerWait", "webResult", "webTerminateWait"].flatMap((action) => [
    [action, "timeout", false],
    [action, "rejection", true]
  ])
)("%s cleanup %s is collected", async (selected, mode, reject) => {
  const failedAction = selected as CleanupActionName
  const events: CleanupActionName[] = []
  const fallback = failedAction === "webTerminateWait"
  const failures = await collectSoakCleanupFailures(
    cleanupActions(events, failedAction, `${mode} exceeded`, !fallback, Boolean(reject))
  )
  expect(failures.map((failure) => failure.label)).toContain(CleanupLabels[failedAction])
  expect(events.at(-1)).toBe("observer")
})

test("successful graceful web cleanup skips fallback termination", async () => {
  const events: CleanupActionName[] = []
  const failures = await collectSoakCleanupFailures(cleanupActions(events, null, "unused"))
  expect(failures).toEqual([])
  expect(events).toEqual([...GracefulOrder])
})

test.each([
  "container removal",
  "owner verification",
  "residual container",
  "residual network",
  "residual volume"
])("Docker %s failure remains a cleanup failure", async (kind) => {
  const events: CleanupActionName[] = []
  const failures = await collectSoakCleanupFailures(cleanupActions(events, "docker", String(kind)))
  expect(failures.map((failure) => failure.label)).toContain("Docker owner cleanup")
  expect(events.at(-1)).toBe("observer")
})

test.each([
  "k6 log write",
  "runtime artifact write",
  "k6 summary artifact write",
  "result JSON write",
  "result JSON parse",
  "result threshold evaluation",
  "port rebind"
])("%s primary failure retains first position while cleanup continues", async (label) => {
  const events: CleanupActionName[] = []
  const failures = await collectSoakCleanupFailures(
    cleanupActions(events, "temp", "cleanup-canary")
  )
  const primary = new Error(label)
  let aggregate: unknown = null
  try {
    finalizeWithCleanup(primary, failures, "short lifecycle")
  } catch (error) {
    aggregate = error
  }
  expect(aggregate).toBeInstanceOf(AggregateError)
  expect((aggregate as AggregateError).errors[0]).toBe(primary)
  expect(events.at(-1)).toBe("observer")
})

test("k6 summary rejects missing and invalid metrics", async () => {
  const directory = await createTempDirectory("go-like-soak-test-")
  try {
    await expect(loadMetrics(join(directory.path, "missing.json"))).rejects.toThrow()
    const invalid = join(directory.path, "invalid.json")
    await Bun.write(invalid, "not json")
    await expect(loadMetrics(invalid)).rejects.toThrow()
    const incomplete = join(directory.path, "incomplete.json")
    await Bun.write(incomplete, "{}")
    await expect(loadMetrics(incomplete)).rejects.toThrow("metrics.http_reqs.count")
  } finally {
    await removeTempDirectory(directory)
  }
})
