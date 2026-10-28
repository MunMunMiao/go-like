import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { resolve } from "node:path"

import {
  digestDockerEnvironment,
  snapshotDockerEnvironment
} from "../e2e/harness/docker-environment"
import {
  assertInvocationRootIdentity,
  canonicalJson,
  createGracefulControl,
  createProtocolReplayGuard,
  createRegistrationAck,
  currentPrincipal,
  currentProcessIdentity,
  digestInvocationCapability,
  digestInvocationNonce,
  ExampleProtocolLimits,
  generateChildOwner,
  generateGracefulToken,
  generateInvocationNonce,
  generateRegistrationAckToken,
  parseExampleParticipant,
  parseExampleResult,
  parseInvocationCapability,
  parseRegistrationAck,
  parseResourceEvent,
  parseTerminalWorkerFrame,
  readProcessIdentity,
  type AuthenticatedControlBinding,
  type InvocationCapability,
  validateAbsoluteProtocolPath,
  validateChildOwner,
  validateExampleId,
  validateInvocation,
  validateRequestId,
  verifyGracefulControl,
  verifyGracefulToken,
  verifyInvocationNonce,
  verifyRegistrationAck,
  verifyRegistrationAckToken
} from "../e2e/harness/example-protocol"

const Root = resolve(import.meta.dir, "..")
const ExampleCwd = resolve(Root, "examples/vanilla-web")
const ResultDirectory = resolve(Root, ".artifacts/protocol-results")
const CapabilityPath = resolve(ResultDirectory, "capability.json")
const FixedNonce = "00".repeat(32)
const WrongNonce = "01".repeat(32)

function capability(
  overrides: Partial<InvocationCapability> = Object.freeze({})
): InvocationCapability {
  return {
    schemaVersion: 1,
    invocation: "invocation-1",
    nonceDigest: digestInvocationNonce(FixedNonce),
    rootPid: process.pid,
    rootStartIdentity: "darwin:fixture",
    rootPrincipal: currentPrincipal(),
    resultDirRealpath: ResultDirectory,
    dockerEnvironmentDigest: digestDockerEnvironment(snapshotDockerEnvironment()),
    resourceEventTestHook: "none",
    dockerDiagnosticsPolicy: "metadata-only",
    allowedExamples: [
      {
        id: "vanilla-web",
        packageName: "@go-like/example-vanilla-web",
        cwdRealpath: ExampleCwd,
        childOwner: "vanilla-web-owner-1"
      }
    ],
    ...overrides
  }
}

function binding(
  overrides: Partial<AuthenticatedControlBinding> = Object.freeze({})
): AuthenticatedControlBinding {
  const selectedCapability = capability()
  return {
    invocation: selectedCapability.invocation,
    capabilityDigest: digestInvocationCapability(selectedCapability),
    id: "vanilla-web",
    workerPid: process.pid,
    workerStartIdentity: "darwin:worker-1",
    childOwner: "vanilla-web-owner-1",
    requestId: "request-1",
    ...overrides
  }
}

function participant(overrides: Readonly<Record<string, unknown>> = Object.freeze({})) {
  return {
    schemaVersion: 1,
    id: "vanilla-web",
    packageName: "@go-like/example-vanilla-web",
    cwdRealpath: ExampleCwd,
    workerPid: process.pid,
    workerStartIdentity: "darwin:worker-1",
    childOwner: "vanilla-web-owner-1",
    parentInvocation: "invocation-1",
    startedAt: "2026-07-31T05:00:00.000Z",
    ...overrides
  }
}

function result(overrides: Readonly<Record<string, unknown>> = Object.freeze({})) {
  return {
    schemaVersion: 1,
    id: "vanilla-web",
    durationMs: 42,
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    abortReason: null,
    cleanupFailures: [],
    childOwner: "vanilla-web-owner-1",
    status: "passed",
    ...overrides
  }
}

function resourceEvent(overrides: Readonly<Record<string, unknown>> = Object.freeze({})) {
  return {
    schemaVersion: 1,
    id: "vanilla-web",
    resourceType: "container",
    resourceId: "sha256:abc123",
    invocation: "invocation-1",
    childOwner: "vanilla-web-owner-1",
    createdAt: "2026-07-31T05:00:01.000Z",
    ...overrides
  }
}

function errorMessage(action: () => unknown): string {
  try {
    action()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error("expected action to fail")
}

function asynchronousErrorMessage(action: () => Promise<unknown>): Promise<string> {
  return action().then(
    () => {
      throw new Error("expected action to fail")
    },
    (error: unknown) => (error instanceof Error ? error.message : String(error))
  )
}

test("canonical JSON and SHA-256 digests are stable across object insertion order", () => {
  const left = {
    z: [{ c: true, a: "value" }],
    a: { y: 2, x: 1 },
    number: -0
  }
  const right = {
    number: -0,
    a: { x: 1, y: 2 },
    z: [{ a: "value", c: true }]
  }
  expect(canonicalJson(left)).toBe(canonicalJson(right))
  expect(canonicalJson(left)).toBe('{"a":{"x":1,"y":2},"number":0,"z":[{"a":"value","c":true}]}')
  expect(() => canonicalJson({ value: Number.NaN })).toThrow("numbers must be finite")
  const augmentedArray = ["value"]
  Object.defineProperty(augmentedArray, "hidden", { value: true })
  expect(() => canonicalJson(augmentedArray)).toThrow("additional fields")

  const first = capability()
  const reordered = {
    allowedExamples: [
      {
        childOwner: first.allowedExamples[0]?.childOwner,
        cwdRealpath: first.allowedExamples[0]?.cwdRealpath,
        packageName: first.allowedExamples[0]?.packageName,
        id: first.allowedExamples[0]?.id
      }
    ],
    resultDirRealpath: first.resultDirRealpath,
    dockerEnvironmentDigest: first.dockerEnvironmentDigest,
    rootPrincipal: first.rootPrincipal,
    rootStartIdentity: first.rootStartIdentity,
    rootPid: first.rootPid,
    resourceEventTestHook: first.resourceEventTestHook,
    dockerDiagnosticsPolicy: first.dockerDiagnosticsPolicy,
    nonceDigest: first.nonceDigest,
    invocation: first.invocation,
    schemaVersion: first.schemaVersion
  }
  const digest = digestInvocationCapability(first)
  expect(digestInvocationCapability(reordered)).toBe(digest)
  expect(digest).toBe(
    createHash("sha256")
      .update(canonicalJson(parseInvocationCapability(first)))
      .digest("hex")
  )
  expect(digestInvocationNonce(FixedNonce)).toBe(
    createHash("sha256").update(Buffer.from(FixedNonce, "hex")).digest("hex")
  )
  expect(verifyInvocationNonce(FixedNonce, first.nonceDigest)).toBe(true)
  expect(verifyInvocationNonce(WrongNonce, first.nonceDigest)).toBe(false)
  expect(verifyInvocationNonce("not-a-nonce", first.nonceDigest)).toBe(false)
})

test("ACK and graceful MACs are domain-separated and bound to every worker claim", () => {
  const expected = binding()
  const ackToken = generateRegistrationAckToken(FixedNonce, expected)
  const gracefulToken = generateGracefulToken(FixedNonce, expected)
  expect(ackToken).toMatch(/^[a-f0-9]{64}$/)
  expect(gracefulToken).toMatch(/^[a-f0-9]{64}$/)
  expect(ackToken).not.toBe(gracefulToken)
  expect(verifyRegistrationAckToken(FixedNonce, ackToken, expected)).toBe(true)
  expect(verifyRegistrationAckToken("not-a-nonce", ackToken, expected)).toBe(false)
  expect(verifyRegistrationAckToken(WrongNonce, ackToken, expected)).toBe(false)
  expect(verifyRegistrationAckToken(FixedNonce, gracefulToken, expected)).toBe(false)
  expect(verifyGracefulToken(FixedNonce, gracefulToken, expected)).toBe(true)
  expect(verifyGracefulToken(FixedNonce, ackToken, expected)).toBe(false)

  const mutations: readonly Partial<AuthenticatedControlBinding>[] = [
    { invocation: "invocation-2" },
    { capabilityDigest: "ff".repeat(32) },
    { id: "hono" },
    { workerPid: process.pid + 1 },
    { workerStartIdentity: "darwin:worker-2" },
    { childOwner: "vanilla-web-owner-2" },
    { requestId: "request-2" }
  ]
  for (const mutation of mutations) {
    const changed = binding(mutation)
    expect(verifyRegistrationAckToken(FixedNonce, ackToken, changed)).toBe(false)
    expect(verifyGracefulToken(FixedNonce, gracefulToken, changed)).toBe(false)
  }
})

test("authenticated controls reject wrong tokens, binding mismatch, and replay", () => {
  const expected = binding()
  const ack = createRegistrationAck(FixedNonce, expected)
  const graceful = createGracefulControl(FixedNonce, expected)
  expect(parseRegistrationAck(ack)).toEqual(ack)

  const ackGuard = createProtocolReplayGuard()
  expect(verifyRegistrationAck(ack, FixedNonce, expected, ackGuard)).toEqual(ack)
  expect(() => verifyRegistrationAck(ack, FixedNonce, expected, ackGuard)).toThrow("replay")

  const gracefulGuard = createProtocolReplayGuard()
  expect(verifyGracefulControl(graceful, FixedNonce, expected, gracefulGuard)).toEqual(graceful)
  expect(() => verifyGracefulControl(graceful, FixedNonce, expected, gracefulGuard)).toThrow(
    "replay"
  )

  const wrongAck = { ...ack, ackToken: "ff".repeat(32) }
  const wrongGraceful = { ...graceful, gracefulToken: "ff".repeat(32) }
  const canaryNonce = "ab".repeat(32)
  const canaryToken = "cd".repeat(32)
  const ackFailure = errorMessage(() =>
    verifyRegistrationAck(wrongAck, canaryNonce, expected, createProtocolReplayGuard())
  )
  const gracefulFailure = errorMessage(() =>
    verifyGracefulControl(
      { ...wrongGraceful, gracefulToken: canaryToken },
      canaryNonce,
      expected,
      createProtocolReplayGuard()
    )
  )
  expect(ackFailure).toBe("registration ACK authentication failed")
  expect(gracefulFailure).toBe("graceful control authentication failed")
  expect(`${ackFailure}${gracefulFailure}`).not.toContain(canaryNonce)
  expect(`${ackFailure}${gracefulFailure}`).not.toContain(canaryToken)

  expect(() =>
    verifyRegistrationAck(
      { ...ack, requestId: "request-2" },
      FixedNonce,
      expected,
      createProtocolReplayGuard()
    )
  ).toThrow("authentication failed")
  expect(() =>
    verifyGracefulControl(
      graceful,
      FixedNonce,
      binding({ childOwner: "vanilla-web-owner-2" }),
      createProtocolReplayGuard()
    )
  ).toThrow("authentication failed")
})

test("strict validators reject unknown fields, traversal identities, and array bounds", () => {
  expect(Object.isFrozen(parseInvocationCapability(capability()))).toBe(true)
  expect(Object.isFrozen(parseExampleParticipant(participant()))).toBe(true)
  expect(Object.isFrozen(parseExampleResult(result()))).toBe(true)
  expect(Object.isFrozen(parseResourceEvent(resourceEvent()))).toBe(true)

  expect(() => parseInvocationCapability({ ...capability(), unknown: true })).toThrow(
    "exactly the protocol fields"
  )
  expect(() =>
    parseInvocationCapability(capability({ resourceEventTestHook: "ambient" as never }))
  ).toThrow("resource event test hook")
  expect(() =>
    parseInvocationCapability(capability({ dockerDiagnosticsPolicy: "raw-logs" as never }))
  ).toThrow("Docker diagnostics policy")
  const augmentedAllowedExamples = capability().allowedExamples.slice()
  Object.defineProperty(augmentedAllowedExamples, "hidden", { value: true })
  expect(() =>
    parseInvocationCapability(capability({ allowedExamples: augmentedAllowedExamples }))
  ).toThrow("additional fields")
  expect(() => parseExampleParticipant(participant({ argv: ["secret"] }))).toThrow(
    "exactly the protocol fields"
  )
  expect(() => parseExampleResult(result({ stack: "raw stack" }))).toThrow(
    "exactly the protocol fields"
  )
  expect(() => parseResourceEvent(resourceEvent({ labels: { secret: "value" } }))).toThrow(
    "exactly the protocol fields"
  )
  expect(() =>
    parseRegistrationAck({ ...createRegistrationAck(FixedNonce, binding()), nonce: FixedNonce })
  ).toThrow("exactly the protocol fields")

  expect(() => validateExampleId("../vanilla-web")).toThrow("invalid syntax")
  expect(() => validateExampleId("vanilla_web")).toThrow("invalid syntax")
  expect(() => validateInvocation("../invocation")).toThrow("invalid syntax")
  expect(() => validateChildOwner("owner/child")).toThrow("invalid syntax")
  expect(() => validateRequestId("request/1")).toThrow("invalid syntax")
  expect(() => validateAbsoluteProtocolPath("relative/capability.json")).toThrow(
    "normalized and absolute"
  )
  expect(() => validateAbsoluteProtocolPath(`${Root}/tmp/../capability.json`)).toThrow(
    "normalized and absolute"
  )

  const tooManyEntries = Array.from(
    { length: ExampleProtocolLimits.maximumAllowedExamples + 1 },
    (_, index) => ({
      id: `example-${index}`,
      packageName: `@go-like/example-${index}`,
      cwdRealpath: resolve(Root, `examples/example-${index}`),
      childOwner: `example-${index}-owner`
    })
  )
  expect(() => parseInvocationCapability(capability({ allowedExamples: tooManyEntries }))).toThrow(
    "array bounds"
  )
  const duplicate = capability().allowedExamples[0]
  if (duplicate === undefined) throw new Error("capability fixture has no allowed example")
  expect(() =>
    parseInvocationCapability(capability({ allowedExamples: [duplicate, duplicate] }))
  ).toThrow("duplicate allowed identity")

  const tooManyFailures = Array.from(
    { length: ExampleProtocolLimits.maximumCleanupFailures + 1 },
    () => ({ code: "cleanup-failed", category: "filesystem", summary: "sanitized" })
  )
  expect(() => parseExampleResult(result({ cleanupFailures: tooManyFailures }))).toThrow(
    "array bounds"
  )
  expect(() =>
    parseExampleResult(
      result({
        status: "failed",
        exitCode: 1,
        cleanupFailures: [
          {
            code: "cleanup-failed",
            category: "filesystem",
            summary: "sanitized",
            cause: "raw"
          }
        ]
      })
    )
  ).toThrow("exactly the protocol fields")
  expect(() => parseExampleResult(result({ status: "timed-out" }))).toThrow(
    "status and termination flags disagree"
  )
})

test("process identity reports the current principal and dead roots fail closed", async () => {
  if (process.platform !== "darwin" && process.platform !== "linux") return
  const current = await currentProcessIdentity()
  expect(current.pid).toBe(process.pid)
  expect(current.startIdentity.length).toBeGreaterThan(0)
  if (process.platform === "darwin") {
    expect(current.startIdentity).toMatch(/^darwin:[1-9][0-9]{6,}$/u)
  }
  expect(current.principal).toBe(currentPrincipal())
  expect(await readProcessIdentity(process.pid)).toEqual(current)

  const liveCapability = capability({
    rootPid: current.pid,
    rootStartIdentity: current.startIdentity,
    rootPrincipal: current.principal
  })
  expect(await assertInvocationRootIdentity(liveCapability)).toEqual(current)
  await expect(
    assertInvocationRootIdentity({ ...liveCapability, rootStartIdentity: "darwin:wrong" })
  ).rejects.toThrow("unavailable or changed")

  const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
    stdout: "ignore",
    stderr: "ignore"
  })
  const deadPid = child.pid
  await child.exited
  await expect(readProcessIdentity(deadPid)).rejects.toThrow("process identity is unavailable")
  const deadFailure = await asynchronousErrorMessage(() =>
    assertInvocationRootIdentity({ ...liveCapability, rootPid: deadPid })
  )
  expect(deadFailure).toBe("invocation root process identity is unavailable or changed")
  expect(deadFailure).not.toContain(String(deadPid))
})

test("terminal worker frame ignores ambient state and preserves non-empty scenario argv", () => {
  const previousCapability = process.env.GO_LIKE_E2E_CAPABILITY
  const previousNonce = process.env.GO_LIKE_E2E_NONCE
  process.env.GO_LIKE_E2E_CAPABILITY = "/stale/capability.json"
  process.env.GO_LIKE_E2E_NONCE = WrongNonce
  try {
    expect(parseTerminalWorkerFrame(["bun", "scenario.ts", "--flag", "value"])).toEqual({
      mode: "direct",
      scenarioArgv: ["bun", "scenario.ts", "--flag", "value"]
    })
    expect(parseTerminalWorkerFrame(["bun", "scenario.ts", "--worker-extra"])).toEqual({
      mode: "direct",
      scenarioArgv: ["bun", "scenario.ts", "--worker-extra"]
    })
    expect(
      parseTerminalWorkerFrame([
        "bun",
        "scenario.ts",
        "--flag",
        "value",
        "--worker",
        CapabilityPath,
        FixedNonce
      ])
    ).toEqual({
      mode: "worker",
      scenarioArgv: ["bun", "scenario.ts", "--flag", "value"],
      capabilityPath: CapabilityPath,
      nonce: FixedNonce
    })
  } finally {
    if (previousCapability === undefined) delete process.env.GO_LIKE_E2E_CAPABILITY
    else process.env.GO_LIKE_E2E_CAPABILITY = previousCapability
    if (previousNonce === undefined) delete process.env.GO_LIKE_E2E_NONCE
    else process.env.GO_LIKE_E2E_NONCE = previousNonce
  }
})

test("terminal worker frame fails closed for partial, duplicate, or misplaced markers", () => {
  const invalidFrames: readonly (readonly string[])[] = [
    [],
    ["bun", "scenario.ts", "--worker"],
    ["bun", "scenario.ts", "--worker", CapabilityPath],
    ["bun", "--worker", CapabilityPath, FixedNonce, "scenario.ts"],
    ["bun", "scenario.ts", "--worker", CapabilityPath, FixedNonce, "extra"],
    [
      "bun",
      "scenario.ts",
      "--worker",
      CapabilityPath,
      FixedNonce,
      "--worker",
      CapabilityPath,
      FixedNonce
    ],
    ["--worker", CapabilityPath, FixedNonce],
    ["bun", "scenario.ts", "--worker", "relative.json", FixedNonce],
    ["bun", "scenario.ts", "--worker", CapabilityPath, "00"]
  ]
  for (const frame of invalidFrames) expect(() => parseTerminalWorkerFrame(frame)).toThrow()
})

test("nonce and owner generation remain strict and cryptographically sized", () => {
  const firstNonce = generateInvocationNonce()
  const secondNonce = generateInvocationNonce()
  expect(firstNonce).toMatch(/^[a-f0-9]{64}$/)
  expect(secondNonce).toMatch(/^[a-f0-9]{64}$/)
  expect(firstNonce).not.toBe(secondNonce)
  const firstOwner = generateChildOwner("vanilla-web")
  const secondOwner = generateChildOwner("vanilla-web")
  expect(firstOwner).toMatch(/^vanilla-web-[a-f0-9]{32}$/)
  expect(secondOwner).not.toBe(firstOwner)
})
