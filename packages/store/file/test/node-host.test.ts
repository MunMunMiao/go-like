import { mkdir, stat, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { expect, test } from "bun:test"

import { background, withCancel } from "@go-like/context"

import {
  newNodeFileStoreHostWithIO,
  type NodeFileStoreFile,
  type NodeFileStoreIO
} from "../src/node-host"
import { newNodeFileStoreHost } from "../src/node"
import { withTempDirectory } from "./helpers"

const LockName = ".go-like-store.lock"

/** Creates one successful injected file handle with optional exact method overrides. */
function injectedFile(
  write: (bytes: Uint8Array) => Promise<void> = async function writeSucceeded(): Promise<void> {},
  sync: () => Promise<void> = async function syncSucceeded(): Promise<void> {},
  close: () => Promise<void> = async function closeSucceeded(): Promise<void> {}
): NodeFileStoreFile {
  return { writeFile: write, sync, close }
}

/** Creates one narrow deterministic I/O boundary for native failure-path tests. */
function injectedIO(
  open: NodeFileStoreIO["open"],
  remove: NodeFileStoreIO["unlink"] = async function removeSucceeded(): Promise<void> {}
): NodeFileStoreIO {
  return {
    async mkdir(): Promise<void> {},
    open,
    async readFile(): Promise<Uint8Array> {
      return new Uint8Array()
    },
    async rename(): Promise<void> {},
    unlink: remove
  }
}

test("Node host performs real defensive file I/O and enforces provider-owned leaf names", async () => {
  await withTempDirectory(async (directory) => {
    const host = newNodeFileStoreHost()
    const handle = await host.acquire(background(), directory)

    const bytes = new Uint8Array([1, 2, 3])
    const write = handle.write(background(), "candidate", bytes)
    bytes[0] = 9
    await write
    const first = await handle.read(background(), "candidate")
    expect(first).toEqual(new Uint8Array([1, 2, 3]))
    if (first === null) throw new Error("expected candidate bytes")
    first[1] = 9
    expect(await handle.read(background(), "candidate")).toEqual(new Uint8Array([1, 2, 3]))

    await handle.rename(background(), "candidate", "snapshot")
    expect(await handle.remove(background(), "snapshot")).toBe(true)
    expect(await handle.remove(background(), "snapshot")).toBe(false)
    await expect(handle.rename(background(), "missing", "target")).rejects.toMatchObject({
      code: "ENOENT"
    })
    expect(() => handle.read(background(), "../escape")).toThrow(TypeError)
    await expect(
      Reflect.apply(handle.write, handle, [background(), "invalid", "not-bytes"])
    ).rejects.toBeInstanceOf(TypeError)

    await mkdir(join(directory, "directory-entry"))
    await expect(handle.read(background(), "directory-entry")).rejects.toBeInstanceOf(Error)
    await expect(
      handle.write(background(), "directory-entry", new Uint8Array([1]))
    ).rejects.toBeInstanceOf(Error)
    await expect(handle.remove(background(), "directory-entry")).rejects.toBeInstanceOf(Error)

    await unlink(join(directory, LockName))
    await handle.close(background())
    await handle.close(background())
    await expect(handle.read(background(), "snapshot")).rejects.toMatchObject({
      code: "GO_LIKE_FILE_STORE_STATE",
      state: "stopped"
    })
  })
})

test("Node host rejects invalid or canceled admission before retaining filesystem ownership", async () => {
  const host = newNodeFileStoreHost()
  await expect(host.acquire(background(), "")).rejects.toBeInstanceOf(TypeError)
  await withTempDirectory(async (directory) => {
    const target = join(directory, "not-created")
    const [ctx, cancel] = withCancel(background())
    cancel()
    await expect(host.acquire(ctx, target)).rejects.toBe(ctx.err())
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" })

    const file = join(directory, "not-a-directory")
    await writeFile(file, "file")
    await expect(host.acquire(background(), file)).rejects.toMatchObject({ code: "EEXIST" })
  })
})

test("Node host rolls back a lock when cancellation arrives after native acquisition", async () => {
  for (const mode of ["success", "close-failure", "unlink-failure"] as const) {
    const [ctx, cancel] = withCancel(background())
    const closeFailure = new Error("provisional close failed")
    const unlinkFailure = new Error("provisional unlink failed")
    let unlinks = 0
    const io = injectedIO(
      async function openLock(): Promise<NodeFileStoreFile> {
        cancel()
        return injectedFile(
          undefined,
          undefined,
          mode === "close-failure"
            ? async function closeFailed(): Promise<void> {
                throw closeFailure
              }
            : undefined
        )
      },
      async function removeLock(): Promise<void> {
        unlinks += 1
        if (mode === "unlink-failure") throw unlinkFailure
      }
    )
    const failure = await newNodeFileStoreHostWithIO(io)
      .acquire(ctx, "controlled")
      .catch((value: unknown) => value)
    if (mode === "success") {
      expect(failure).toBe(ctx.err())
      expect(unlinks).toBe(1)
    } else {
      if (!(failure instanceof AggregateError)) {
        throw new Error("expected aggregate provisional cleanup failure")
      }
      expect(failure.errors[0]).toBe(ctx.err())
      expect(failure.errors[1]).toBe(mode === "close-failure" ? closeFailure : unlinkFailure)
      expect(unlinks).toBe(mode === "close-failure" ? 0 : 1)
    }
  }
})

test("Node host reports injected lock open and shutdown failures without fabricating success", async () => {
  const openFailure = new Error("lock open failed")
  const rejectingOpen = injectedIO(async function rejectOpen(): Promise<NodeFileStoreFile> {
    throw openFailure
  })
  await expect(
    newNodeFileStoreHostWithIO(rejectingOpen).acquire(background(), "controlled")
  ).rejects.toBe(openFailure)

  for (const mode of ["close", "unlink"] as const) {
    const closeFailure = "non-error lock close failure"
    const unlinkFailure = new Error("lock unlink failed")
    const lock = injectedFile(
      undefined,
      undefined,
      mode === "close"
        ? async function closeFailed(): Promise<void> {
            throw closeFailure
          }
        : undefined
    )
    const io = injectedIO(
      async function openLock(): Promise<NodeFileStoreFile> {
        return lock
      },
      async function removeLock(): Promise<void> {
        if (mode === "unlink") throw unlinkFailure
      }
    )
    const handle = await newNodeFileStoreHostWithIO(io).acquire(background(), "controlled")
    const failure = await handle.close(background()).catch((value: unknown) => value)
    if (!(failure instanceof Error)) throw new Error("expected shutdown Error")
    expect(failure).toBe(mode === "unlink" ? unlinkFailure : failure)
    if (mode === "close") expect(failure.message).toBe("Node File Store lock close failed")
  }
})

test("Node host aggregates injected write and file-close failures and still releases its lock", async () => {
  const writeFailure = new Error("write failed")
  const closeFailure = new Error("file close failed")
  const lock = injectedFile()
  const candidate = injectedFile(
    async function writeFailed(): Promise<void> {
      throw writeFailure
    },
    undefined,
    async function closeFailed(): Promise<void> {
      throw closeFailure
    }
  )
  const io = injectedIO(async function openFile(path): Promise<NodeFileStoreFile> {
    return path.endsWith(LockName) ? lock : candidate
  })
  const handle = await newNodeFileStoreHostWithIO(io).acquire(background(), "controlled")
  const failure = await handle
    .write(background(), "candidate", new Uint8Array([1]))
    .catch((value: unknown) => value)
  if (!(failure instanceof AggregateError)) throw new Error("expected aggregate write failure")
  expect(failure.errors).toEqual([writeFailure, closeFailure])
  await handle.close(background())
})

test("Node host normalizes non-Error write failures and serial queue continues", async () => {
  const lock = injectedFile()
  const marker = Object.freeze({ operation: "write" })
  let writes = 0
  const io = injectedIO(async function openFile(path): Promise<NodeFileStoreFile> {
    if (path.endsWith(LockName)) return lock
    writes += 1
    if (writes === 1) {
      return injectedFile(undefined, async function syncFailed(): Promise<void> {
        throw marker
      })
    }
    return injectedFile()
  })
  const handle = await newNodeFileStoreHostWithIO(io).acquire(background(), "controlled")
  const failure = await handle
    .write(background(), "first", new Uint8Array([1]))
    .catch((value: unknown) => value)
  if (!(failure instanceof Error)) throw new Error("expected write Error")
  expect(failure).toMatchObject({
    message: "Node File Store write failed"
  })
  expect(failure.cause).toBe(marker)
  await handle.write(background(), "second", new Uint8Array([2]))
  await handle.close(background())
})
