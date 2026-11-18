import { expect, test } from "bun:test"

import { background } from "@go-like/core/context"

import { openVaultClient } from "../../src/client/client"
import {
  boundaryError,
  newVaultHttpError,
  newVaultProtocolError,
  newVaultTransportError,
  type VaultOperation
} from "../../src/client/errors"
import { secretBearing, vaultHeaders, vaultHttpRequest } from "../../src/client/http"
import { storeOperation, vaultKvPath } from "../../src/client/kv2"
import { vaultSource } from "../../src/config/index"
import { newVaultClient } from "../../src/index"
import * as root from "../../src/index"
import { newVaultStore } from "../../src/store/index"

const operations: readonly VaultOperation[] = [
  "config.read",
  "store.read",
  "store.write",
  "store.delete",
  "store.list"
]

test("one client is accepted by config and store and a foreign object is rejected", async () => {
  const requests: Request[] = []
  const client = newVaultClient({
    address: "https://vault.example/",
    token: "token",
    namespace: "platform",
    async fetch(request) {
      requests.push(request)
      return new Response(
        JSON.stringify({
          data: {
            data: { release: 1 },
            metadata: { version: 1, created_time: "2026-08-03T00:00:00Z" }
          }
        }),
        { status: 200 }
      )
    }
  })
  const source = vaultSource(client, { mount: "secret", path: "app/config", name: "shared" })
  expect(source.name).toBe("shared")
  await expect(source.load(background())).resolves.toMatchObject({ value: { release: 1 } })
  const store = newVaultStore(client, { mount: "secret" })
  expect(typeof store.read).toBe("function")
  await expect(store.read(background(), "orders")).rejects.toMatchObject({
    code: "GO_LIKE_VAULT_PROTOCOL",
    operation: "store.read"
  })
  expect(requests).toHaveLength(2)
  expect(requests[0]?.headers.get("X-Vault-Token")).toBe("token")
  expect(requests[0]?.headers.get("X-Vault-Namespace")).toBe("platform")
  expect(requests[1]?.headers.get("X-Vault-Token")).toBe("token")
  expect(requests[1]?.headers.get("X-Vault-Namespace")).toBe("platform")
  expect(Object.keys(root).sort()).toEqual(["newVaultClient"])
  expect(() => newVaultClient(null as never)).toThrow("options must be an object")
  expect(() => newVaultClient(1 as never)).toThrow("options must be an object")
  expect(() => vaultSource(null as never, { mount: "secret", path: "app" })).toThrow(
    "created by newVaultClient"
  )
  expect(() => vaultSource({} as never, { mount: "secret", path: "app" })).toThrow(
    "created by newVaultClient"
  )
  expect(() => newVaultStore({} as never, { mount: "secret" })).toThrow("created by newVaultClient")
  expect(() => openVaultClient(null as never)).toThrow("created by newVaultClient")
  expect(openVaultClient(client).origin).toBe("https://vault.example")
})

test("rejects malformed addresses, tokens, namespaces, and hostile accessors", () => {
  const fetch = async function fetchVault(): Promise<Response> {
    return new Response(null)
  }
  const base = { fetch, address: "https://vault.example" }
  expect(() => newVaultClient({ ...base, fetch: null as never })).toThrow("must be callable")
  for (const address of [
    1 as unknown as string,
    "not a url",
    "ftp://vault.example",
    "https://user:pass@vault.example",
    "https://vault.example/path",
    "https://vault.example?",
    "https://vault.example?query=1",
    "https://vault.example#",
    "https://vault.example#fragment"
  ]) {
    expect(() => newVaultClient({ ...base, address })).toThrow(TypeError)
  }
  for (const token of ["", "line\nbreak", "\ud800"]) {
    expect(() => newVaultClient({ ...base, token })).toThrow(TypeError)
  }
  expect(() => newVaultClient({ ...base, namespace: "" })).toThrow(TypeError)
  expect(() => newVaultClient({ ...base, namespace: "line\rbreak" })).toThrow(TypeError)
  const hostile = { ...base }
  Object.defineProperty(hostile, "address", {
    get() {
      throw new Error("secret getter value")
    }
  })
  expect(() => newVaultClient(hostile)).toThrow("options could not be read")
  try {
    newVaultClient(hostile)
    throw new Error("hostile client options were accepted")
  } catch (error) {
    expect(String(error)).not.toContain("secret getter value")
  }
})

test("builds shared headers, requests, paths, and frozen errors", () => {
  expect(secretBearing(undefined, undefined)).toBe(false)
  expect(secretBearing("token", undefined)).toBe(true)
  expect(secretBearing(undefined, "namespace")).toBe(true)
  const headers = vaultHeaders("token", "namespace", true)
  expect(headers.get("Accept")).toBe("application/json")
  expect(headers.get("Content-Type")).toBe("application/json")
  expect(headers.get("X-Vault-Token")).toBe("token")
  expect(headers.get("X-Vault-Namespace")).toBe("namespace")
  expect(vaultHeaders(undefined, undefined, false).has("X-Vault-Token")).toBe(false)
  const signal = new AbortController().signal
  const withBody = vaultHttpRequest(
    new URL(vaultKvPath("secret", "data", "app"), "https://vault.example"),
    "POST",
    headers,
    "{}",
    signal
  )
  expect(withBody.method).toBe("POST")
  expect(withBody.body).not.toBeNull()
  const withoutBody = vaultHttpRequest(
    new URL(vaultKvPath("secret", "metadata", "root"), "https://vault.example"),
    "GET",
    vaultHeaders(undefined, undefined, false),
    null,
    null
  )
  expect(withoutBody.method).toBe("GET")
  expect(withoutBody.redirect).toBe("error")
  expect(vaultKvPath("secret", "delete", "root/key")).toBe("/v1/secret/delete/root/key")
  expect(storeOperation("read")).toBe("store.read")
  expect(storeOperation("write")).toBe("store.write")
  expect(storeOperation("delete")).toBe("store.delete")
  expect(storeOperation("list")).toBe("store.list")
  const leaked = new Error("do-not-leak")
  for (const operation of operations) {
    const http = newVaultHttpError(operation, 403)
    const protocol = newVaultProtocolError(operation)
    const kept = newVaultTransportError(operation, leaked, false)
    const protectedError = newVaultTransportError(operation, leaked, true)
    const primitive = newVaultTransportError(operation, "primitive", false)
    for (const error of [http, protocol, kept, protectedError, primitive]) {
      expect(Object.isFrozen(error)).toBe(true)
      expect(error.operation).toBe(operation)
    }
    expect(http.status).toBe(403)
    expect(http.code).toBe("GO_LIKE_VAULT_HTTP")
    expect(protocol.code).toBe("GO_LIKE_VAULT_PROTOCOL")
    expect(kept.cause).toBe(leaked)
    expect(protectedError.cause).not.toBe(leaked)
    expect(protectedError.cause.message).not.toContain("do-not-leak")
    expect(JSON.stringify(protectedError)).not.toContain("do-not-leak")
    expect(primitive.cause).not.toBeInstanceOf(TypeError)
    expect(primitive.cause.message).toContain("non-Error")
  }
  expect(boundaryError(leaked, "fallback")).toBe(leaked)
  expect(boundaryError(1, "fallback").message).toBe("fallback")
})
