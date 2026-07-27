import { describe, expect, test } from "bun:test"

import {
  boundaryError,
  isUncertainFailure,
  newConsulStoreHttpError,
  newConsulStoreProtocolError,
  newConsulStoreTransportError,
  newConsulStoreUncertainError,
  newConsulStoreUnsupportedCombinationError
} from "../src/errors"
import { captureOptions, consulOrigin, consulRoot } from "../src/options"

describe("Consul Store construction options", () => {
  test("captures each option getter once and canonicalizes only the HTTP origin", () => {
    const reads: Record<string, number> = {}
    const values: Record<string, unknown> = {
      fetch: async function borrowedFetch(): Promise<Response> {
        return new Response(null, { status: 404 })
      },
      address: "HTTPS://CONSUL.EXAMPLE:443",
      root: "/teams/payments/",
      token: "secret",
      datacenter: "dc-west",
      namespace: "payments"
    }
    const options: Record<string, unknown> = {}
    for (const key of Object.keys(values)) {
      Object.defineProperty(options, key, {
        enumerable: true,
        /** Returns one controlled option while recording the exact snapshot count. */
        get(): unknown {
          reads[key] = (reads[key] ?? 0) + 1
          return values[key]
        }
      })
    }

    const captured = captureOptions(options as never)
    expect(reads).toEqual({ fetch: 1, address: 1, root: 1, token: 1, datacenter: 1, namespace: 1 })
    expect(captured).toMatchObject({
      origin: "https://consul.example",
      root: "teams/payments",
      token: "secret",
      datacenter: "dc-west",
      namespace: "payments"
    })
    expect(Object.isFrozen(captured)).toBe(true)
  })

  test("rejects non-object options, non-Fetch capabilities, and unsafe scopes", () => {
    expect(() => captureOptions(null as never)).toThrow("options must be an object")
    expect(() => captureOptions({ fetch: 1, address: "http://consul.test" } as never)).toThrow(
      "Fetch must be callable"
    )
    const fetch = async function fetchConsul(): Promise<Response> {
      return new Response(null, { status: 404 })
    }
    for (const options of [
      { fetch, address: "http://consul.test", token: "" },
      { fetch, address: "http://consul.test", token: "a\nb" },
      { fetch, address: "http://consul.test", datacenter: "" },
      { fetch, address: "http://consul.test", namespace: 1 },
      { fetch, address: "http://consul.test", root: 1 },
      { fetch, address: "http://consul.test", root: "/" },
      { fetch, address: "http://consul.test", root: "a//b" },
      { fetch, address: "http://consul.test", root: "a/./b" },
      { fetch, address: "http://consul.test", root: "a/../b" },
      { fetch, address: "http://consul.test", root: "\ud800" }
    ]) {
      expect(() => captureOptions(options as never)).toThrow(TypeError)
    }
  })

  test("defaults, normalizes, and bounds the isolated KV root", () => {
    expect(consulRoot(undefined)).toBe("likego/store")
    expect(consulRoot("///tenant/订单///")).toBe("tenant/订单")
    expect(() => consulRoot("x".repeat(1_025))).toThrow("root exceeds 1024 UTF-8 bytes")
  })

  test("rejects adversarial separators within a bounded time", () => {
    const root = `tenant${"/".repeat(64_000)}key`
    const startedAt = performance.now()

    expect(() => consulRoot(root)).toThrow("empty or dot path segments")
    expect(performance.now() - startedAt).toBeLessThan(250)
  })

  test("accepts only credentials-free path-free HTTP or HTTPS origins", () => {
    expect(consulOrigin("http://consul.test:8500/")).toBe("http://consul.test:8500")
    for (const address of [
      1,
      "not a url",
      "ftp://consul.test",
      "http://user@consul.test",
      "http://consul.test/v1",
      "http://consul.test?dc=one",
      "http://consul.test#fragment"
    ]) {
      expect(() => consulOrigin(address as never)).toThrow(TypeError)
    }
  })
})

describe("Consul Store stable provider errors", () => {
  test("creates frozen status-only HTTP and body-independent protocol errors", () => {
    const http = newConsulStoreHttpError("read", 403)
    expect(http).toMatchObject({
      name: "ConsulStoreHttpError",
      code: "LIKEGO_CONSUL_STORE_HTTP",
      operation: "read",
      status: 403
    })
    expect(Object.isFrozen(http)).toBe(true)
    expect(http.message).not.toContain("ACL body")

    const protocol = newConsulStoreProtocolError("list")
    expect(protocol).toMatchObject({
      name: "ConsulStoreProtocolError",
      code: "LIKEGO_CONSUL_STORE_PROTOCOL",
      operation: "list"
    })
    expect(Object.isFrozen(protocol)).toBe(true)
  })

  test("retains ordinary transport causes but replaces secret-bearing rejection graphs", () => {
    const native = new Error("network refused")
    const ordinary = newConsulStoreTransportError("read", native, false)
    expect(ordinary.cause).toBe(native)
    expect(boundaryError(native, "fallback")).toBe(native)

    const secret = "sensitive-token"
    const carrier = new Error(`failed ${secret}`)
    Object.assign(carrier, {
      request: new Request("http://consul.test", { headers: { Authorization: secret } })
    })
    const sanitized = newConsulStoreTransportError("write", carrier, true)
    expect(sanitized.cause).not.toBe(carrier)
    expect(JSON.stringify(sanitized)).not.toContain(secret)
    expect(String(sanitized)).not.toContain(secret)
    expect(String(sanitized.cause)).not.toContain(secret)

    const nonError = newConsulStoreTransportError("delete", 42, false)
    expect(nonError.cause.message).toContain("non-Error value")
    expect(boundaryError(42, "fallback").message).toBe("fallback")
  })

  test("classifies only transport, protocol, and retryable HTTP mutation uncertainty", () => {
    expect(isUncertainFailure(null)).toBe(false)
    expect(isUncertainFailure({})).toBe(false)
    expect(isUncertainFailure(newConsulStoreTransportError("write", 1, false))).toBe(true)
    expect(isUncertainFailure(newConsulStoreProtocolError("write"))).toBe(true)
    for (const status of [408, 425, 429, 500, 599]) {
      expect(isUncertainFailure(newConsulStoreHttpError("write", status))).toBe(true)
    }
    for (const status of [400, 404, 409, 499]) {
      expect(isUncertainFailure(newConsulStoreHttpError("write", status))).toBe(false)
    }
    expect(isUncertainFailure({ code: "LIKEGO_CONSUL_STORE_HTTP", status: "500" })).toBe(false)
  })

  test("creates stable uncertain and fail-closed unsupported-combination errors", () => {
    const uncertain = newConsulStoreUncertainError("session-create", "lost")
    expect(uncertain).toMatchObject({
      name: "ConsulStoreUncertainError",
      code: "LIKEGO_CONSUL_STORE_UNCERTAIN",
      operation: "session-create"
    })
    expect(uncertain.cause).toBeInstanceOf(Error)
    expect(Object.isFrozen(uncertain)).toBe(true)

    for (const combination of ["ttl-cas", "cas-existing-ttl"] as const) {
      const unsupported = newConsulStoreUnsupportedCombinationError(combination)
      expect(unsupported).toMatchObject({
        name: "ConsulStoreUnsupportedCombinationError",
        code: "LIKEGO_CONSUL_STORE_UNSUPPORTED_COMBINATION",
        combination
      })
      expect(Object.isFrozen(unsupported)).toBe(true)
    }
    expect(() => newConsulStoreUnsupportedCombinationError("invalid" as never)).toThrow(
      "unsupported combination is invalid"
    )
  })
})
