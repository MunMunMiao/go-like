import { mkdir, readFile, readdir, stat, symlink, unlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { expect, test } from "bun:test"

import { background, withCancel } from "@go-like/context"
import { expiresIn, ifRevision, limit, prefix } from "../../src/index"

import { newFileStore, type FileStoreHost } from "../src/index"
import { newNodeFileStoreHost } from "../src/node"
import { delay, startStore, stopStore, withTempDirectory } from "./helpers"

const SnapshotName = ".go-like-store.snapshot"
const TempName = ".go-like-store.tmp"
const LockName = ".go-like-store.lock"

/** Wraps a real host and fails exactly one atomic rename after its temp write. */
function failOneRename(host: FileStoreHost, failure: Error): FileStoreHost {
  let failed = false
  return {
    async acquire(ctx, directory) {
      const handle = await host.acquire(ctx, directory)
      return {
        close: (closeCtx) => handle.close(closeCtx),
        read: (readCtx, name) => handle.read(readCtx, name),
        write: (writeCtx, name, bytes) => handle.write(writeCtx, name, bytes),
        remove: (removeCtx, name) => handle.remove(removeCtx, name),
        async rename(renameCtx, source, target) {
          if (!failed) {
            failed = true
            throw failure
          }
          await handle.rename(renameCtx, source, target)
        }
      }
    }
  }
}

test("construction is I/O-free and every directory has one admitted owner", async () => {
  await withTempDirectory(async (directory) => {
    const node = newNodeFileStoreHost()
    let acquisitions = 0
    const host: FileStoreHost = {
      async acquire(ctx, selected) {
        acquisitions += 1
        return await node.acquire(ctx, selected)
      }
    }
    const first = newFileStore(host, directory)
    const second = newFileStore(host, directory)
    expect(acquisitions).toBe(0)

    const firstHandle = await startStore(first)
    expect(acquisitions).toBe(1)
    await expect(startStore(second)).rejects.toMatchObject({ code: "GO_LIKE_FILE_STORE_LOCKED" })
    await stopStore(firstHandle)

    const replacement = newFileStore(host, directory)
    const replacementHandle = await startStore(replacement)
    await stopStore(replacementHandle)
    expect(acquisitions).toBe(3)
  })
})

test("restart preserves records and monotonic revisions without using keys as paths", async () => {
  await withTempDirectory(async (directory) => {
    const key = "../../outside/💡"
    const first = newFileStore(newNodeFileStoreHost(), directory)
    const firstHandle = await startStore(first)
    const initial = await first.write(background(), {
      key,
      value: new Uint8Array([1, 2]),
      metadata: { owner: "first" }
    })
    await stopStore(firstHandle)

    const second = newFileStore(newNodeFileStoreHost(), directory)
    const secondHandle = await startStore(second)
    expect(await second.read(background(), key)).toMatchObject({ revision: initial.revision })
    const updated = await second.write(background(), { key, value: new Uint8Array([3]) })
    expect(Number(updated.revision)).toBeGreaterThan(Number(initial.revision))
    await second.delete(background(), key, ifRevision(updated.revision))
    await stopStore(secondHandle)

    expect((await readdir(directory)).sort()).toEqual([SnapshotName])
    await expect(stat(join(dirname(directory), "outside"))).rejects.toMatchObject({
      code: "ENOENT"
    })
  })
})

test("failed rename leaves the last complete snapshot readable and stale temp is ignored", async () => {
  await withTempDirectory(async (directory) => {
    const initialStore = newFileStore(newNodeFileStoreHost(), directory)
    const initialHandle = await startStore(initialStore)
    await initialStore.write(background(), { key: "stable", value: new Uint8Array([1]) })
    await stopStore(initialHandle)

    const failure = new Error("rename failed")
    const failingStore = newFileStore(failOneRename(newNodeFileStoreHost(), failure), directory)
    const failingHandle = await startStore(failingStore)
    await expect(
      failingStore.write(background(), { key: "unstable", value: new Uint8Array([2]) })
    ).rejects.toBe(failure)
    await stopStore(failingHandle)
    await writeFile(join(directory, TempName), "stale incomplete snapshot")

    const recovered = newFileStore(newNodeFileStoreHost(), directory)
    const recoveredHandle = await startStore(recovered)
    expect(await recovered.read(background(), "stable")).not.toBeNull()
    expect(await recovered.read(background(), "unstable")).toBeNull()
    await recovered.write(background(), { key: "recovered", value: new Uint8Array([3]) })
    expect(await recovered.read(background(), "recovered")).not.toBeNull()
    await stopStore(recoveredHandle)
    await expect(stat(join(directory, TempName))).rejects.toMatchObject({ code: "ENOENT" })
  })
})

test("startup safely removes a stale temp symlink", async () => {
  await withTempDirectory(async (root) => {
    const directory = join(root, "store")
    const target = join(root, "protected")
    await mkdir(directory)
    await writeFile(target, "protected")
    await symlink(target, join(directory, TempName))

    const store = newFileStore(newNodeFileStoreHost(), directory)
    const handle = await startStore(store)
    await store.write(background(), { key: "recovered", value: new Uint8Array([1]) })
    expect(await readFile(target, "utf8")).toBe("protected")
    await stopStore(handle)
    await expect(stat(join(directory, TempName))).rejects.toMatchObject({ code: "ENOENT" })
  })
})

test("candidate writes never follow an attacker-provided temp symlink", async () => {
  await withTempDirectory(async (root) => {
    const directory = join(root, "store")
    const target = join(root, "protected")
    await mkdir(directory)
    await writeFile(target, "protected")

    const store = newFileStore(newNodeFileStoreHost(), directory)
    const handle = await startStore(store)
    try {
      await symlink(target, join(directory, TempName))
      const result = await store
        .write(background(), { key: "unsafe", value: new Uint8Array([1]) })
        .catch((failure: unknown) => failure)

      expect(await readFile(target, "utf8")).toBe("protected")
      expect(result).toMatchObject({ code: "EEXIST" })

      await unlink(join(directory, TempName))
      await store.write(background(), { key: "safe", value: new Uint8Array([2]) })
      expect(await store.read(background(), "safe")).not.toBeNull()
    } finally {
      await stopStore(handle)
    }
  })
})

test("corrupt snapshots fail closed with secret-safe stable errors and release the lock", async () => {
  await withTempDirectory(async (directory) => {
    const store = newFileStore(newNodeFileStoreHost(), directory)
    const handle = await startStore(store)
    await store.write(background(), {
      key: "secret-key",
      value: new TextEncoder().encode("secret-value")
    })
    await stopStore(handle)
    const path = join(directory, SnapshotName)
    const valid = await readFile(path)
    await writeFile(path, '{"schemaVersion":1,"revision":1,"records":[],"checksum":"bad"}')

    const corrupted = newFileStore(newNodeFileStoreHost(), directory)
    const error = await corrupted.start(background()).catch((failure: unknown) => failure)
    expect(error).toMatchObject({
      name: "FileStoreCorruptionError",
      code: "GO_LIKE_FILE_STORE_CORRUPTION"
    })
    expect(String(error)).not.toContain(directory)
    expect(String(error)).not.toContain("secret-key")
    expect(String(error)).not.toContain("secret-value")

    await writeFile(path, valid)
    const recovered = newFileStore(newNodeFileStoreHost(), directory)
    const recoveredHandle = await startStore(recovered)
    expect(await recovered.read(background(), "secret-key")).not.toBeNull()
    await stopStore(recoveredHandle)
  })
})

test("TTL cleanup is lazy until the next mutation and pagination remains stable", async () => {
  await withTempDirectory(async (directory) => {
    const first = newFileStore(newNodeFileStoreHost(), directory)
    const firstHandle = await startStore(first)
    await first.write(background(), { key: "ttl/z", value: new Uint8Array([2]) })
    await first.write(background(), { key: "ttl/a", value: new Uint8Array([3]) })
    await first.write(background(), { key: "ttl/old", value: new Uint8Array([1]) }, expiresIn(30))
    await stopStore(firstHandle)
    await delay(50)

    const second = newFileStore(newNodeFileStoreHost(), directory)
    const secondHandle = await startStore(second)
    expect(await second.read(background(), "ttl/old")).toBeNull()
    expect(await readFile(join(directory, SnapshotName), "utf8")).toContain("ttl/old")
    const firstPage = await second.list(background(), prefix("ttl/"), limit(1))
    expect(firstPage.records.map(({ key }) => key)).toEqual(["ttl/a"])
    expect(firstPage.cursor).not.toBeNull()
    await second.write(background(), { key: "ttl/new", value: new Uint8Array([4]) })
    expect(await readFile(join(directory, SnapshotName), "utf8")).not.toContain("ttl/old")
    await stopStore(secondHandle)
  })
})

test("pre-canceled mutation never writes a snapshot or temp file", async () => {
  await withTempDirectory(async (directory) => {
    const store = newFileStore(newNodeFileStoreHost(), directory)
    const handle = await startStore(store)
    const [ctx, cancel] = withCancel(background())
    cancel()
    await expect(store.write(ctx, { key: "canceled", value: new Uint8Array([1]) })).rejects.toBe(
      ctx.err()
    )
    await stopStore(handle)
    expect((await readdir(directory)).includes(SnapshotName)).toBe(false)
    expect((await readdir(directory)).includes(TempName)).toBe(false)
    expect((await readdir(directory)).includes(LockName)).toBe(false)
  })
})
