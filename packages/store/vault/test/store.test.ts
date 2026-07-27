import { describe, expect, test } from "bun:test"

import { background } from "@likego/context"
import { cursor, expiresIn, ifRevision, limit, prefix } from "@likego/store"

import { newVaultStore } from "../src/index"
import { physicalKey } from "../src/codec"
import { fakeVault } from "./helpers"

function input(key: string, value = Uint8Array.of(1), metadata = { owner: "test" }) {
  return { key, value, metadata }
}

describe("Vault Store CRUD", () => {
  test("uses an empty root immediately and returns defensive records", async () => {
    const backend = fakeVault()
    const store = newVaultStore({
      fetch: backend.fetch,
      address: "http://vault.test",
      mount: "secret"
    })
    expect(store.string()).toBe("vault")
    expect((await store.list(background())).records).toEqual([])
    expect(await store.read(background(), "missing")).toBeNull()
    const bytes = Uint8Array.of(1, 2)
    const metadata = { owner: "first" }
    const first = await store.write(background(), input("orders/1", bytes, metadata))
    bytes[0] = 9
    metadata.owner = "changed"
    expect(first.value).toEqual(Uint8Array.of(1, 2))
    expect(first.metadata).toEqual({ owner: "first" })
    const exposed = first.value
    exposed[0] = 8
    expect(first.value[0]).toBe(1)
    const second = await store.write(background(), input("orders/1", Uint8Array.of(3)))
    expect(second.revision).not.toBe(first.revision)
    expect((await store.read(background(), "orders/1"))?.value).toEqual(Uint8Array.of(3))
    expect(await store.delete(background(), "orders/1")).toBeTrue()
    expect(await store.delete(background(), "orders/1")).toBeFalse()
  })

  test("fails unsupported TTL and CAS before provider I/O", async () => {
    const backend = fakeVault()
    const store = newVaultStore({
      fetch: backend.fetch,
      address: "http://vault.test",
      mount: "secret"
    })
    const baseline = backend.requests.length
    await expect(store.write(background(), input("ttl"), expiresIn(1))).rejects.toBeInstanceOf(
      TypeError
    )
    await expect(store.write(background(), input("cas"), ifRevision("1"))).rejects.toBeInstanceOf(
      TypeError
    )
    await expect(store.delete(background(), "cas", ifRevision("1"))).rejects.toBeInstanceOf(
      TypeError
    )
    expect(backend.requests).toHaveLength(baseline)
  })
})

describe("Vault Store list snapshots", () => {
  test("sorts, filters, and continues without further Vault I/O", async () => {
    const backend = fakeVault()
    const store = newVaultStore({
      fetch: backend.fetch,
      address: "http://vault.test",
      mount: "secret"
    })
    for (const key of ["list/z", "list/😀", "other/a", "list/a", "list/中"]) {
      await store.write(background(), input(key))
    }
    const first = await store.list(background(), prefix("list/"), limit(1))
    expect(first.records.map((record) => record.key)).toEqual(["list/a"])
    expect(first.cursor).not.toBeNull()
    const before = backend.requests.length
    const second = await store.list(background(), prefix("list/"), limit(1), cursor(first.cursor!))
    expect(second.records.map((record) => record.key)).toEqual(["list/z"])
    expect(second.cursor).not.toBeNull()
    const third = await store.list(background(), prefix("list/"), cursor(second.cursor!))
    expect(third.records.map((record) => record.key)).toEqual(["list/中", "list/😀"])
    expect(third.cursor).toBeNull()
    expect(backend.requests).toHaveLength(before)
  })

  test("rejects one-shot, prefix-substituted, expired, and excessive cursors", async () => {
    const backend = fakeVault()
    const store = newVaultStore({
      fetch: backend.fetch,
      address: "http://vault.test",
      mount: "secret"
    })
    await store.write(background(), input("a"))
    await store.write(background(), input("b"))
    const substituted = await store.list(background(), limit(1))
    await expect(
      store.list(background(), prefix("x"), cursor(substituted.cursor!))
    ).rejects.toMatchObject({
      code: "LIKEGO_VAULT_STORE_SNAPSHOT",
      reason: "invalid-cursor"
    })
    await expect(store.list(background(), cursor(substituted.cursor!))).rejects.toMatchObject({
      reason: "invalid-cursor"
    })
    await expect(store.list(background(), limit(1001))).rejects.toBeInstanceOf(RangeError)

    const expiringStore = newVaultStore({
      fetch: backend.fetch,
      address: "http://vault.test",
      mount: "secret",
      cursorTtlMs: 1
    })
    const expired = await expiringStore.list(background(), limit(1))
    await Bun.sleep(5)
    await expect(expiringStore.list(background(), cursor(expired.cursor!))).rejects.toMatchObject({
      reason: "expired-cursor"
    })
  })

  test("bounds simultaneously retained snapshots", async () => {
    const backend = fakeVault()
    const store = newVaultStore({
      fetch: backend.fetch,
      address: "http://vault.test",
      mount: "secret"
    })
    await store.write(background(), input("a"))
    await store.write(background(), input("b"))
    for (let index = 0; index < 64; index += 1) {
      expect((await store.list(background(), limit(1))).cursor).not.toBeNull()
    }
    await expect(store.list(background(), limit(1))).rejects.toMatchObject({ reason: "capacity" })
  })
})

describe("Vault Store mutation certainty", () => {
  test("proves committed writes and deletes after transport/status loss", async () => {
    for (const mode of ["write-lost-after", "write-503-after"] as const) {
      const backend = fakeVault()
      const store = newVaultStore({
        fetch: backend.fetch,
        address: "http://vault.test",
        mount: "secret"
      })
      backend.setFailure(mode)
      expect((await store.write(background(), input(mode))).key).toBe(mode)
    }
    for (const mode of ["delete-lost-after", "delete-503-after"] as const) {
      const backend = fakeVault()
      const store = newVaultStore({
        fetch: backend.fetch,
        address: "http://vault.test",
        mount: "secret"
      })
      await store.write(background(), input(mode))
      backend.setFailure(mode)
      expect(await store.delete(background(), mode)).toBeTrue()
    }
  })

  test("fails closed when mutation readback cannot prove an outcome", async () => {
    const backend = fakeVault()
    const store = newVaultStore({
      fetch: backend.fetch,
      address: "http://vault.test",
      mount: "secret"
    })
    backend.setFailure("write-lost-before")
    await expect(store.write(background(), input("write"))).rejects.toMatchObject({
      code: "LIKEGO_VAULT_STORE_UNCERTAIN",
      operation: "write"
    })
    await store.write(background(), input("delete"))
    backend.setFailure("delete-lost-before")
    await expect(store.delete(background(), "delete")).rejects.toMatchObject({
      code: "LIKEGO_VAULT_STORE_UNCERTAIN",
      operation: "delete"
    })
  })

  test("deletes only the observed version when a concurrent writer wins", async () => {
    const backend = fakeVault()
    const store = newVaultStore({
      fetch: backend.fetch,
      address: "http://vault.test",
      mount: "secret"
    })
    await store.write(background(), input("race"))
    backend.setFailure("concurrent-before-delete")
    expect(await store.delete(background(), "race")).toBeTrue()
    expect((await store.read(background(), "race"))?.value).toEqual(Uint8Array.of(9))
    expect(backend.visible(physicalKey("race"))?.version).toBe(2)
  })
})

describe("Vault Store protocol cleanup", () => {
  test("rejects a malformed data envelope through the public Store boundary", async () => {
    const backend = fakeVault()
    const store = newVaultStore({
      fetch: backend.fetch,
      address: "http://vault.test",
      mount: "secret"
    })
    backend.setFailure("malformed-read")
    await expect(store.read(background(), "malformed")).rejects.toMatchObject({
      code: "LIKEGO_VAULT_STORE_PROTOCOL",
      operation: "read"
    })
  })

  test("observes a rejected best-effort response body cancellation", async () => {
    const cancellationFailure = new Error("published body cancellation failed")
    let cancellations = 0
    const store = newVaultStore({
      fetch() {
        return Promise.resolve(
          new Response(
            new ReadableStream({
              cancel(): Promise<never> {
                cancellations += 1
                return Promise.reject(cancellationFailure)
              }
            }),
            { status: 403 }
          )
        )
      },
      address: "http://vault.test",
      mount: "secret"
    })
    await expect(store.read(background(), "denied")).rejects.toMatchObject({
      code: "LIKEGO_VAULT_STORE_HTTP",
      operation: "read",
      status: 403
    })
    await Promise.resolve()
    expect(cancellations).toBe(1)
  })
})
