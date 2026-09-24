import { expect, test } from "bun:test"

import { parseGrpcSoakArgs, runGrpcSoak } from "../e2e/grpc-soak"
import { runCommand } from "../e2e/harness/process"

test("gRPC soak rejects invalid and unbounded parameters before spawning", async () => {
  for (const args of [
    ["--duration", "0s"],
    ["--duration", "61m"],
    ["--duration", "Infinity"],
    ["--concurrency", "0"],
    ["--concurrency", "257"],
    ["--concurrency", "1.5"],
    ["--payload-bytes", "1048577"],
    ["--runtime", "deno"],
    ["--output", ""],
    ["--unknown"]
  ])
    expect(() => parseGrpcSoakArgs(args)).toThrow()
  let spawned = false
  await expect(
    runGrpcSoak({ runtime: "bun", durationMs: 0, concurrency: 1, payloadBytes: 1 }, async () => {
      spawned = true
      throw new Error("must not spawn")
    })
  ).rejects.toThrow("--duration")
  expect(spawned).toBe(false)
})

test("gRPC soak reports server startup failure and cleans signal listeners without starting load", async () => {
  const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]
  let commands = 0
  const result = await runGrpcSoak(parseGrpcSoakArgs([]).options, async (root, definition) => {
    commands += 1
    return await runCommand(root, {
      ...definition,
      command: [
        process.execPath,
        "-e",
        'console.error("fixture startup failure"); process.exit(17)'
      ]
    })
  })
  expect(result.status).toBe("failed")
  expect(result.errors.join("\n")).toContain("exit=17")
  expect(result.errors.join("\n")).toContain("fixture startup failure")
  expect(result.load).toBeNull()
  expect(result.processes.server?.residual).toBe("zero-observed")
  expect(result.processes.server?.cleanupFailures).toEqual([])
  expect(commands).toBe(1)
  expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before)
})
