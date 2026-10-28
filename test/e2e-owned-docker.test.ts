import { expect, test } from "bun:test"
import { chmod, mkdir, readdir, rename, rmdir, symlink, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { digestDockerEnvironment } from "../e2e/harness/docker-environment"
import { DockerInvocationLabelKey, DockerOwnerLabelKey } from "../e2e/harness/docker-pairs"
import {
  createRegistrationAck,
  digestInvocationCapability,
  digestInvocationNonce,
  type AuthenticatedControlBinding,
  type InvocationCapability,
  type ProcessIdentity,
  type ResourceEvent
} from "../e2e/harness/example-protocol"
import {
  authorityToEnvironment,
  closeOwnedDockerContext,
  createContainer,
  createNetwork,
  createOwnedDockerContext,
  createVolume,
  ownedDockerContextFromEnvironment,
  OwnedDockerEnvironmentKey,
  readContainerLogs,
  OwnedDockerEnvironmentKeys,
  type OwnedDockerContext,
  type OwnedDockerDependencies,
  type ScenarioDockerAuthority
} from "../e2e/harness/owned-docker"
import type { CommandDefinition, CommandResult, ProcessSupervisor } from "../e2e/harness/process"
import {
  createTempDirectory,
  createTempSubdirectories,
  removeTempDirectory,
  type TempDirectory
} from "../e2e/harness/temp"

const Nonce = "12".repeat(32)
const ContainerId = "a".repeat(64)
const NetworkId = "b".repeat(64)
const Invocation = "invocation-owned-docker"
const Owner = "example-owned-docker-owner"
const ExampleId = "owned-docker-example"
const PackageName = "@go-like/example-owned-docker"
const WorkerPid = 4_242
const RootPid = 4_141
const RootStartIdentity = "synthetic:root:1"
const WorkerStartIdentity = "synthetic:worker:1"
const ScenarioStartIdentity = "synthetic:scenario:1"
const Principal = "uid:501"
const RequestId = "registration-ack-1"
const Timestamp = "2026-07-31T05:00:00.000Z"
const Posix = process.platform !== "win32"

type Runner = ProcessSupervisor["run"]

interface Fixture {
  readonly temp: TempDirectory
  readonly resultPath: string
  readonly eventPath: string
  readonly capabilityPath: string
  readonly capability: InvocationCapability
  readonly authority: ScenarioDockerAuthority
  readonly calls: CommandDefinition[]
  readonly identities: Map<number, ProcessIdentity>
  readonly identityReader: NonNullable<OwnedDockerDependencies["identityReader"]>
}

function result(stdout = "", overrides: Partial<CommandResult> = {}): CommandResult {
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

function identity(pid: number, startIdentity: string, principal = Principal): ProcessIdentity {
  return Object.freeze({ pid, ppid: 1, pgid: pid, startIdentity, principal })
}

function binding(capability: InvocationCapability): AuthenticatedControlBinding {
  return {
    invocation: capability.invocation,
    capabilityDigest: digestInvocationCapability(capability),
    id: ExampleId,
    workerPid: WorkerPid,
    workerStartIdentity: WorkerStartIdentity,
    childOwner: Owner,
    requestId: RequestId
  }
}

function capability(resultPath: string): InvocationCapability {
  return {
    schemaVersion: 1,
    invocation: Invocation,
    nonceDigest: digestInvocationNonce(Nonce),
    rootPid: RootPid,
    rootStartIdentity: RootStartIdentity,
    rootPrincipal: Principal,
    resultDirRealpath: resultPath,
    dockerEnvironmentDigest: digestDockerEnvironment(Object.freeze({})),
    resourceEventTestHook: "none",
    dockerDiagnosticsPolicy: "metadata-only",
    allowedExamples: [
      {
        id: ExampleId,
        packageName: PackageName,
        cwdRealpath: resultPath,
        childOwner: Owner
      }
    ]
  }
}

function authority(
  capabilityPath: string,
  capability: InvocationCapability,
  overrides: Partial<ScenarioDockerAuthority> = {}
): ScenarioDockerAuthority {
  const selectedBinding = binding(capability)
  return {
    schemaVersion: 1,
    capabilityPath,
    capabilityDigest: selectedBinding.capabilityDigest,
    workerPid: WorkerPid,
    workerStartIdentity: WorkerStartIdentity,
    registrationAck: createRegistrationAck(Nonce, selectedBinding),
    ...overrides
  }
}

async function fixture(): Promise<Fixture> {
  const temp = await createTempDirectory("go-like-owned-docker-")
  const created = await createTempSubdirectories(temp, [
    ["result"],
    ["result", "participants"],
    ["result", "registrations"],
    ["result", "acks"],
    ["result", "results"],
    ["result", "graceful"],
    ["result", "resources"]
  ])
  const [resultPath, , registrationsPath, acksPath, , , eventPath] = created
  if (
    resultPath === undefined ||
    registrationsPath === undefined ||
    acksPath === undefined ||
    eventPath === undefined
  ) {
    throw new Error("Owned Docker fixture paths were not created")
  }
  const selectedCapability = capability(resultPath)
  const capabilityPath = join(resultPath, "capability.json")
  const selectedBinding = binding(selectedCapability)
  const selectedAck = createRegistrationAck(Nonce, selectedBinding)
  await Promise.all([
    writeFile(capabilityPath, `${JSON.stringify(selectedCapability)}\n`, { mode: 0o400 }),
    writeFile(join(resultPath, "docker-environment.json"), "{}\n", { mode: 0o400 }),
    writeFile(
      join(registrationsPath, `registered-${ExampleId}.json`),
      `${JSON.stringify({
        schemaVersion: 1,
        invocation: Invocation,
        capabilityDigest: selectedBinding.capabilityDigest,
        id: ExampleId,
        packageName: PackageName,
        cwdRealpath: resultPath,
        workerPid: WorkerPid,
        workerStartIdentity: WorkerStartIdentity,
        childOwner: Owner,
        requestId: RequestId,
        registeredAt: Timestamp
      })}\n`,
      { mode: 0o400 }
    ),
    writeFile(join(acksPath, `${ExampleId}.json`), `${JSON.stringify(selectedAck)}\n`, {
      mode: 0o400
    })
  ])
  const calls: CommandDefinition[] = []
  const identities = new Map<number, ProcessIdentity>([
    [RootPid, identity(RootPid, RootStartIdentity)],
    [WorkerPid, identity(WorkerPid, WorkerStartIdentity)],
    [process.pid, identity(process.pid, ScenarioStartIdentity)]
  ])
  const identityReader = async (pid: number): Promise<ProcessIdentity> => {
    const selected = identities.get(pid)
    if (selected === undefined) throw new Error("synthetic process is dead")
    return selected
  }
  return Object.freeze({
    temp,
    resultPath,
    eventPath,
    capabilityPath,
    capability: selectedCapability,
    authority: authority(capabilityPath, selectedCapability),
    calls,
    identities,
    identityReader
  })
}

async function cleanupFixture(
  selected: Fixture,
  context: OwnedDockerContext | null
): Promise<void> {
  if (context !== null) await closeOwnedDockerContext(context).catch(() => {})
  await removeTempDirectory(selected.temp)
}

async function context(
  selected: Fixture,
  runner: Runner,
  dependencies: Omit<OwnedDockerDependencies, "runner" | "identityReader"> = {}
): Promise<OwnedDockerContext> {
  return await createOwnedDockerContext(selected.authority, {
    runner,
    identityReader: selected.identityReader,
    now: () => new Date(Timestamp),
    ...dependencies
  })
}

function recordingRunner(
  selected: Fixture,
  output: (definition: CommandDefinition) => CommandResult = (definition) => {
    if (definition.command[1] === "network") return result(`${NetworkId}\n`)
    if (definition.command[1] === "volume") {
      return definition.command.includes("ls") ? result("") : result("safe-volume\n")
    }
    return result(`${ContainerId}\n`)
  }
): Runner {
  return async (_root, definition) => {
    selected.calls.push(definition)
    return output(definition)
  }
}

function labelArguments(): readonly string[] {
  return [
    "--label",
    `${DockerOwnerLabelKey}=${Owner}`,
    "--label",
    `${DockerInvocationLabelKey}=${Invocation}`
  ]
}

function eventFiles(selected: Fixture): Promise<string[]> {
  return readdir(selected.eventPath)
}

async function events(selected: Fixture): Promise<ResourceEvent[]> {
  const files = (await eventFiles(selected)).sort()
  return await Promise.all(
    files.map(
      async (file) => (await Bun.file(join(selected.eventPath, file)).json()) as ResourceEvent
    )
  )
}

async function capturedError(action: () => Promise<unknown>): Promise<Error> {
  let failure: unknown = null
  try {
    await action()
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(Error)
  return failure as Error
}

async function replaceReadonlyJson(path: string, value: unknown): Promise<void> {
  await chmod(path, 0o600)
  try {
    await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  } finally {
    await chmod(path, 0o400)
  }
}

function mutateAuthority(
  selected: Fixture,
  mutation: Partial<ScenarioDockerAuthority>
): ScenarioDockerAuthority {
  return { ...selected.authority, ...mutation }
}

function assertNoRawCommandFields(value: unknown): void {
  expect(value).toEqual({
    type: expect.any(String),
    id: expect.any(String),
    display: expect.any(String)
  })
  expect(Reflect.ownKeys(value as object).sort()).toEqual(["display", "id", "type"])
}

test("ACK authority must validate before context construction and before every create", async () => {
  if (!Posix) return
  const selected = await fixture()
  let owned: OwnedDockerContext | null = null
  try {
    let runs = 0
    const runner: Runner = async () => {
      runs += 1
      return result(`${ContainerId}\n`)
    }
    const forgedAck = {
      ...selected.authority.registrationAck,
      ackToken: "ff".repeat(32)
    }
    await expect(
      createOwnedDockerContext(mutateAuthority(selected, { registrationAck: forgedAck }), {
        runner,
        identityReader: selected.identityReader
      })
    ).rejects.toThrow("registration ACK authentication failed")
    expect(runs).toBe(0)
    expect(await eventFiles(selected)).toEqual([])

    owned = await context(selected, runner)
    selected.identities.delete(WorkerPid)
    await expect(createContainer(owned, ["image:fixed"])).rejects.toThrow(
      "worker process identity is unavailable or expired"
    )
    expect(runs).toBe(0)
  } finally {
    await cleanupFixture(selected, owned)
  }
})

test("every operation revalidates durable capability, selector, registration, and root ACK artifacts", async () => {
  if (!Posix) return
  const mutations: readonly ((selected: Fixture) => Promise<void>)[] = [
    async (selected) => {
      await replaceReadonlyJson(selected.capabilityPath, {
        ...selected.capability,
        dockerDiagnosticsPolicy: "safe-redacted-logs"
      })
    },
    async (selected) => {
      await replaceReadonlyJson(join(selected.resultPath, "docker-environment.json"), {
        DOCKER_CONTEXT: "forged-context"
      })
    },
    async (selected) => {
      const path = join(selected.resultPath, "registrations", `registered-${ExampleId}.json`)
      const registration = (await Bun.file(path).json()) as Record<string, unknown>
      await replaceReadonlyJson(path, {
        ...registration,
        registeredAt: "2026-07-31T05:00:00Z"
      })
    },
    async (selected) => {
      await replaceReadonlyJson(join(selected.resultPath, "acks", `${ExampleId}.json`), {
        ...selected.authority.registrationAck,
        ackToken: "ff".repeat(32)
      })
    }
  ]

  for (const mutate of mutations) {
    const selected = await fixture()
    let owned: OwnedDockerContext | null = null
    try {
      owned = await context(selected, recordingRunner(selected))
      await mutate(selected)
      await expect(createContainer(owned, ["image:fixed"])).rejects.toThrow()
      expect(selected.calls).toHaveLength(0)
      expect(await eventFiles(selected)).toEqual([])
    } finally {
      await cleanupFixture(selected, owned)
    }
  }
})

test("wrong nonce, digest, example, ACK binding, root, and worker identities fail closed", async () => {
  if (!Posix) return
  const selected = await fixture()
  try {
    const rejected: ScenarioDockerAuthority[] = [
      mutateAuthority(selected, { capabilityDigest: "ab".repeat(32) }),
      mutateAuthority(selected, {
        registrationAck: {
          ...selected.authority.registrationAck,
          childOwner: "foreign-owner"
        }
      }),
      mutateAuthority(selected, {
        registrationAck: {
          ...selected.authority.registrationAck,
          requestId: "wrong-request"
        }
      }),
      mutateAuthority(selected, { workerStartIdentity: "synthetic:wrong-worker" })
    ]
    let runs = 0
    const runner: Runner = async () => {
      runs += 1
      return result()
    }
    for (const candidate of rejected) {
      await expect(
        createOwnedDockerContext(candidate, {
          runner,
          identityReader: selected.identityReader
        })
      ).rejects.toThrow()
    }

    selected.identities.set(WorkerPid, identity(WorkerPid, "synthetic:reused-worker"))
    await expect(
      createOwnedDockerContext(selected.authority, {
        runner,
        identityReader: selected.identityReader
      })
    ).rejects.toThrow("worker process identity is unavailable or expired")
    expect(runs).toBe(0)
    expect(await eventFiles(selected)).toEqual([])
  } finally {
    await cleanupFixture(selected, null)
  }
})

test("environment is exact transport only and direct wrappers can clear stale authority", async () => {
  if (!Posix) return
  const selected = await fixture()
  let owned: OwnedDockerContext | null = null
  try {
    expect(OwnedDockerEnvironmentKeys).toEqual([OwnedDockerEnvironmentKey])
    const environment = authorityToEnvironment(selected.authority)
    expect(Reflect.ownKeys(environment)).toEqual([OwnedDockerEnvironmentKey])
    expect(environment[OwnedDockerEnvironmentKey]).toBeString()
    expect(authorityToEnvironment(null)).toEqual({
      [OwnedDockerEnvironmentKey]: undefined
    })

    const previous = process.env[OwnedDockerEnvironmentKey]
    process.env[OwnedDockerEnvironmentKey] = authorityToEnvironment(
      mutateAuthority(selected, { capabilityDigest: "ab".repeat(32) })
    )[OwnedDockerEnvironmentKey]
    try {
      owned = await ownedDockerContextFromEnvironment(environment, {
        runner: recordingRunner(selected),
        identityReader: selected.identityReader,
        now: () => new Date(Timestamp)
      })
      expect(Reflect.ownKeys(owned)).toEqual([])
    } finally {
      if (previous === undefined) delete process.env[OwnedDockerEnvironmentKey]
      else process.env[OwnedDockerEnvironmentKey] = previous
    }

    await expect(
      ownedDockerContextFromEnvironment(
        {
          ...environment,
          GO_LIKE_E2E_OWNED_DOCKER_STALE: "ambient"
        },
        { identityReader: selected.identityReader }
      )
    ).rejects.toThrow("unknown authority key")
    await expect(
      ownedDockerContextFromEnvironment(authorityToEnvironment(null), {
        identityReader: selected.identityReader
      })
    ).rejects.toThrow("transport is invalid")
  } finally {
    await cleanupFixture(selected, owned)
  }
})

test("container and network commands have exact mandatory labels and sanitized returns", async () => {
  if (!Posix) return
  const selected = await fixture()
  let owned: OwnedDockerContext | null = null
  try {
    owned = await context(selected, recordingRunner(selected))
    const container = await createContainer(owned, [
      "--name",
      "safe-container",
      "image@sha256:fixed"
    ])
    const network = await createNetwork(owned, ["--driver", "bridge", "safe-network"])

    expect(selected.calls.map((call) => call.command)).toEqual([
      [
        "docker",
        "run",
        "--detach",
        ...labelArguments(),
        "--name",
        "safe-container",
        "image@sha256:fixed"
      ],
      ["docker", "network", "create", ...labelArguments(), "--driver", "bridge", "safe-network"]
    ])
    expect(selected.calls.every((call) => call.cwd === ".")).toBe(true)
    expect(
      selected.calls.every((call) => call.environment?.[OwnedDockerEnvironmentKey] === undefined)
    ).toBe(true)
    expect(selected.calls.every((call) => call.knownSecrets?.includes(Nonce) === false)).toBe(true)
    expect(
      selected.calls.every(
        (call) => call.knownSecrets?.includes(selected.authority.registrationAck.ackToken) === true
      )
    ).toBe(true)
    expect(container).toEqual({
      type: "container",
      id: ContainerId,
      display: ContainerId
    })
    expect(network).toEqual({
      type: "network",
      id: NetworkId,
      display: NetworkId
    })
    assertNoRawCommandFields(container)
    assertNoRawCommandFields(network)

    expect(
      (await events(selected)).sort((left, right) =>
        left.resourceType.localeCompare(right.resourceType)
      )
    ).toEqual([
      {
        schemaVersion: 1,
        id: ExampleId,
        resourceType: "container",
        resourceId: ContainerId,
        invocation: Invocation,
        childOwner: Owner,
        createdAt: Timestamp
      },
      {
        schemaVersion: 1,
        id: ExampleId,
        resourceType: "network",
        resourceId: NetworkId,
        invocation: Invocation,
        childOwner: Owner,
        createdAt: Timestamp
      }
    ])
  } finally {
    await cleanupFixture(selected, owned)
  }
})

test("all ownership-label spellings and daemon selection are rejected before the runner", async () => {
  if (!Posix) return
  const selected = await fixture()
  let owned: OwnedDockerContext | null = null
  try {
    owned = await context(selected, recordingRunner(selected))
    const conflicts: readonly (readonly string[])[] = [
      ["--label", `${DockerOwnerLabelKey}=forged`, "image"],
      ["-l", `${DockerInvocationLabelKey}=forged`, "image"],
      [`--label=${DockerOwnerLabelKey}=forged`, "image"],
      [`-l=${DockerInvocationLabelKey}=forged`, "image"],
      [`-l${DockerOwnerLabelKey}=forged`, "image"],
      [`-itlio.go-like.e2e.owner=forged`, "image"],
      ["--label-file", "labels.txt", "image"]
    ]
    for (const arguments_ of conflicts) {
      await expect(createContainer(owned, arguments_)).rejects.toThrow(
        /ownership label|label files/u
      )
    }
    for (const arguments_ of [
      ["--filter", "name=x", "image"],
      ["--filter=name=x", "image"],
      ["-f", "name=x", "image"],
      ["--context", "foreign", "image"],
      ["--context=foreign", "image"],
      ["--host", "tcp://foreign", "image"],
      ["-Htcp://foreign", "image"]
    ]) {
      await expect(createContainer(owned, arguments_)).rejects.toThrow(
        "cannot select Docker filters, contexts, or hosts"
      )
    }
    expect(selected.calls).toHaveLength(0)
  } finally {
    await cleanupFixture(selected, owned)
  }
})

test("unsafe argv and duplicate detach are rejected before the runner", async () => {
  if (!Posix) return
  const selected = await fixture()
  let owned: OwnedDockerContext | null = null
  try {
    owned = await context(selected, recordingRunner(selected))
    for (const arguments_ of [
      ["--detach", "image"],
      ["--detach=true", "image"],
      ["-d", "image"],
      ["-di", "image"],
      ["-itd", "image"]
    ]) {
      await expect(createContainer(owned, arguments_)).rejects.toThrow(
        "detach mode is mandatory and cannot be repeated"
      )
    }
    await expect(createNetwork(owned, ["safe\0unsafe"])).rejects.toThrow("unsafe argument")
    await expect(
      createNetwork(
        owned,
        Array.from({ length: 257 }, () => "argument")
      )
    ).rejects.toThrow("outside the supported bounds")
    const augmented = ["safe-network"]
    Object.defineProperty(augmented, "hidden", { value: true })
    await expect(createNetwork(owned, augmented)).rejects.toThrow("additional fields")
    expect(selected.calls).toHaveLength(0)
  } finally {
    await cleanupFixture(selected, owned)
  }
})

test("container command arguments after the image are not mistaken for Docker detach flags", async () => {
  if (!Posix) return
  const selected = await fixture()
  let owned: OwnedDockerContext | null = null
  try {
    owned = await context(selected, recordingRunner(selected))
    const container = await createContainer(owned, [
      "image@sha256:fixed",
      "agent",
      "-dev",
      "-client=0.0.0.0"
    ])
    expect(container).toEqual({
      type: "container",
      id: ContainerId,
      display: ContainerId
    })
    expect(selected.calls.map((call) => call.command)).toEqual([
      [
        "docker",
        "run",
        "--detach",
        ...labelArguments(),
        "image@sha256:fixed",
        "agent",
        "-dev",
        "-client=0.0.0.0"
      ]
    ])
  } finally {
    await cleanupFixture(selected, owned)
  }
})

test("container logs require opt-in authority and a container created by the same context", async () => {
  if (!Posix) return
  const selected = await fixture()
  let metadataOnly: OwnedDockerContext | null = null
  let logContext: OwnedDockerContext | null = null
  try {
    metadataOnly = await context(selected, recordingRunner(selected))
    const metadataContainer = await createContainer(metadataOnly, ["image@sha256:fixed"])
    const callsBeforeMetadataLogs = selected.calls.length
    await expect(readContainerLogs(metadataOnly, metadataContainer)).rejects.toThrow(
      "require safe-redacted-logs authority"
    )
    expect(selected.calls).toHaveLength(callsBeforeMetadataLogs)
    await closeOwnedDockerContext(metadataOnly)
    metadataOnly = null

    selected.calls.length = 0
    const logCapability: InvocationCapability = {
      ...selected.capability,
      dockerDiagnosticsPolicy: "safe-redacted-logs"
    }
    await chmod(selected.capabilityPath, 0o600)
    await writeFile(selected.capabilityPath, `${JSON.stringify(logCapability)}\n`, { mode: 0o600 })
    await chmod(selected.capabilityPath, 0o400)
    const logAuthority = authority(selected.capabilityPath, logCapability)
    await chmod(join(selected.resultPath, "registrations", `registered-${ExampleId}.json`), 0o600)
    await writeFile(
      join(selected.resultPath, "registrations", `registered-${ExampleId}.json`),
      `${JSON.stringify({
        schemaVersion: 1,
        invocation: Invocation,
        capabilityDigest: logAuthority.capabilityDigest,
        id: ExampleId,
        packageName: PackageName,
        cwdRealpath: selected.resultPath,
        workerPid: WorkerPid,
        workerStartIdentity: WorkerStartIdentity,
        childOwner: Owner,
        requestId: RequestId,
        registeredAt: Timestamp
      })}\n`,
      { mode: 0o600 }
    )
    await chmod(join(selected.resultPath, "registrations", `registered-${ExampleId}.json`), 0o400)
    await chmod(join(selected.resultPath, "acks", `${ExampleId}.json`), 0o600)
    await writeFile(
      join(selected.resultPath, "acks", `${ExampleId}.json`),
      `${JSON.stringify(logAuthority.registrationAck)}\n`,
      { mode: 0o600 }
    )
    await chmod(join(selected.resultPath, "acks", `${ExampleId}.json`), 0o400)
    logContext = await createOwnedDockerContext(logAuthority, {
      runner: recordingRunner(selected, (definition) =>
        definition.command[1] === "logs"
          ? result("safe-prefix log-canary-secret safe-suffix\n")
          : result(`${ContainerId}\n`)
      ),
      identityReader: selected.identityReader,
      now: () => new Date(Timestamp)
    })
    const container = await createContainer(logContext, ["image@sha256:fixed"])
    expect(container).not.toBe(metadataContainer)
    const logs = await readContainerLogs(logContext, container, {
      maximumCharacters: 32,
      knownSecrets: ["log-canary-secret"]
    })
    expect(logs).toBe("e-prefix <redacted> safe-suffix\n")
    expect(logs).toHaveLength(32)
    expect(logs).not.toContain("log-canary-secret")
    expect(selected.calls.at(-1)?.command).toEqual(["docker", "logs", "--tail", "200", ContainerId])
    expect(selected.calls.at(-1)?.knownSecrets).toContain("log-canary-secret")

    const callsBeforeForgery = selected.calls.length
    await expect(
      readContainerLogs(logContext, {
        type: "container",
        id: "c".repeat(64),
        display: "c".repeat(64)
      })
    ).rejects.toThrow("created by this context")
    await expect(
      readContainerLogs(logContext, {
        type: "network" as "container",
        id: ContainerId,
        display: ContainerId
      })
    ).rejects.toThrow("created by this context")
    await expect(readContainerLogs(logContext, metadataContainer)).rejects.toThrow(
      "created by this context"
    )
    expect(selected.calls).toHaveLength(callsBeforeForgery)
  } finally {
    await cleanupFixture(selected, metadataOnly)
    if (logContext !== null) await closeOwnedDockerContext(logContext).catch(() => {})
  }
})

test("volume create always uses a daemon-generated identity with exact labels", async () => {
  if (!Posix) return
  const selected = await fixture()
  let owned: OwnedDockerContext | null = null
  try {
    owned = await context(selected, recordingRunner(selected))
    const volume = await createVolume(owned, ["--driver", "local"])
    expect(selected.calls.map((call) => call.command)).toEqual([
      ["docker", "volume", "create", ...labelArguments(), "--driver", "local"]
    ])
    expect(selected.calls[0]?.command.join(" ")).not.toContain("inspect")
    expect(selected.calls[0]?.command.join(" ")).not.toContain("logs")
    expect(volume).toEqual({
      type: "volume",
      id: "safe-volume",
      display: "safe-volume"
    })
    assertNoRawCommandFields(volume)
  } finally {
    await cleanupFixture(selected, owned)
  }
})

test("volume create rejects caller-selected names instead of risking idempotent takeover", async () => {
  if (!Posix) return
  const selected = await fixture()
  let owned: OwnedDockerContext | null = null
  try {
    owned = await context(selected, recordingRunner(selected))
    await expect(createVolume(owned, ["--driver", "local", "caller-name"])).rejects.toThrow(
      "caller-selected names are not allowed"
    )
    expect(selected.calls).toHaveLength(0)
  } finally {
    await cleanupFixture(selected, owned)
  }
})

test("resource event is durable before create resolves and hook is a deterministic cut point", async () => {
  if (!Posix) return
  const selected = await fixture()
  let owned: OwnedDockerContext | null = null
  const hookEntered = Promise.withResolvers<void>()
  const hookRelease = Promise.withResolvers<void>()
  try {
    owned = await context(selected, recordingRunner(selected), {
      afterEvent: async () => {
        hookEntered.resolve()
        await hookRelease.promise
      }
    })
    let resolved = false
    const creating = createContainer(owned, ["image:fixed"]).then((value) => {
      resolved = true
      return value
    })
    await hookEntered.promise
    expect(resolved).toBe(false)
    expect(await events(selected)).toHaveLength(1)
    const metadata = await Bun.file(
      join(selected.eventPath, (await eventFiles(selected))[0] ?? "")
    ).stat()
    expect(metadata.mode & 0o777).toBe(0o400)
    hookRelease.resolve()
    expect(await creating).toEqual({
      type: "container",
      id: ContainerId,
      display: ContainerId
    })
  } finally {
    hookRelease.resolve()
    await cleanupFixture(selected, owned)
  }
})

test("event publication failure leaves successful Docker create as a rejected API call", async () => {
  if (!Posix) return
  const selected = await fixture()
  let owned: OwnedDockerContext | null = null
  const movedEventPath = `${selected.eventPath}-moved`
  let moved = false
  try {
    owned = await context(selected, recordingRunner(selected))
    await rename(selected.eventPath, movedEventPath)
    moved = true
    await mkdir(selected.eventPath, { mode: 0o700 })
    await expect(createContainer(owned, ["image:fixed"])).rejects.toThrow(
      "resource event publication failed"
    )
    expect(selected.calls).toHaveLength(1)
    expect(selected.calls[0]?.command.slice(0, 3)).toEqual(["docker", "run", "--detach"])
    expect(await eventFiles(selected)).toEqual([])
  } finally {
    if (moved) {
      await rmdir(selected.eventPath).catch(() => {})
      await rename(movedEventPath, selected.eventPath).catch(() => {})
    }
    await cleanupFixture(selected, owned)
  }
})

test("Docker failures are sanitized with ACK and caller canaries at zero occurrences", async () => {
  if (!Posix) return
  const selected = await fixture()
  let owned: OwnedDockerContext | null = null
  const callerSecret = "owned-docker-caller-canary-secret"
  const rawSecret = `${selected.authority.registrationAck.ackToken}:${callerSecret}`
  try {
    const thrown: Runner = async () => {
      throw new Error(`runner token=${rawSecret}`)
    }
    owned = await context(selected, thrown)
    const thrownFailure = await capturedError(() =>
      createContainer(owned as OwnedDockerContext, ["image:fixed"], {
        knownSecrets: [callerSecret]
      })
    )
    const thrownMessage = thrownFailure.message
    for (const secret of [selected.authority.registrationAck.ackToken, callerSecret]) {
      expect(thrownMessage.split(secret)).toHaveLength(1)
    }
    expect(thrownMessage).toContain("<redacted>")
    await closeOwnedDockerContext(owned)
    owned = null

    const failed: Runner = async () =>
      result(rawSecret, {
        exitCode: 23,
        stderr: `password=${rawSecret}`
      })
    owned = await context(selected, failed)
    const failedResult = await capturedError(() =>
      createContainer(owned as OwnedDockerContext, ["image:fixed"], {
        knownSecrets: [callerSecret]
      })
    )
    for (const secret of [selected.authority.registrationAck.ackToken, callerSecret]) {
      expect(failedResult.message.split(secret)).toHaveLength(1)
    }
  } finally {
    await cleanupFixture(selected, owned)
  }
})

test("opaque contexts cannot be forged, copied, or reused after close", async () => {
  if (!Posix) return
  const selected = await fixture()
  let owned: OwnedDockerContext | null = null
  try {
    const forged = Object.freeze({}) as OwnedDockerContext
    const copied = Object.freeze({
      hidden: selected.authority
    }) as unknown as OwnedDockerContext
    await expect(createContainer(forged, ["image:fixed"])).rejects.toThrow(
      "unknown or expired OwnedDockerContext"
    )
    await expect(createNetwork(copied, ["network"])).rejects.toThrow(
      "unknown or expired OwnedDockerContext"
    )
    await expect(closeOwnedDockerContext(forged)).rejects.toThrow(
      "unknown or expired OwnedDockerContext"
    )

    owned = await context(selected, recordingRunner(selected))
    await closeOwnedDockerContext(owned)
    await expect(createContainer(owned, ["image:fixed"])).rejects.toThrow(
      "unknown or expired OwnedDockerContext"
    )
    owned = null
    expect(selected.calls).toHaveLength(0)
  } finally {
    await cleanupFixture(selected, owned)
  }
})

test("event directory must be canonical, private, contained temp under the capability result", async () => {
  if (!Posix) return
  const selected = await fixture()
  try {
    const moved = `${selected.eventPath}-moved`
    await rename(selected.eventPath, moved)
    await symlink(moved, selected.eventPath)
    await expect(
      createOwnedDockerContext(selected.authority, {
        identityReader: selected.identityReader
      })
    ).rejects.toThrow("resource event directory validation failed")
    await unlink(selected.eventPath)
    await rename(moved, selected.eventPath)

    await chmod(selected.eventPath, 0o755)
    await expect(
      createOwnedDockerContext(selected.authority, {
        identityReader: selected.identityReader
      })
    ).rejects.toThrow("resource event directory validation failed")
  } finally {
    await chmod(selected.eventPath, 0o700).catch(() => {})
    await cleanupFixture(selected, null)
  }
})
