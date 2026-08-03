import { expect, test } from "bun:test"
import { lstat, realpath, rename, stat, symlink, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative } from "node:path"

import { collectCleanupFailure, type CleanupFailure } from "../e2e/harness/cleanup"
import {
  canonicalTempRoot,
  createTempDirectory,
  createTempSubdirectories,
  createTempSubdirectory,
  isPathContained,
  removeTempDirectory
} from "../e2e/harness/temp"

test("canonical temp root is absolute, private, and resolves platform aliases", async () => {
  const root = await canonicalTempRoot()
  expect(isAbsolute(root)).toBe(true)
  expect(relative(await realpath(tmpdir()), root)).not.toStartWith("..")
  const metadata = await stat(root)
  if (typeof process.getuid === "function") expect(metadata.uid).toBe(process.getuid())
  if (process.platform !== "win32") expect(metadata.mode & 0o077).toBe(0)
})

test("temp directory handles are contained, private, removable, and not forgeable", async () => {
  const root = await canonicalTempRoot()
  const directory = await createTempDirectory("likego-test-")
  expect(isPathContained(root, directory.path)).toBe(true)
  const metadata = await stat(directory.path)
  if (process.platform !== "win32") expect(metadata.mode & 0o077).toBe(0)
  await removeTempDirectory(directory)
  expect(await Bun.file(directory.path).exists()).toBe(false)
  await expect(removeTempDirectory({ path: directory.path })).rejects.toThrow(
    "unknown LikeGo temp directory handle"
  )
})

test("temp subdirectories create private no-symlink components and reject collisions", async () => {
  const directory = await createTempDirectory("likego-components-")
  try {
    const created = await createTempSubdirectories(directory, [
      ["node_modules", "@likego"],
      ["node_modules", "@likego", "web"],
      ["node_modules", "hono"]
    ])
    const scope = created[0]
    const first = created[1]
    const second = created[2]
    if (scope === undefined || first === undefined || second === undefined) {
      throw new Error("temp subdirectory result inventory changed")
    }
    expect(scope).toBe(join(directory.path, "node_modules", "@likego"))
    expect(first).toBe(join(directory.path, "node_modules", "@likego", "web"))
    expect(second).toBe(join(directory.path, "node_modules", "hono"))
    for (const path of [scope, first, second]) {
      const metadata = await lstat(path)
      expect(metadata.isDirectory()).toBe(true)
      expect(metadata.isSymbolicLink()).toBe(false)
      if (process.platform !== "win32") expect(metadata.mode & 0o077).toBe(0)
    }
    await expect(createTempSubdirectory(directory, ["node_modules"])).rejects.toThrow(
      "path component already exists"
    )
    await expect(createTempSubdirectory(directory, ["..", "escape"])).rejects.toThrow(
      "invalid LikeGo temp path component"
    )
  } finally {
    await removeTempDirectory(directory)
  }
})

test("temp cleanup rejects a symlink swap without deleting its target", async () => {
  if (process.platform === "win32") return
  const first = await createTempDirectory("likego-swap-first-")
  const second = await createTempDirectory("likego-swap-second-")
  const movedFirst = `${first.path}-moved`
  try {
    await Bun.write(`${second.path}/canary`, "preserve")
    await rename(first.path, movedFirst)
    await symlink(second.path, first.path, "dir")
    await expect(removeTempDirectory(first)).rejects.toThrow(/ENOTDIR|ELOOP|ESTALE/u)
    expect(await Bun.file(`${second.path}/canary`).text()).toBe("preserve")
  } finally {
    try {
      await unlink(first.path)
    } catch {}
    try {
      await rename(movedFirst, first.path)
    } catch {}
    await removeTempDirectory(first).catch(() => {})
    await removeTempDirectory(second).catch(() => {})
  }
})

test("unsafe prefixes fail before a directory is created", async () => {
  await expect(createTempDirectory("../unsafe-")).rejects.toThrow(
    "invalid LikeGo temp directory prefix"
  )
  await expect(createTempDirectory("missing-trailing-separator")).rejects.toThrow(
    "invalid LikeGo temp directory prefix"
  )
})

test("temp cleanup failures can be collected without hiding later cleanup", async () => {
  const failures: CleanupFailure[] = []
  await collectCleanupFailure(failures, "forged temp cleanup", () =>
    removeTempDirectory({ path: "/tmp/foreign" })
  )
  expect(failures).toHaveLength(1)
  expect(failures[0]?.error.message).toBe("unknown LikeGo temp directory handle")
})
