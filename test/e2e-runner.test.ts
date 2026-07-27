import { expect, test } from "bun:test"
import { getEventListeners } from "node:events"

import {
  dockerInventoryCommands,
  dockerRemovalCommands,
  newDockerOwner,
  runCommand
} from "../e2e/suites"

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
