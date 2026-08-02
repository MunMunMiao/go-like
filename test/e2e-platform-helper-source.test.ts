import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const Root = resolve(import.meta.dir, "..")
const PosixSource = resolve(Root, "e2e/harness/native/likego_e2e_posix_controller.c")
const PosixProtocol = resolve(Root, "e2e/harness/native/likego_e2e_posix_protocol.h")
const PosixFilesystemSource = resolve(Root, "e2e/harness/native/likego_e2e_posix_filesystem.c")
const PosixFilesystemProtocol = resolve(
  Root,
  "e2e/harness/native/likego_e2e_posix_filesystem_protocol.h"
)

test("POSIX controller source compiles strictly and passes its self-test on macOS", async () => {
  if (process.platform !== "darwin") return
  const output = join(tmpdir(), `likego-e2e-posix-controller-test-${process.pid}`)
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

test("POSIX filesystem broker compiles strictly and retains relative-operation primitives", async () => {
  if (process.platform !== "darwin" && process.platform !== "linux") return
  const directory = await mkdtemp(join(tmpdir(), "likego-e2e-fs-source-"))
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
    const source = await Bun.file(PosixFilesystemSource).text()
    const protocol = await Bun.file(PosixFilesystemProtocol).text()
    for (const primitive of ["mkdirat", "openat", "linkat", "unlinkat", "fstatat"]) {
      expect(source).toContain(primitive)
    }
    expect(source).toContain("O_NOFOLLOW | O_CLOEXEC")
    expect(protocol).toContain("sole absolute-path operation is LGFS_OPEN_ROOT")
    expect(source).toContain("#if defined(LGFS_TEST_BARRIERS)")
    expect(source).toContain("LGFS_TEST_BARRIER_NOTIFY_FD 3")
    expect(source).toContain("LGFS_TEST_BARRIER_RESUME_FD 4")
    expect(source).not.toContain("getenv(")
    expect(source).not.toContain("--test-barrier")
    if (process.platform === "darwin") {
      expect(source).toContain("proc_pidinfo")
      expect(source).toContain("pbi_start_tvusec")
      expect(source).not.toContain("lstart")
      expect(protocol).toContain("LGFS_READ_PROCESS_IDENTITY")
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 15_000)

test("POSIX protocol keeps control, target output, argv, and environment separated", async () => {
  const protocol = await Bun.file(PosixProtocol).text()
  const source = await Bun.file(PosixSource).text()
  expect(protocol).toContain("fd 3: response/event frames")
  expect(protocol).toContain("fd 4: target stdout")
  expect(protocol).toContain("fd 5: target stderr")
  expect(protocol).toContain("Target argv and target environment exist only in PREPARE payload")
  expect(protocol).toContain("LIKEGO_E2E_MAX_FRAME_BODY")
  expect(protocol).toContain("LIKEGO_E2E_ERROR_TRUNCATED_FRAME")
  expect(source).toContain("setsid()")
  expect(source).toContain("LIKEGO_E2E_MACOS_MAX_KILL_ROUNDS")
  expect(source).toContain("LIKEGO_E2E_REQUEST_HARD_TERMINATE")
  expect(source).toContain("frame->type != LIKEGO_E2E_REQUEST_HARD_TERMINATE")
  expect(source).toContain("result = finalize_strict_cgroup(controller")
  expect(source).toContain("result = finalize_anchored(controller, include_term_phase")
  expect(protocol).toContain("LIKEGO_E2E_REQUEST_HARD_TERMINATE = 0x0008")
  expect(protocol).toContain("Request flags remain zero")
  expect(protocol).toContain("and never select this policy")
  expect(source).toContain("cgroup.kill")
  expect(source).toContain("populated")
  expect(source).toContain("stage=%s; no PID/PGID fallback was attempted")
  expect(source).toContain('return "probe-enroll-kill-events-rmdir"')
})
