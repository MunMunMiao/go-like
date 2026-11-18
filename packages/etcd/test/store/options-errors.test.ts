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
} from "../../src/store/errors"
import { newEtcdClient } from "../../src/index"
import { captureOptions } from "../../src/store/options"

describe("construction options", () => {
  test("copies the shared client connection and rejects a foreign object", () => {
    const fetch = async (): Promise<Response> => new Response("{}")
    const client = newEtcdClient({
      fetch,
      address: "http://example.test:2379",
      token: "secret"
    })
    const options = captureOptions(client)
    expect(options).toEqual({
      fetch,
      origin: "http://example.test:2379",
      token: "secret"
    })
    expect(Object.isFrozen(options)).toBeTrue()
    expect(() => captureOptions({} as never)).toThrow(TypeError)
  })
})

describe("stable provider errors", () => {
  test("constructs immutable secret-safe public errors", () => {
    const native = new Error("native detail")
    expect(boundaryError(native, "fallback")).toBe(native)
    expect(boundaryError(null, "fallback").message).toBe("fallback")
    const errors = [
      newEtcdStoreHttpError("read", 503, 14),
      newEtcdStoreTransportError("write", native, false),
      newEtcdStoreProtocolError("list"),
      newEtcdStoreCompactedError("7"),
      newEtcdStoreLeaseLostError(),
      newEtcdStoreUncertainError("write", null),
      newEtcdStoreCleanupError("delete", native)
    ]
    for (const error of errors) expect(Object.isFrozen(error)).toBeTrue()
    expect(errors.map((error) => error.code)).toEqual([
      "GO_LIKE_ETCD_HTTP",
      "GO_LIKE_ETCD_TRANSPORT",
      "GO_LIKE_ETCD_PROTOCOL",
      "GO_LIKE_ETCD_STORE_COMPACTED",
      "GO_LIKE_ETCD_STORE_LEASE_LOST",
      "GO_LIKE_ETCD_STORE_UNCERTAIN",
      "GO_LIKE_ETCD_STORE_CLEANUP"
    ])
    expect(JSON.stringify(errors)).not.toContain("native detail")
  })

  test("classifies uncertainty, missing leases, and compaction by stable fields", () => {
    expect(
      isUncertainFailure(newEtcdStoreTransportError("write", new Error("lost"), false))
    ).toBeTrue()
    expect(isUncertainFailure(newEtcdStoreProtocolError("delete"))).toBeTrue()
    for (const status of [408, 425, 429, 500]) {
      expect(isUncertainFailure(newEtcdStoreHttpError("write", status, null))).toBeTrue()
    }
    expect(isUncertainFailure(newEtcdStoreHttpError("write", 400, 3))).toBeFalse()
    expect(isUncertainFailure(null)).toBeFalse()
    expect(isUncertainFailure({ code: "other" })).toBeFalse()
    expect(isUncertainFailure({ code: "GO_LIKE_ETCD_STORE_HTTP", status: 500 })).toBeFalse()
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
