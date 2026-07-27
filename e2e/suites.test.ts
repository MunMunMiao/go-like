import { expect, test } from "bun:test"
import { getEventListeners } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  dockerInventoryCommands,
  dockerRemovalCommands,
  newDockerOwner,
  runCheckedCommand,
  runCommand,
  suiteDefinitions,
  verifyDockerOwnerCleanup
} from "./suites"
import { proofContract } from "./contracts"

test("keeps migrated suite cwd and command routes literal", () => {
  const routedSuiteIds = new Set([
    "store-file-process",
    "web-node-native",
    "transport-http-node",
    "cron-native",
    "bullmq-docker",
    "nats-core-docker",
    "nats-jetstream-docker",
    "config-consul-docker",
    "config-etcd-docker",
    "store-consul-docker",
    "store-etcd-docker",
    "registry-consul-docker",
    "registry-etcd-docker",
    "registry-kubernetes-docker",
    "registry-zookeeper-docker",
    "registry-transport-consul-docker",
    "registry-mdns-docker",
    "otel-docker",
    "otel-instrumentation-docker",
    "pino-runtime",
    "winston-runtime",
    "prometheus-runtime"
  ])
  const routes = Object.fromEntries(
    suiteDefinitions()
      .filter((definition) => routedSuiteIds.has(definition.id))
      .map((definition) => [
        definition.id,
        {
          cwd: definition.cwd,
          command: definition.command
        }
      ])
  )

  expect(routes).toEqual({
    "store-file-process": { cwd: ".", command: ["bun", "e2e/scripts/store-file-process.ts"] },
    "web-node-native": { cwd: "packages/web", command: ["bun", "run", "e2e:node"] },
    "transport-http-node": {
      cwd: "packages/transport/http",
      command: ["bun", "run", "e2e:node"]
    },
    "cron-native": { cwd: "packages/croner", command: ["bun", "run", "e2e:node"] },
    "bullmq-docker": { cwd: "packages/bullmq", command: ["bun", "run", "e2e:docker"] },
    "nats-core-docker": { cwd: "packages/nats", command: ["bun", "run", "e2e:docker:core"] },
    "nats-jetstream-docker": {
      cwd: "packages/nats",
      command: ["bun", "run", "e2e:docker:jetstream"]
    },
    "config-consul-docker": {
      cwd: "packages/config/consul",
      command: ["bun", "run", "test:docker"]
    },
    "config-etcd-docker": {
      cwd: "packages/config/etcd",
      command: ["bun", "run", "test:docker"]
    },
    "store-consul-docker": {
      cwd: "packages/store/consul",
      command: ["bun", "run", "test:docker"]
    },
    "store-etcd-docker": {
      cwd: "packages/store/etcd",
      command: ["bun", "run", "test:docker"]
    },
    "registry-consul-docker": {
      cwd: "packages/registry/consul",
      command: ["bun", "run", "test:docker"]
    },
    "registry-etcd-docker": {
      cwd: "packages/registry/etcd",
      command: ["bun", "run", "test:docker"]
    },
    "registry-kubernetes-docker": {
      cwd: "packages/registry/kubernetes",
      command: ["bun", "run", "test:docker"]
    },
    "registry-zookeeper-docker": {
      cwd: "packages/registry/zookeeper",
      command: ["bun", "run", "test:docker"]
    },
    "registry-transport-consul-docker": {
      cwd: ".",
      command: ["bun", "e2e/scripts/registry-transport-consul-docker.ts"]
    },
    "registry-mdns-docker": {
      cwd: "packages/registry/mdns",
      command: ["bun", "run", "test:docker"]
    },
    "otel-docker": { cwd: "packages/otel", command: ["bun", "test/e2e/docker-e2e.ts"] },
    "otel-instrumentation-docker": {
      cwd: "packages/otel",
      command: ["bun", "test/e2e/instrumentation-docker.ts"]
    },
    "pino-runtime": {
      cwd: "packages/pino",
      command: ["bun", "x", "tsx", "test/e2e/native-e2e.ts"]
    },
    "winston-runtime": {
      cwd: "packages/winston",
      command: ["bun", "x", "tsx", "../../e2e/scripts/winston-native.ts"]
    },
    "prometheus-runtime": {
      cwd: "packages/prometheus",
      command: ["node", "../../e2e/scripts/prometheus-native.ts"]
    }
  })
  expect(
    suiteDefinitions().find((definition) => definition.id === "web-node-native")
  ).toMatchObject({
    id: "web-node-native",
    marker: "LIKEGO_WEB_NODE_E2E_RESULT="
  })
})

test("every release-blocking suite owns scenario, service, and cleanup proof contracts", () => {
  for (const definition of suiteDefinitions()) {
    if (!definition.releaseBlocking) continue
    const contract = proofContract(definition.id)
    if (contract === null) {
      throw new Error(`${definition.id} has no release evidence/service/cleanup contract`)
    }
  }
})

test("registry Consul suite locks current lifecycle evidence", async () => {
  const source = await Bun.file(`${import.meta.dir}/suites.ts`).text()
  const normalizedSource = source.replace(/\s+/g, " ")
  const paths = [
    "scenarioEvidence.service-instance-roundtrip.discoveredExact",
    "scenarioEvidence.replacement-snapshot-watch.emptySnapshot",
    "scenarioEvidence.private-ttl-heartbeat.publicHandleExposed"
  ]
  for (const path of paths) expect(normalizedSource).toContain(`{ path: "${path}"`)
})

test("Docker ownership uses one exact label instead of LikeGo name prefixes", () => {
  const owner = newDockerOwner("registry-consul-docker")
  const commands = dockerInventoryCommands(owner)

  expect(owner).toStartWith("registry-consul-docker-")
  expect(commands).toEqual([
    [
      "docker",
      "ps",
      "--all",
      "--filter",
      `label=io.likego.e2e.owner=${owner}`,
      "--format",
      "{{.Names}}"
    ],
    [
      "docker",
      "network",
      "ls",
      "--filter",
      `label=io.likego.e2e.owner=${owner}`,
      "--format",
      "{{.Name}}"
    ],
    [
      "docker",
      "volume",
      "ls",
      "--filter",
      `label=io.likego.e2e.owner=${owner}`,
      "--format",
      "{{.Name}}"
    ]
  ])
  expect(JSON.stringify(commands)).not.toContain("likego-")
})

test("Docker ownership fails closed for missing or unsafe owner values", () => {
  expect(() => dockerInventoryCommands("")).toThrow("invalid LIKEGO_E2E_OWNER")
  expect(() => dockerInventoryCommands("foreign owner")).toThrow("invalid LIKEGO_E2E_OWNER")
  expect(() => dockerInventoryCommands("--filter=all")).toThrow("invalid LIKEGO_E2E_OWNER")
})

test("Docker cleanup commands remove containers before dependent resources", () => {
  expect(
    dockerRemovalCommands({
      containers: new Set(["owned-container"]),
      networks: new Set(["owned-network"]),
      volumes: new Set(["owned-volume"])
    })
  ).toEqual([
    ["docker", "rm", "--force", "--volumes", "owned-container"],
    ["docker", "network", "rm", "owned-network"],
    ["docker", "volume", "rm", "owned-volume"]
  ])
})

test("every central Docker harness fails closed and labels its resources", async () => {
  const harnesses = [
    "packages/bullmq/test/e2e/docker-e2e.ts",
    "packages/nats/test/e2e/core-docker-e2e.ts",
    "packages/nats/test/e2e/jetstream-docker-e2e.ts",
    "packages/config/consul/test/integration/consul-docker.ts",
    "packages/config/etcd/test/integration/etcd-docker.ts",
    "packages/store/consul/test/integration/consul-docker.ts",
    "packages/store/etcd/test/integration/etcd-docker.ts",
    "packages/registry/consul/test/integration/consul-docker.ts",
    "packages/registry/etcd/test/integration/etcd-docker.ts",
    "packages/registry/kubernetes/test/integration/k3s-docker.ts",
    "packages/registry/zookeeper/test/integration/zookeeper-docker.ts",
    "e2e/scripts/registry-transport-consul-docker.ts",
    "packages/registry/mdns/test/e2e/docker-e2e.ts",
    "packages/otel/test/e2e/docker-e2e.ts",
    "packages/otel/test/e2e/instrumentation-docker.ts"
  ]
  for (const harness of harnesses) {
    const source = await Bun.file(join(import.meta.dir, "..", harness)).text()
    expect(source, harness).toContain("process.env.LIKEGO_E2E_OWNER")
    expect(source, harness).toContain("invalid LIKEGO_E2E_OWNER")
    if (harness.includes("registry/mdns")) continue
    expect(source, harness).toContain("io.likego.e2e.owner=")
  }
  for (const family of ["ipv4", "ipv6"]) {
    const compose = await Bun.file(
      join(import.meta.dir, `../packages/registry/mdns/test/e2e/compose.${family}.yaml`)
    ).text()
    expect(compose.match(/io\.likego\.e2e\.owner:/g)).toHaveLength(6)
    expect(compose).toContain("${LIKEGO_E2E_OWNER:?required}")
  }
})

test("the provider Docker gate fixes exactly five fail-closed owner-labelled harnesses", async () => {
  const harnesses = [
    "packages/broker/rabbitmq/test/e2e/rabbitmq-docker-e2e.ts",
    "packages/cache/redis/test/integration/redis-docker.ts",
    "packages/config/kubernetes/test/integration/k3s-docker.ts",
    "packages/config/vault/test/integration/vault-docker.ts",
    "packages/store/vault/test/integration/vault-docker.ts"
  ]
  expect(harnesses).toHaveLength(5)
  for (const harness of harnesses) {
    const source = await Bun.file(join(import.meta.dir, "..", harness)).text()
    expect(source, harness).toContain("process.env.LIKEGO_E2E_OWNER")
    expect(source, harness).toContain("invalid LIKEGO_E2E_OWNER")
    expect(source, harness).toContain("io.likego.e2e.owner=")
  }
})

test("runCommand passes one child-only Docker owner without mutating the parent", async () => {
  const owner = newDockerOwner("owner-env-test")
  const controller = new AbortController()
  const listenerBaseline = getEventListeners(controller.signal, "abort").length
  const before = process.env.LIKEGO_E2E_OWNER
  const result = await runCommand(import.meta.dir, {
    cwd: ".",
    command: [
      process.execPath,
      "-e",
      "process.stdout.write(process.env.LIKEGO_E2E_OWNER ?? ''); process.stderr.write('captured')"
    ],
    timeoutMs: 2_000,
    environment: { LIKEGO_E2E_OWNER: owner },
    signal: controller.signal
  })
  expect(result).toMatchObject({ exitCode: 0, stdout: owner, stderr: "captured", timedOut: false })
  expect(process.env.LIKEGO_E2E_OWNER).toBe(before)
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(listenerBaseline)
})

test("runCommand preserves a pre-aborted reason before spawning an executable", async () => {
  const controller = new AbortController()
  const reason = Object.freeze({ code: "PRE_ABORT" })
  controller.abort(reason)
  let failure: unknown = null
  try {
    await runCommand(import.meta.dir, {
      cwd: ".",
      command: ["likego-command-that-does-not-exist"],
      timeoutMs: 2_000,
      signal: controller.signal
    })
  } catch (error) {
    failure = error
  }
  expect(failure).toBe(reason)
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
})

const dockerOwnershipTest = process.env.LIKEGO_E2E_DOCKER_OWNERSHIP === "1" ? test : test.skip

dockerOwnershipTest(
  "real Docker cleanup isolates foreign resources and concurrent owners",
  async () => {
    const root = join(import.meta.dir, "..")
    const run = crypto.randomUUID().slice(0, 8)
    const ownerA = newDockerOwner("ownership-a")
    const ownerB = newDockerOwner("ownership-b")
    const foreignOwner = newDockerOwner("ownership-foreign")
    const image =
      "node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d"
    const fixtures = [
      { owner: ownerA, suffix: "a" },
      { owner: ownerB, suffix: "b" },
      { owner: foreignOwner, suffix: "foreign" }
    ].map(function fixture(value) {
      return Object.freeze({
        owner: value.owner,
        container: `likego-owner-${run}-${value.suffix}`,
        network: `likego-owner-${run}-${value.suffix}-network`,
        volume: `likego-owner-${run}-${value.suffix}-volume`
      })
    })

    async function docker(args: readonly string[], required = true): Promise<number> {
      const result = await runCommand(root, {
        cwd: ".",
        command: ["docker", ...args],
        timeoutMs: 30_000
      })
      if (required && (result.timedOut || result.exitCode !== 0)) {
        throw new Error(`docker ${args[0] ?? "command"} failed: ${result.stderr}`)
      }
      return result.exitCode
    }

    async function exists(kind: "container" | "network" | "volume", name: string) {
      const args = kind === "container" ? ["inspect", name] : [kind, "inspect", name]
      return (await docker(args, false)) === 0
    }

    try {
      await Promise.all(
        fixtures.flatMap(function createDependencies(fixture) {
          const label = `io.likego.e2e.owner=${fixture.owner}`
          return [
            docker(["network", "create", "--label", label, fixture.network]),
            docker(["volume", "create", "--label", label, fixture.volume])
          ]
        })
      )
      await Promise.all(
        fixtures.map(function createContainer(fixture) {
          return docker([
            "run",
            "--detach",
            "--name",
            fixture.container,
            "--label",
            `io.likego.e2e.owner=${fixture.owner}`,
            "--network",
            fixture.network,
            "--mount",
            `type=volume,source=${fixture.volume},target=/owned`,
            image,
            "sleep",
            "300"
          ])
        })
      )

      const outcomes = await Promise.allSettled([
        verifyDockerOwnerCleanup(root, ownerA, performance.now() + 60_000),
        verifyDockerOwnerCleanup(root, ownerB, performance.now() + 60_000)
      ])
      expect(outcomes.every((outcome) => outcome.status === "rejected")).toBe(true)
      for (const outcome of outcomes) {
        if (outcome.status === "rejected")
          expect(String(outcome.reason)).toContain("Docker suite leaked resources")
      }
      for (const fixture of fixtures.slice(0, 2)) {
        expect(await exists("container", fixture.container)).toBe(false)
        expect(await exists("network", fixture.network)).toBe(false)
        expect(await exists("volume", fixture.volume)).toBe(false)
      }
      const foreign = fixtures[2]
      if (foreign === undefined) throw new Error("foreign Docker fixture is missing")
      expect(await exists("container", foreign.container)).toBe(true)
      expect(await exists("network", foreign.network)).toBe(true)
      expect(await exists("volume", foreign.volume)).toBe(true)
    } finally {
      for (const fixture of fixtures) await docker(["rm", "--force", fixture.container], false)
      await Promise.all(
        fixtures.flatMap(function cleanupDependencies(fixture) {
          return [
            docker(["network", "rm", fixture.network], false),
            docker(["volume", "rm", fixture.volume], false)
          ]
        })
      )
    }
  },
  120_000
)

dockerOwnershipTest(
  "real Docker cleanup after child cancellation removes an image volume and preserves foreign ownership",
  async () => {
    const root = join(import.meta.dir, "..")
    const run = crypto.randomUUID().slice(0, 8)
    const owner = newDockerOwner("ownership-cancel")
    const foreignOwner = newDockerOwner("ownership-cancel-foreign")
    const container = `likego-owner-cancel-${run}`
    const lateContainer = `likego-owner-cancel-${run}-late`
    const foreignContainer = `likego-owner-cancel-${run}-foreign`
    const directory = await mkdtemp(join(tmpdir(), "likego-e2e-docker-cancel-"))
    const readyPath = join(directory, "container.ready")
    const helperTriggerPath = join(directory, "helper.trigger")
    const rabbitMqImage =
      "docker.io/library/rabbitmq:4.3.4-management-alpine@sha256:c511562a12d3299f760b213d8e4454919840afc73dab21f398479988d460b4ce"
    const nodeImage =
      "node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d"
    const controller = new AbortController()
    const helperController = new AbortController()
    const reason = Object.freeze({ code: "DOCKER_CHILD_CANCELLED" })
    let anonymousVolume = ""
    let helperRunning: ReturnType<typeof runCommand> | null = null
    let running: Promise<unknown> | null = null

    async function docker(
      args: readonly string[],
      required = true
    ): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
      const result = await runCommand(root, {
        cwd: ".",
        command: ["docker", ...args],
        timeoutMs: 60_000
      })
      if (required && (result.timedOut || result.exitCode !== 0)) {
        throw new Error(`docker ${args[0] ?? "command"} failed: ${result.stderr}`)
      }
      return result
    }

    async function exists(kind: "container" | "volume", name: string): Promise<boolean> {
      const command = kind === "container" ? ["inspect", name] : ["volume", "inspect", name]
      return (await docker(command, false)).exitCode === 0
    }

    try {
      await docker([
        "run",
        "--detach",
        "--name",
        foreignContainer,
        "--label",
        `io.likego.e2e.owner=${foreignOwner}`,
        nodeImage,
        "sleep",
        "300"
      ])
      const helperSource = [
        `while (!(await Bun.file(${JSON.stringify(helperTriggerPath)}).exists())) await Bun.sleep(10)`,
        "await Bun.sleep(500)",
        `const child = Bun.spawn(${JSON.stringify([
          "docker",
          "run",
          "--detach",
          "--name",
          lateContainer,
          "--label",
          `io.likego.e2e.owner=${owner}`,
          nodeImage,
          "sleep",
          "300"
        ])}, { stdout: "pipe", stderr: "pipe" })`,
        "const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])",
        "if (exitCode !== 0) throw new Error(`late docker run failed (${exitCode}): ${stderr || stdout}`)"
      ].join(";")
      helperRunning = runCommand(root, {
        cwd: ".",
        command: [process.execPath, "-e", helperSource],
        timeoutMs: 30_000,
        signal: helperController.signal
      })
      const childSource = [
        `const child = Bun.spawn(${JSON.stringify([
          "docker",
          "run",
          "--detach",
          "--name",
          container,
          "--label",
          `io.likego.e2e.owner=${owner}`,
          rabbitMqImage
        ])}, { stdout: "pipe", stderr: "pipe" })`,
        "const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])",
        "if (exitCode !== 0) throw new Error(`docker run failed (${exitCode}): ${stderr || stdout}`)",
        `await Bun.write(${JSON.stringify(readyPath)}, "ready")`,
        "await new Promise(function never() {})"
      ].join(";")
      running = runCommand(root, {
        cwd: ".",
        command: [process.execPath, "-e", childSource],
        timeoutMs: 90_000,
        signal: controller.signal
      })
      const readyDeadline = performance.now() + 60_000
      while (!(await Bun.file(readyPath).exists()) && performance.now() < readyDeadline) {
        await Bun.sleep(25)
      }
      expect(await Bun.file(readyPath).exists()).toBe(true)
      const inspected = await docker([
        "inspect",
        "--format",
        '{{range .Mounts}}{{if eq .Type "volume"}}{{println .Name}}{{end}}{{end}}',
        container
      ])
      anonymousVolume = inspected.stdout.trim().split(/\r?\n/u)[0] ?? ""
      expect(anonymousVolume.length).toBeGreaterThan(0)
      expect(await exists("volume", anonymousVolume)).toBe(true)

      controller.abort(reason)
      let childFailure: unknown = null
      try {
        await running
      } catch (error) {
        childFailure = error
      }
      expect(childFailure).toBe(reason)

      let cleanupFailure: unknown = null
      try {
        await verifyDockerOwnerCleanup(root, owner, performance.now() + 60_000)
      } catch (error) {
        cleanupFailure = error
      }
      expect(String(cleanupFailure)).toContain("Docker suite leaked resources")
      expect(await exists("container", container)).toBe(false)
      expect(await exists("volume", anonymousVolume)).toBe(false)
      expect(await exists("container", foreignContainer)).toBe(true)

      await Bun.write(helperTriggerPath, "run")
      let lateCleanupFailure: unknown = null
      try {
        await verifyDockerOwnerCleanup(root, owner, performance.now() + 60_000)
      } catch (error) {
        lateCleanupFailure = error
      }
      const helperResult = await helperRunning
      expect(helperResult).toMatchObject({ exitCode: 0, timedOut: false })
      expect(String(lateCleanupFailure)).toContain("Docker suite leaked resources")
      expect(await exists("container", lateContainer)).toBe(false)
      expect(await exists("container", foreignContainer)).toBe(true)
    } finally {
      controller.abort(reason)
      if (running !== null) await running.catch(() => {})
      helperController.abort(new Error("Docker late-create helper cleanup"))
      if (helperRunning !== null) await helperRunning.catch(() => {})
      let finalCleanupFailure: unknown = null
      try {
        await verifyDockerOwnerCleanup(root, owner, performance.now() + 60_000)
      } catch (error) {
        if (!String(error).includes("Docker suite leaked resources")) {
          finalCleanupFailure = error
        }
      }
      await docker(["rm", "--force", "--volumes", container], false)
      await docker(["rm", "--force", "--volumes", lateContainer], false)
      await docker(["rm", "--force", "--volumes", foreignContainer], false)
      if (anonymousVolume !== "") await docker(["volume", "rm", anonymousVolume], false)
      const ownerFilter = `label=io.likego.e2e.owner=${owner}`
      const finalOwnerResources = await Promise.all([
        docker(["ps", "--all", "--quiet", "--filter", ownerFilter], false),
        docker(["network", "ls", "--quiet", "--filter", ownerFilter], false),
        docker(["volume", "ls", "--quiet", "--filter", ownerFilter], false)
      ])
      if (finalOwnerResources.some((result) => result.stdout !== "")) {
        finalCleanupFailure = new Error("Docker cancellation test left owner resources")
      }
      if (anonymousVolume !== "" && (await exists("volume", anonymousVolume))) {
        finalCleanupFailure = new Error("Docker cancellation test left its anonymous volume")
      }
      await rm(directory, { recursive: true, force: true })
      if (finalCleanupFailure !== null) throw finalCleanupFailure
    }
  },
  180_000
)

/** Returns whether one process identifier still belongs to a running, non-zombie process. */
async function processIsRunning(processId: number): Promise<boolean> {
  try {
    process.kill(processId, 0)
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH")
  }
  if (process.platform !== "linux") return true
  try {
    const stat = await Bun.file(`/proc/${processId}/stat`).text()
    const commandEnd = stat.lastIndexOf(")")
    return commandEnd < 0 || stat.slice(commandEnd + 2, commandEnd + 3) !== "Z"
  } catch {
    return false
  }
}

/** Waits briefly for the operating system to reap a force-terminated descendant. */
async function waitForProcessExit(processId: number): Promise<void> {
  const deadline = performance.now() + 2_000
  while ((await processIsRunning(processId)) && performance.now() < deadline) await Bun.sleep(25)
}

test("runCommand preserves an in-flight abort reason and terminates the complete tree", async () => {
  const directory = await mkdtemp(join(tmpdir(), "likego-e2e-abort-tree-"))
  const processIdPath = join(directory, "descendant.pid")
  const readyPath = join(directory, "descendant.ready")
  const descendantSource = [
    "process.on('SIGTERM', function ignore() {})",
    `await Bun.write(${JSON.stringify(readyPath)}, "ready")`,
    "await new Promise(function never() {})"
  ].join(";")
  const parentSource = [
    `const descendant = Bun.spawn([process.execPath, "-e", ${JSON.stringify(descendantSource)}], { stdout: "inherit", stderr: "inherit" })`,
    `await Bun.write(${JSON.stringify(processIdPath)}, String(descendant.pid))`,
    `while (!(await Bun.file(${JSON.stringify(readyPath)}).exists())) await Bun.sleep(5)`,
    "await new Promise(function never() {})"
  ].join(";")
  const controller = new AbortController()
  const reason = Object.freeze({ code: "IN_FLIGHT_ABORT" })
  const listenerBaseline = getEventListeners(controller.signal, "abort").length
  let descendantPid: number | null = null
  const running = runCommand(import.meta.dir, {
    cwd: ".",
    command: [process.execPath, "-e", parentSource],
    timeoutMs: 5_000,
    signal: controller.signal
  })
  try {
    const readyDeadline = performance.now() + 2_000
    while (!(await Bun.file(readyPath).exists()) && performance.now() < readyDeadline) {
      await Bun.sleep(5)
    }
    expect(await Bun.file(readyPath).exists()).toBe(true)
    descendantPid = Number(await Bun.file(processIdPath).text())
    controller.abort(reason)
    let failure: unknown = null
    try {
      await running
    } catch (error) {
      failure = error
    }
    expect(failure).toBe(reason)
    expect(Number.isInteger(descendantPid)).toBe(true)
    await waitForProcessExit(descendantPid)
    expect(await processIsRunning(descendantPid)).toBe(false)
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(listenerBaseline)
  } finally {
    controller.abort(reason)
    await running.catch(() => {})
    if (descendantPid !== null && (await processIsRunning(descendantPid))) {
      process.kill(descendantPid, "SIGKILL")
    }
    await rm(directory, { recursive: true, force: true })
  }
}, 8_000)

test("runCommand preserves an abort reason when process-tree cleanup fails", async () => {
  if (process.platform === "win32") return
  const directory = await mkdtemp(join(tmpdir(), "likego-e2e-abort-cleanup-"))
  const descendantPidPath = join(directory, "descendant.pid")
  const readyPath = join(directory, "child.ready")
  const controller = new AbortController()
  const reason = Object.freeze({ code: "ABORT_WITH_CLEANUP_FAILURE" })
  const cleanupFailure = new Error("injected cleanup failure")
  const originalSpawn = Bun.spawn
  const originalProcessKill = process.kill
  const originalStderrWrite = process.stderr.write
  let childPid: number | null = null
  let descendantPid: number | null = null
  let diagnostic = ""
  let running: ReturnType<typeof runCommand> | null = null

  try {
    Bun.spawn = ((...args: unknown[]) => {
      const child = Reflect.apply(originalSpawn, Bun, args) as Bun.Subprocess
      childPid = child.pid
      const originalChildKill = child.kill.bind(child)
      Object.defineProperty(child, "kill", {
        configurable: true,
        value(signal?: Parameters<Bun.Subprocess["kill"]>[0]) {
          if (signal === "SIGTERM") throw cleanupFailure
          return originalChildKill(signal)
        }
      })
      return child
    }) as typeof Bun.spawn
    process.kill = ((processId: number, signal?: Parameters<typeof process.kill>[1]) => {
      if (processId < 0 && signal === "SIGTERM") throw cleanupFailure
      return originalProcessKill(processId, signal)
    }) as typeof process.kill
    process.stderr.write = ((chunk: Uint8Array | string) => {
      diagnostic += chunk.toString()
      return true
    }) as typeof process.stderr.write

    const descendantSource = [
      `await Bun.write(${JSON.stringify(readyPath)}, "ready")`,
      "await new Promise(function never() {})"
    ].join(";")
    const childSource = [
      `const descendant = Bun.spawn([process.execPath, "-e", ${JSON.stringify(descendantSource)}], { stdout: "inherit", stderr: "inherit" })`,
      `await Bun.write(${JSON.stringify(descendantPidPath)}, String(descendant.pid))`,
      `while (!(await Bun.file(${JSON.stringify(readyPath)}).exists())) await Bun.sleep(5)`,
      "await new Promise(function never() {})"
    ].join(";")
    running = runCommand(import.meta.dir, {
      cwd: ".",
      command: [process.execPath, "-e", childSource],
      timeoutMs: 5_000,
      signal: controller.signal
    })
    const readyDeadline = performance.now() + 2_000
    while (!(await Bun.file(readyPath).exists()) && performance.now() < readyDeadline) {
      await Bun.sleep(5)
    }
    expect(await Bun.file(readyPath).exists()).toBe(true)
    descendantPid = Number(await Bun.file(descendantPidPath).text())
    controller.abort(reason)
    let failure: unknown = null
    try {
      await running
    } catch (error) {
      failure = error
    }

    Bun.spawn = originalSpawn
    process.kill = originalProcessKill
    process.stderr.write = originalStderrWrite
    expect(failure).toBe(reason)
    expect(diagnostic).toContain("LikeGo runCommand process-tree cleanup failed")
    expect(childPid).not.toBeNull()
    expect(descendantPid).not.toBeNull()
    for (const processId of [childPid, descendantPid]) {
      if (processId === null) continue
      await waitForProcessExit(processId)
      expect(await processIsRunning(processId)).toBe(false)
    }
  } finally {
    Bun.spawn = originalSpawn
    process.kill = originalProcessKill
    process.stderr.write = originalStderrWrite
    controller.abort(reason)
    if (running !== null) await running.catch(() => {})
    for (const processId of [childPid, descendantPid]) {
      if (processId !== null && (await processIsRunning(processId))) {
        originalProcessKill(processId, "SIGKILL")
        await waitForProcessExit(processId)
      }
    }
    await rm(directory, { recursive: true, force: true })
  }
}, 12_000)

test("runCommand terminates a descendant that inherits stdout and ignores SIGTERM", async () => {
  const descendantSource = [
    "process.on('SIGTERM', function ignore() {})",
    "process.stdout.write('DESCENDANT_READY\\n')",
    "await new Promise(function never() {})"
  ].join(";")
  const parentSource = [
    `const descendant = Bun.spawn([process.execPath, "-e", ${JSON.stringify(descendantSource)}], { stdout: "inherit", stderr: "inherit" })`,
    "process.stdout.write(`DESCENDANT_PID=${descendant.pid}\\n`)",
    "process.exit(0)"
  ].join(";")
  const startedAt = performance.now()
  const controller = new AbortController()
  const listenerBaseline = getEventListeners(controller.signal, "abort").length
  let descendantPid: number | null = null
  try {
    const result = await runCommand(import.meta.dir, {
      cwd: ".",
      command: [process.execPath, "-e", parentSource],
      timeoutMs: 250,
      signal: controller.signal
    })
    const match = /DESCENDANT_PID=(\d+)/.exec(result.stdout)
    descendantPid = match === null ? null : Number(match[1])
    expect(result.timedOut).toBe(true)
    expect(result.stdout).toContain("DESCENDANT_READY")
    expect(descendantPid).not.toBeNull()
    expect(performance.now() - startedAt).toBeLessThan(8_000)
    if (descendantPid !== null) {
      await waitForProcessExit(descendantPid)
      expect(await processIsRunning(descendantPid)).toBe(false)
    }
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(listenerBaseline)
  } finally {
    if (descendantPid !== null && (await processIsRunning(descendantPid)))
      process.kill(descendantPid, "SIGKILL")
  }
}, 12_000)

test("runCommand rejects and terminates a silent descendant after its parent exits cleanly", async () => {
  if (process.platform === "win32") return
  const directory = await mkdtemp(join(tmpdir(), "likego-e2e-process-tree-"))
  const processIdPath = join(directory, "descendant.pid")
  const readyPath = join(directory, "descendant.ready")
  const descendantSource = [
    "process.on('SIGTERM', function ignore() {})",
    `await Bun.write(${JSON.stringify(readyPath)}, "ready")`,
    "await new Promise(function never() {})"
  ].join(";")
  const parentSource = [
    `const descendant = Bun.spawn([process.execPath, "-e", ${JSON.stringify(descendantSource)}], { stdout: "ignore", stderr: "ignore" })`,
    `await Bun.write(${JSON.stringify(processIdPath)}, String(descendant.pid))`,
    `while (!(await Bun.file(${JSON.stringify(readyPath)}).exists())) await Bun.sleep(5)`,
    "process.exit(0)"
  ].join(";")
  let descendantPid: number | null = null
  try {
    let failure: unknown = null
    try {
      await runCommand(import.meta.dir, {
        cwd: ".",
        command: [process.execPath, "-e", parentSource],
        timeoutMs: 5_000
      })
    } catch (error) {
      failure = error
    }
    descendantPid = Number(await Bun.file(processIdPath).text())
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).toContain("descendant processes remained")
    expect(Number.isInteger(descendantPid)).toBe(true)
    await waitForProcessExit(descendantPid)
    expect(await processIsRunning(descendantPid)).toBe(false)
  } finally {
    if (descendantPid !== null && (await processIsRunning(descendantPid)))
      process.kill(descendantPid, "SIGKILL")
    await rm(directory, { recursive: true, force: true })
  }
}, 12_000)

test("checked infrastructure commands reject a permanent process inside a bounded owner", async () => {
  const source = [
    "process.on('SIGTERM', function ignore() {})",
    "await new Promise(function never() {})"
  ].join(";")
  const startedAt = performance.now()
  await expect(
    runCheckedCommand(import.meta.dir, [process.execPath, "-e", source], 250)
  ).rejects.toThrow("command exceeded 250ms")
  expect(performance.now() - startedAt).toBeLessThan(8_000)
}, 12_000)
