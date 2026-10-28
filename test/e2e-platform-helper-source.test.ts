import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const Root = resolve(import.meta.dir, "..")
const PosixSource = resolve(Root, "e2e/harness/native/go-like_e2e_posix_controller.c")
const PosixFilesystemSource = resolve(Root, "e2e/harness/native/go-like_e2e_posix_filesystem.c")

test("POSIX controller source compiles strictly and passes its self-test on macOS", async () => {
  if (process.platform !== "darwin") return
  const output = join(tmpdir(), `go-like-e2e-posix-controller-test-${process.pid}`)
  try {
    const compile = Bun.spawnSync(
      [
        "/usr/bin/cc",
        "-std=c11",
        "-O2",
        "-Wall",
        "-Wextra",
        "-Wpedantic",
        "-Werror",
        PosixSource,
        "-o",
        output
      ],
      { stdout: "pipe", stderr: "pipe" }
    )
    expect(compile.exitCode).toBe(0)
    const selfTest = Bun.spawnSync([output, "--self-test"], {
      stdout: "pipe",
      stderr: "pipe"
    })
    expect(selfTest.exitCode).toBe(0)
    expect(selfTest.stdout.toString()).toContain("self-test: PASS")
  } finally {
    await rm(output, { force: true })
  }
}, 15_000)

test("POSIX filesystem broker compiles strictly and passes its self-test", async () => {
  if (process.platform !== "darwin" && process.platform !== "linux") return
  const directory = await mkdtemp(join(tmpdir(), "go-like-e2e-fs-source-"))
  const output = join(directory, "filesystem-broker")
  try {
    const compile = Bun.spawnSync(
      [
        "/usr/bin/cc",
        "-std=c11",
        "-O2",
        "-Wall",
        "-Wextra",
        "-Wpedantic",
        "-Werror",
        PosixFilesystemSource,
        "-o",
        output
      ],
      { stdout: "pipe", stderr: "pipe" }
    )
    expect(compile.exitCode).toBe(0)
    const selfTest = Bun.spawnSync([output, "--self-test"], {
      stdout: "pipe",
      stderr: "pipe"
    })
    expect(selfTest.exitCode).toBe(0)
    expect(selfTest.stdout.toString()).toContain("filesystem self-test: PASS")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 15_000)
