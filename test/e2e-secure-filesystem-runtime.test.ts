import { expect, test } from "bun:test"
import { resolve } from "node:path"

const Root = resolve(import.meta.dir, "..")
const Fixture = resolve(Root, "e2e/fixtures/secure-filesystem-node.ts")

test("secure filesystem broker works from the Node tsx runtime without Bun globals", async () => {
  if (process.platform !== "darwin" && process.platform !== "linux") return
  const result = Bun.spawnSync(["bunx", "--no-install", "tsx", Fixture], {
    cwd: Root,
    stdout: "pipe",
    stderr: "pipe"
  })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  expect(result.stdout.toString()).toBe("NODE_SECURE_FILESYSTEM_OK\n")
}, 30_000)
