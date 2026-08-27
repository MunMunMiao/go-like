/// <reference types="node" />

import { writeFile } from "node:fs/promises"
import { join } from "node:path"

import { expect, test } from "bun:test"

import { background } from "@go-like/context"
import { cursor, expiresIn, limit } from "../../src/index"

import { newFileStore, newFileStoreCorruptionError, newFileStoreStateError } from "../src/index"
import { newNodeFileStoreHost } from "../src/node"
import { startStore, stopStore, withTempDirectory } from "./helpers"

const SnapshotName = ".go-like-store.snapshot"
const MaximumValueBytes = 16_777_216

interface SnapshotPayload {
  readonly schemaVersion: unknown
  readonly revision: unknown
  readonly records: unknown
}

/** Returns one exact lowercase SHA-256 checksum for a persisted payload. */
async function checksum(payload: SnapshotPayload): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(payload))
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
  let value = ""
  for (const byte of digest) value += byte.toString(16).padStart(2, "0")
  return value
}

/** Writes one complete checksummed snapshot candidate to a real directory. */
async function writeSnapshot(directory: string, payload: SnapshotPayload): Promise<void> {
  await writeFile(
    join(directory, SnapshotName),
    JSON.stringify({
      schemaVersion: payload.schemaVersion,
      revision: payload.revision,
      records: payload.records,
      checksum: await checksum(payload)
    })
  )
}

/** Starts one real File Store and asserts its secret-safe corruption category. */
async function expectCorruption(
  write: (directory: string) => PromiseLike<void>,
  reason: string
): Promise<void> {
  await withTempDirectory(async (directory) => {
    await write(directory)
    const store = newFileStore(newNodeFileStoreHost(), directory)
    await expect(store.start(background())).rejects.toMatchObject({
      code: "GO_LIKE_FILE_STORE_CORRUPTION",
      reason
    })
  })
}

test("snapshot admission classifies encoding, JSON, schema, checksum, and record corruption", async () => {
  await expectCorruption(
    (directory) => writeFile(join(directory, SnapshotName), new Uint8Array([0xc3, 0x28])),
    "encoding"
  )
  await expectCorruption((directory) => writeFile(join(directory, SnapshotName), "{"), "json")
  await expectCorruption((directory) => writeFile(join(directory, SnapshotName), "[]"), "schema")
  await expectCorruption(
    (directory) =>
      writeFile(
        join(directory, SnapshotName),
        JSON.stringify({ a: 1, records: [], revision: 0, schemaVersion: 1 })
      ),
    "schema"
  )
  await expectCorruption(
    (directory) =>
      writeFile(
        join(directory, SnapshotName),
        JSON.stringify({ schemaVersion: 1, revision: 0, records: [], checksum: "bad" })
      ),
    "checksum"
  )
  await expectCorruption(
    (directory) =>
      writeFile(
        join(directory, SnapshotName),
        JSON.stringify({ schemaVersion: 1, revision: 0, records: [], checksum: "0".repeat(64) })
      ),
    "checksum"
  )
  await expectCorruption(
    (directory) => writeSnapshot(directory, { schemaVersion: 2, revision: 0, records: [] }),
    "schema"
  )
  await expectCorruption(
    (directory) => writeSnapshot(directory, { schemaVersion: 1, revision: 1, records: [null] }),
    "record"
  )
})

test("snapshot record validation rejects every invalid persisted field and duplicate key", async () => {
  const base = {
    key: "key",
    value: "AQ==",
    metadata: {},
    revision: "1",
    expiresAt: null
  }
  const invalidRecords: readonly unknown[] = [
    { key: "key", value: "AQ==", metadata: {}, revision: "1" },
    { ...base, key: "" },
    { ...base, key: "\ud800" },
    { ...base, revision: "01" },
    { ...base, revision: "2" },
    { ...base, key: "k".repeat(4_097) },
    { ...base, metadata: null },
    { ...base, metadata: { owner: 1 } },
    { ...base, expiresAt: -1 },
    { ...base, value: "%" }
  ]
  for (const record of invalidRecords) {
    await expectCorruption(
      (directory) => writeSnapshot(directory, { schemaVersion: 1, revision: 1, records: [record] }),
      "record"
    )
  }
  await expectCorruption(
    (directory) =>
      writeSnapshot(directory, {
        schemaVersion: 1,
        revision: 1,
        records: [base, base]
      }),
    "record"
  )

  const oversized = Buffer.alloc(MaximumValueBytes + 1).toString("base64")
  await expectCorruption(
    (directory) =>
      writeSnapshot(directory, {
        schemaVersion: 1,
        revision: 1,
        records: [{ ...base, value: oversized }]
      }),
    "record"
  )
})

test("public bounds reject invalid construction, values, ttl, cursor, and exhausted revisions", async () => {
  expect(() => Reflect.apply(newFileStore, undefined, [{}, "directory"])).toThrow(TypeError)
  expect(() => newFileStore(newNodeFileStoreHost(), "")).toThrow(TypeError)
  expect(() => Reflect.apply(newFileStoreCorruptionError, undefined, ["unknown"])).toThrow(
    TypeError
  )
  expect(() => newFileStoreStateError("", "idle")).toThrow(TypeError)
  expect(() => Reflect.apply(newFileStoreStateError, undefined, ["read", "unknown"])).toThrow(
    TypeError
  )

  await withTempDirectory(async (directory) => {
    const store = newFileStore(newNodeFileStoreHost(), directory)
    const handle = await startStore(store)
    await expect(store.read(background(), "k".repeat(4_097))).rejects.toBeInstanceOf(RangeError)
    await expect(
      store.write(background(), {
        key: "oversized",
        value: new Uint8Array(MaximumValueBytes + 1)
      })
    ).rejects.toBeInstanceOf(RangeError)
    await expect(
      store.write(background(), { key: "ttl", value: new Uint8Array() }, expiresIn(2_147_483_648))
    ).rejects.toBeInstanceOf(RangeError)
    await expect(store.list(background(), limit(1_001))).rejects.toBeInstanceOf(RangeError)

    await store.write(background(), { key: "a", value: new Uint8Array([1]) })
    await store.write(background(), { key: "b", value: new Uint8Array([2]) })
    const malformed = Buffer.from(JSON.stringify({}), "utf8").toString("base64")
    await expect(store.list(background(), cursor(malformed))).rejects.toBeInstanceOf(TypeError)
    const beyond = Buffer.from(
      JSON.stringify({ version: 1, revision: 2, prefix: "", offset: 99 }),
      "utf8"
    ).toString("base64")
    await expect(store.list(background(), cursor(beyond))).rejects.toBeInstanceOf(TypeError)

    const page = await store.list(background(), limit(1))
    if (page.cursor === null) throw new Error("expected a continuation cursor")
    await store.write(background(), { key: "c", value: new Uint8Array([3]) })
    await expect(store.list(background(), cursor(page.cursor))).rejects.toBeInstanceOf(TypeError)

    const originalNow = Date.now
    Date.now = function maximumNow(): number {
      return Number.MAX_SAFE_INTEGER
    }
    try {
      await expect(
        store.write(background(), { key: "unsafe-expiry", value: new Uint8Array() }, expiresIn(1))
      ).rejects.toBeInstanceOf(RangeError)
    } finally {
      Date.now = originalNow
    }
    await stopStore(handle)
    await handle.store.stop(background())
  })

  await withTempDirectory(async (directory) => {
    await writeSnapshot(directory, {
      schemaVersion: 1,
      revision: Number.MAX_SAFE_INTEGER,
      records: []
    })
    const store = newFileStore(newNodeFileStoreHost(), directory)
    const handle = await startStore(store)
    await expect(
      store.write(background(), { key: "exhausted", value: new Uint8Array() })
    ).rejects.toBeInstanceOf(RangeError)
    await stopStore(handle)
  })
})
