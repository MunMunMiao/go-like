import { describe, expect, test } from "bun:test"

import { background, canceled, cause, withCancel, type Context } from "@go-like/core/context"

import {
  decodeBase64,
  decodeDataEnvelope,
  decodeDeletedVersion,
  decodeListKeys,
  decodeWriteVersion,
  encodeBase64,
  encodeWriteBody,
  physicalKey
} from "../../src/store/codec"
import {
  isUncertainFailure,
  newHttpError,
  newProtocolError,
  newSnapshotError,
  newTransportError,
  newUncertainError,
  normalizeError
} from "../../src/store/errors"
import type { VaultClientOptions } from "../../src/index"
import { newVaultClient } from "../../src/index"
import { deleteVault, ignoreFailure, listVault, readVault, writeVault } from "../../src/store/http"
import { captureOptions as captureVaultOptions } from "../../src/store/options"
import type { VaultStoreOptions } from "../../src/store/index"
import type { Fetch } from "@go-like/core/fetch"
import { fakeVault } from "./helpers"

const unavailable: Fetch = function unavailableFetch(): Promise<Response> {
  return Promise.resolve(new Response(null, { status: 404 }))
}

/** Captures store options from the historical combined construction object. */
function capture(value: VaultStoreOptions & VaultClientOptions) {
  return captureVaultOptions(newVaultClient(value), value)
}

describe("Vault Store construction boundaries", () => {
  test("captures a portable scoped option snapshot", () => {
    const captured = capture({
      fetch: unavailable,
      address: "https://vault.test",
      mount: "team/😀",
      root: "private/root",
      token: "token",
      namespace: "tenant",
      cursorTtlMs: 123
    })
    expect(captured).toEqual({
      fetch: unavailable,
      origin: "https://vault.test",
      mount: "team/%F0%9F%98%80",
      root: "private/root",
      token: "token",
      namespace: "tenant",
      cursorTtlMs: 123
    })
    expect(Object.isFrozen(captured)).toBeTrue()
  })

  test("rejects malformed option carriers, origins, paths, headers, and bounds", () => {
    const base = { fetch: unavailable, address: "http://vault.test", mount: "secret" }
    const client = newVaultClient(base)
    for (const value of [null, 1, "bad"]) {
      expect(() => capture(value as never)).toThrow(TypeError)
      expect(() => captureVaultOptions(client, value as never)).toThrow("options must be an object")
    }
    expect(() => capture({ ...base, fetch: 1 as never })).toThrow(TypeError)
    for (const address of [
      1,
      "not a url",
      "ftp://vault.test",
      "http://user@vault.test",
      "http://vault.test/path",
      "http://vault.test?x=1",
      "http://vault.test#",
      "http://vault.test#x"
    ]) {
      expect(() => capture({ ...base, address: address as string })).toThrow(TypeError)
    }
    for (const mount of ["", "/secret", "secret/", "a//b", "a/./b", "a/../b", "\ud800", "\udc00"]) {
      expect(() => capture({ ...base, mount })).toThrow(TypeError)
    }
    expect(() => capture({ ...base, token: "" })).toThrow(TypeError)
    expect(() => capture({ ...base, token: "bad\nvalue" })).toThrow(TypeError)
    expect(() => capture({ ...base, namespace: "" })).toThrow(TypeError)
    for (const cursorTtlMs of [0, 600_001, 1.5]) {
      expect(() => capture({ ...base, cursorTtlMs })).toThrow(RangeError)
    }
  })
})

describe("Vault Store stable errors", () => {
  test("creates frozen real Errors and classifies only uncertain failures", () => {
    const http = newHttpError("write", 503)
    const protocol = newProtocolError("read")
    const transport = newTransportError("delete", new Error("foreign"), false)
    const protectedTransport = newTransportError("list", new Error("secret"), true)
    const uncertain = newUncertainError("write", transport)
    const snapshot = newSnapshotError("capacity")
    for (const error of [http, protocol, transport, protectedTransport, uncertain, snapshot]) {
      expect(error).toBeInstanceOf(Error)
      expect(Object.isFrozen(error)).toBeTrue()
    }
    expect(transport.cause.message).toBe("foreign")
    expect(protectedTransport.cause.message).not.toContain("secret")
    expect(normalizeError("primitive")).toBeInstanceOf(Error)
    expect(isUncertainFailure("bad")).toBeFalse()
    expect(isUncertainFailure(protocol)).toBeTrue()
    expect(isUncertainFailure(transport)).toBeTrue()
    for (const status of [408, 425, 429, 500]) {
      expect(isUncertainFailure(newHttpError("write", status))).toBeTrue()
    }
    expect(isUncertainFailure(newHttpError("write", 400))).toBeFalse()
    expect(isUncertainFailure({ code: "GO_LIKE_VAULT_STORE_HTTP", status: 503 })).toBeFalse()
    expect(isUncertainFailure({ code: "GO_LIKE_VAULT_STORE_TRANSPORT" })).toBeFalse()
    expect(isUncertainFailure({ code: "GO_LIKE_VAULT_STORE_PROTOCOL" })).toBeFalse()
  })

  test("rejects invalid error factory details", () => {
    expect(() => newHttpError("read", 99)).toThrow(TypeError)
    expect(() => newProtocolError("bad" as never)).toThrow(TypeError)
    expect(() => newTransportError("bad" as never, null, false)).toThrow(TypeError)
    expect(() => newUncertainError("bad" as never, new Error())).toThrow(TypeError)
    expect(() => newUncertainError("write", null as never)).toThrow(TypeError)
    expect(() => newSnapshotError("bad" as never)).toThrow(TypeError)
  })
})

describe("Vault Store wire codec", () => {
  test("round-trips canonical bytes, logical keys, and complete envelopes", () => {
    expect(decodeBase64(encodeBase64(Uint8Array.of(0, 255)), "read")).toEqual(Uint8Array.of(0, 255))
    expect(physicalKey("中/😀")).toMatch(/^[A-Za-z0-9_-]+$/)
    const body = JSON.parse(
      encodeWriteBody({ key: "key", value: Uint8Array.of(1), metadata: { owner: "a" } }, "op")
    )
    const carrier = body.data
    const row = decodeDataEnvelope(
      { data: { data: carrier, metadata: { version: 2 } } },
      "key",
      "read"
    )
    expect(row.record).toMatchObject({ key: "key", revision: "2", metadata: { owner: "a" } })
    expect(row.operation).toBe("op")
    expect(decodeWriteVersion({ data: { version: 3 } })).toBe("3")
    expect(
      decodeListKeys({ data: { keys: [physicalKey("a"), physicalKey("中")] } }, "list")
    ).toEqual(["a", "中"])
    expect(
      decodeDeletedVersion({ data: { metadata: { version: 2, deletion_time: "now" } } }, 2)
    ).toBeTrue()
    expect(
      decodeDeletedVersion({ data: { metadata: { version: 2, deletion_time: "" } } }, 2)
    ).toBeFalse()
  })

  test("rejects non-canonical base64, keys, envelopes, metadata, and versions", () => {
    expect(() => decodeBase64("!", "read")).toThrow()
    expect(() => decodeBase64("Zh==", "read")).toThrow()
    const nativeAtob = globalThis.atob
    globalThis.atob = function brokenAtob(): string {
      throw new Error("broken")
    }
    try {
      expect(() => decodeBase64("Zg==", "read")).toThrow()
    } finally {
      globalThis.atob = nativeAtob
    }
    for (const key of ["", "\ud800", "\udc00", "x".repeat(1025)]) {
      expect(() => physicalKey(key)).toThrow()
    }
    expect(() => encodeWriteBody({ key: "x", value: new Uint8Array(1_048_577) }, "op")).toThrow(
      RangeError
    )
    expect(() => encodeWriteBody({ key: "x", value: Uint8Array.of(1) }, "")).toThrow(TypeError)
    const malformedData: unknown[] = [
      null,
      {},
      { data: null },
      { data: { data: null, metadata: {} } },
      { data: { data: { version: 0 }, metadata: {} } },
      { data: { data: { version: 1, operation: "" }, metadata: { version: 1 } } },
      {
        data: {
          data: { version: 1, operation: "op", value: "!", metadata: {} },
          metadata: { version: 1 }
        }
      },
      {
        data: {
          data: { version: 1, operation: "op", value: "AQ==", metadata: { x: 1 } },
          metadata: { version: 1 }
        }
      },
      {
        data: {
          data: { version: 1, operation: "op", value: "AQ==", metadata: {} },
          metadata: { version: 0 }
        }
      }
    ]
    for (const value of malformedData)
      expect(() => decodeDataEnvelope(value, "x", "read")).toThrow()
    for (const value of [null, {}, { data: null }, { data: {} }]) {
      expect(() => decodeWriteVersion(value)).toThrow()
    }
    for (const value of [
      null,
      {},
      { data: null },
      { data: {} },
      { data: { keys: ["!"] } },
      { data: { keys: ["_w"] } },
      { data: { keys: ["Zh"] } },
      { data: { keys: [physicalKey("a"), physicalKey("a")] } }
    ]) {
      expect(() => decodeListKeys(value, "list")).toThrow()
    }
    for (const value of [
      null,
      {},
      { data: null },
      { data: { metadata: null } },
      { data: { metadata: { version: 1, deletion_time: "" } } },
      { data: { metadata: { version: 2, deletion_time: 1 } } }
    ]) {
      expect(() => decodeDeletedVersion(value, 2)).toThrow()
    }
  })
})

describe("Vault Store HTTP boundary", () => {
  test("sends scoped credentials only in headers and rejects redirects/status", async () => {
    expect(ignoreFailure(new Error("ignored"))).toBeUndefined()
    const observed: Request[] = []
    const options = capture({
      fetch(request) {
        observed.push(request.clone())
        return Promise.resolve(new Response("denied", { status: 403 }))
      },
      address: "http://vault.test",
      mount: "secret",
      token: "token",
      namespace: "tenant"
    })
    await expect(listVault(background(), options)).rejects.toMatchObject({
      code: "GO_LIKE_VAULT_HTTP",
      operation: "store.list",
      status: 403
    })
    expect(observed[0]?.redirect).toBe("error")
    expect(observed[0]?.headers.get("X-Vault-Token")).toBe("token")
    expect(observed[0]?.headers.get("X-Vault-Namespace")).toBe("tenant")
    expect(observed[0]?.url).not.toContain("token")
  })

  test("normalizes sync, async, protected, non-Response, body, JSON, and Context failures", async () => {
    const sync = capture({
      fetch() {
        throw new Error("sync")
      },
      address: "http://vault.test",
      mount: "secret"
    })
    await expect(listVault(background(), sync)).rejects.toMatchObject({
      code: "GO_LIKE_VAULT_TRANSPORT"
    })
    const asyncFailure = capture({
      fetch() {
        return Promise.reject(new Error("namespace-secret"))
      },
      address: "http://vault.test",
      mount: "secret",
      namespace: "private"
    })
    const protectedError = await listVault(background(), asyncFailure).catch((value) => value)
    expect(protectedError.cause.message).not.toContain("namespace-secret")
    const nonResponse = capture({
      fetch() {
        return Promise.resolve({} as Response)
      },
      address: "http://vault.test",
      mount: "secret"
    })
    await expect(listVault(background(), nonResponse)).rejects.toMatchObject({
      code: "GO_LIKE_VAULT_PROTOCOL"
    })
    for (const mode of ["sync", "async"] as const) {
      const response = Response.json({ data: { keys: [] } })
      Object.defineProperty(response, "text", {
        value:
          mode === "sync"
            ? function brokenText(): string {
                throw new Error("body")
              }
            : function rejectedText(): Promise<string> {
                return Promise.reject(new Error("body"))
              }
      })
      const options = capture({
        fetch: () => Promise.resolve(response),
        address: "http://vault.test",
        mount: "secret"
      })
      await expect(listVault(background(), options)).rejects.toMatchObject({
        code: "GO_LIKE_VAULT_PROTOCOL"
      })
    }
    const invalidJson = capture({
      fetch: () => Promise.resolve(new Response("{")),
      address: "http://vault.test",
      mount: "secret"
    })
    await expect(listVault(background(), invalidJson)).rejects.toMatchObject({
      code: "GO_LIKE_VAULT_PROTOCOL"
    })
    const [ctx, cancel] = withCancel(background())
    const canceledResponse = new Response("{")
    Object.defineProperty(canceledResponse, "text", {
      value(): Promise<string> {
        cancel()
        return Promise.resolve("{")
      }
    })
    const observed = await listVault(
      ctx,
      capture({
        fetch: () => Promise.resolve(canceledResponse),
        address: "http://vault.test",
        mount: "secret"
      })
    ).catch((value) => value)
    expect(observed).toBe(cause(ctx) ?? ctx.err())
  })

  test("covers list, read, and mutation protocol/status boundaries", async () => {
    const backend = fakeVault()
    const options = capture({
      fetch: backend.fetch,
      address: "http://vault.test",
      mount: "secret"
    })
    expect(await listVault(background(), options)).toEqual([])
    backend.setFailure("deny")
    await expect(listVault(background(), options)).rejects.toMatchObject({ status: 403 })
    backend.setFailure("deny")
    await expect(readVault(background(), options, "x", "read")).rejects.toMatchObject({
      status: 403
    })
    backend.setFailure("malformed-list")
    await expect(listVault(background(), options)).rejects.toMatchObject({
      operation: "store.list"
    })
    await writeVault(background(), options, { key: "x", value: Uint8Array.of(1) })
    backend.setFailure("malformed-read")
    await expect(readVault(background(), options, "x", "read")).rejects.toMatchObject({
      code: "GO_LIKE_VAULT_PROTOCOL"
    })
    backend.setFailure("malformed-write")
    expect(
      (await writeVault(background(), options, { key: "malformed", value: Uint8Array.of(1) }))
        .record.key
    ).toBe("malformed")
  })

  test("fails closed when uncertain mutation readback itself fails", async () => {
    let calls = 0
    const options = capture({
      fetch() {
        calls += 1
        if (calls === 1) return Promise.reject(new Error("lost"))
        return Promise.resolve(new Response(null, { status: 403 }))
      },
      address: "http://vault.test",
      mount: "secret"
    })
    await expect(
      writeVault(background(), options, { key: "x", value: Uint8Array.of(1) })
    ).rejects.toMatchObject({
      code: "GO_LIKE_VAULT_STORE_UNCERTAIN"
    })

    calls = 0
    const deleteOptions = capture({
      fetch() {
        calls += 1
        if (calls === 1) return Promise.reject(new Error("lost"))
        return Promise.resolve(new Response(null, { status: 403 }))
      },
      address: "http://vault.test",
      mount: "secret"
    })
    await expect(deleteVault(background(), deleteOptions, "x", 1)).rejects.toMatchObject({
      code: "GO_LIKE_VAULT_STORE_UNCERTAIN"
    })
  })

  test("preserves post-response cancellation and proves an absent deleted version", async () => {
    let inspections = 0
    const ctx: Context = {
      deadline() {
        return [new Date(0), false]
      },
      done() {
        return null
      },
      err() {
        inspections += 1
        return inspections >= 3 ? canceled : null
      },
      value() {
        return null
      }
    }
    const response = new Response("body")
    if (response.body === null) throw new Error("test response body missing")
    Object.defineProperty(response.body, "cancel", {
      value(): Promise<void> {
        throw new Error("cancel failed")
      }
    })
    await expect(
      listVault(
        ctx,
        capture({
          fetch: () => Promise.resolve(response),
          address: "http://vault.test",
          mount: "secret"
        })
      )
    ).rejects.toBe(canceled)

    let calls = 0
    const options = capture({
      fetch() {
        calls += 1
        return calls === 1
          ? Promise.reject(new Error("lost"))
          : Promise.resolve(new Response(null, { status: 404 }))
      },
      address: "http://vault.test",
      mount: "secret"
    })
    await expect(deleteVault(background(), options, "gone", 1)).resolves.toBeUndefined()
  })
})
