/// <reference lib="es2024.promise" />

import { readdir } from "node:fs/promises"

import { expect, test } from "bun:test"

import { background, withCancel } from "@go-like/context"
import type { StoreRecord } from "../../src/index"

import { newFileStore, type FileStoreHost } from "../src/index"
import { newNodeFileStoreHost } from "../src/node"
import { delay, startStore, stopStore, withTempDirectory } from "./helpers"

test("concurrent writes are serialized before atomic rename on a real filesystem", async () => {
  await withTempDirectory(async (directory) => {
    const node = newNodeFileStoreHost()
    let activeRenames = 0
    let maximumActiveRenames = 0
    const host: FileStoreHost = {
      async acquire(ctx, selected) {
        const handle = await node.acquire(ctx, selected)
        return {
          close: (closeCtx) => handle.close(closeCtx),
          read: (readCtx, name) => handle.read(readCtx, name),
          write: (writeCtx, name, bytes) => handle.write(writeCtx, name, bytes),
          remove: (removeCtx, name) => handle.remove(removeCtx, name),
          async rename(renameCtx, source, target) {
            activeRenames += 1
            maximumActiveRenames = Math.max(maximumActiveRenames, activeRenames)
            try {
              await delay(2)
              await handle.rename(renameCtx, source, target)
            } finally {
              activeRenames -= 1
            }
          }
        }
      }
    }
    const store = newFileStore(host, directory)
    const handle = await startStore(store)
    const writes: Promise<StoreRecord>[] = []
    for (let index = 0; index < 12; index += 1) {
      writes.push(
        store.write(background(), {
          key: `key/${String(index).padStart(2, "0")}`,
          value: new Uint8Array([index])
        })
      )
    }
    const records = await Promise.all(writes)
    expect(maximumActiveRenames).toBe(1)
    expect(new Set(records.map(({ revision }) => revision)).size).toBe(12)
    await stopStore(handle)

    const restarted = newFileStore(newNodeFileStoreHost(), directory)
    const restartedHandle = await startStore(restarted)
    expect((await restarted.list(background())).records).toHaveLength(12)
    await stopStore(restartedHandle)
  })
})

test("cancellation after temp write never commits and graceful stop removes the temp", async () => {
  await withTempDirectory(async (directory) => {
    const node = newNodeFileStoreHost()
    const [ctx, cancel] = withCancel(background())
    const host: FileStoreHost = {
      async acquire(startCtx, selected) {
        const handle = await node.acquire(startCtx, selected)
        return {
          close: (closeCtx) => handle.close(closeCtx),
          read: (readCtx, name) => handle.read(readCtx, name),
          async write(writeCtx, name, bytes) {
            await handle.write(writeCtx, name, bytes)
            cancel()
          },
          rename: (renameCtx, source, target) => handle.rename(renameCtx, source, target),
          remove: (removeCtx, name) => handle.remove(removeCtx, name)
        }
      }
    }
    const store = newFileStore(host, directory)
    const handle = await startStore(store)
    const failure = await store
      .write(ctx, { key: "canceled-after-temp", value: new Uint8Array([1]) })
      .catch((value: unknown) => value)
    expect(failure).toBe(ctx.err())
    await stopStore(handle)
    expect(await readdir(directory)).toEqual([])
  })
})

test("shutdown preserves ordered remove and close cleanup failures", async () => {
  const removeFailure = new Error("remove failed")
  const closeFailure = new Error("close failed")
  let removes = 0
  const host: FileStoreHost = {
    async acquire() {
      return {
        async close() {
          throw closeFailure
        },
        async read() {
          return null
        },
        async write() {},
        async rename() {},
        async remove() {
          removes += 1
          if (removes === 1) return false
          throw removeFailure
        }
      }
    }
  }
  const handle = await startStore(newFileStore(host, "controlled"))
  const failure = await handle.store.stop(background()).catch((value: unknown) => value)
  if (!(failure instanceof AggregateError)) throw new Error("expected aggregate shutdown failure")
  expect(failure.errors).toEqual([removeFailure, closeFailure])
  expect(removes).toBe(2)
  await expect(handle.running).rejects.toBe(failure)
})

test("startup rollback preserves admitted and malformed resource cleanup failures", async () => {
  const primary = new Error("read failed")
  const closeFailure = new Error("rollback close failed")
  const admittedHost: FileStoreHost = {
    async acquire() {
      return {
        async close() {
          throw closeFailure
        },
        async read() {
          throw primary
        },
        async write() {},
        async rename() {},
        async remove() {
          return false
        }
      }
    }
  }
  const admittedFailure = await newFileStore(admittedHost, "controlled")
    .start(background())
    .catch((value: unknown) => value)
  if (!(admittedFailure instanceof AggregateError)) {
    throw new Error("expected aggregate startup failure")
  }
  expect(admittedFailure.errors).toEqual([primary, closeFailure])

  const malformedHost = {
    async acquire() {
      return {}
    }
  }
  const malformedStore = Reflect.apply(newFileStore, undefined, [malformedHost, "controlled"])
  await expect(malformedStore.start(background())).rejects.toBeInstanceOf(AggregateError)

  const nonErrorHost = {
    async acquire() {
      throw marker
    }
  }
  const marker = Object.freeze({ operation: "acquire" })
  const nonErrorStore = Reflect.apply(newFileStore, undefined, [nonErrorHost, "controlled"])
  const failure = await nonErrorStore.start(background()).catch((value: unknown) => value)
  if (!(failure instanceof Error)) throw new Error("expected startup Error")
  expect(failure).toMatchObject({
    message: "File Store startup failed"
  })
  expect(failure.cause).toBe(marker)
})
