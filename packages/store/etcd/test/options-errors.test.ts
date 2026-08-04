import { describe, expect, test } from "bun:test"

import {
  boundaryError,
  isCompacted,
  isMissingLease,
  isUncertainFailure,
  newEtcdStoreCleanupError,
  newEtcdStoreCompactedError,
  newEtcdStoreHttpError,
  newEtcdStoreLeaseLostError,
  newEtcdStoreProtocolError,
  newEtcdStoreTransportError,
  newEtcdStoreUncertainError
} from "../src/errors"
import { captureOptions, etcdStoreOrigin } from "../src/options"

/** Calls the constructor boundary with one deliberately untyped value. */
function capture(value: unknown): unknown {
  return Reflect.apply(captureOptions, null, [value])
}

describe("construction options", () => {
  test("captures Fetch, canonical origin, and token exactly once", () => {
    let reads = 0
    const fetch = async (): Promise<Response> => new Response("{}")
    const source = {
      get fetch() {
        reads += 1
        return fetch
      },
      get address() {
        reads += 1
        return "http://example.test:2379"
      },
      get token() {
        reads += 1
        return "secret"
      }
    }
    const options = captureOptions(source)
    expect(reads).toBe(3)
    expect(options).toEqual({
      fetch,
      origin: "http://example.test:2379",
      token: "secret"
    })
    expect(Object.isFrozen(options)).toBeTrue()
    expect(etcdStoreOrigin("https://example.test:443")).toBe("https://example.test")
  })

  test("rejects malformed addresses, tokens, and Fetch capabilities", () => {
    for (const value of [null, 1, "options"]) expect(() => capture(value)).toThrow(TypeError)
    expect(() => capture({ fetch: 1, address: "http://example.test" })).toThrow(TypeError)
    for (const address of [
      1,
      "not a url",
      "ftp://example.test",
      "http://user@example.test",
      "http://example.test/path",
      "http://example.test?",
      "http://example.test#",
      "http://example.test#fragment"
    ]) {
      expect(() => capture({ fetch: async () => new Response("{}"), address })).toThrow(TypeError)
    }
    for (const token of [1, "", "line\nbreak"]) {
      expect(() =>
        capture({ fetch: async () => new Response("{}"), address: "http://example.test", token })
      ).toThrow(TypeError)
    }
    expect(
      captureOptions({ fetch: async () => new Response("{}"), address: "http://example.test" })
        .token
    ).toBeUndefined()
  })
})

describe("stable provider errors", () => {
  test("constructs immutable secret-safe public errors", () => {
    const native = new Error("native detail")
    expect(boundaryError(native, "fallback")).toBe(native)
    expect(boundaryError(null, "fallback").message).toBe("fallback")
    const errors = [
      newEtcdStoreHttpError("read", 503, 14),
      newEtcdStoreTransportError("write"),
      newEtcdStoreProtocolError("list"),
      newEtcdStoreCompactedError("7"),
      newEtcdStoreLeaseLostError(),
      newEtcdStoreUncertainError("write", null),
      newEtcdStoreCleanupError("delete", native)
    ]
    for (const error of errors) expect(Object.isFrozen(error)).toBeTrue()
    expect(errors.map((error) => error.code)).toEqual([
      "GO_LIKE_ETCD_STORE_HTTP",
      "GO_LIKE_ETCD_STORE_TRANSPORT",
      "GO_LIKE_ETCD_STORE_PROTOCOL",
      "GO_LIKE_ETCD_STORE_COMPACTED",
      "GO_LIKE_ETCD_STORE_LEASE_LOST",
      "GO_LIKE_ETCD_STORE_UNCERTAIN",
      "GO_LIKE_ETCD_STORE_CLEANUP"
    ])
    expect(JSON.stringify(errors)).not.toContain("native detail")
  })

  test("classifies uncertainty, missing leases, and compaction by stable fields", () => {
    expect(isUncertainFailure(newEtcdStoreTransportError("write"))).toBeTrue()
    expect(isUncertainFailure(newEtcdStoreProtocolError("delete"))).toBeTrue()
    for (const status of [408, 425, 429, 500]) {
      expect(isUncertainFailure(newEtcdStoreHttpError("write", status, null))).toBeTrue()
    }
    expect(isUncertainFailure(newEtcdStoreHttpError("write", 400, 3))).toBeFalse()
    expect(isUncertainFailure(null)).toBeFalse()
    expect(isUncertainFailure({ code: "other" })).toBeFalse()
    const missing = newEtcdStoreHttpError("lease-revoke", 404, 5)
    expect(isMissingLease(missing)).toBeTrue()
    expect(isMissingLease(newEtcdStoreHttpError("lease-revoke", 404, null))).toBeFalse()
    expect(isMissingLease(null)).toBeFalse()
    const compacted = newEtcdStoreHttpError("list", 400, 11)
    expect(isCompacted(compacted)).toBeTrue()
    expect(isCompacted(newEtcdStoreHttpError("list", 400, 3))).toBeFalse()
    expect(isCompacted(null)).toBeFalse()
  })
})
