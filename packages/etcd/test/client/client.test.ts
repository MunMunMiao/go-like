import { expect, test } from "bun:test"

import { etcdSource } from "../../src/config/index"
import {
  boundaryError,
  newEtcdHttpError,
  newEtcdProtocolError,
  newEtcdTransportError
} from "../../src/client/errors"
import { etcdHeaders, etcdUrl, grpcCode } from "../../src/client/http"
import { openEtcdClient } from "../../src/client/client"
import { newEtcdClient } from "../../src/index"
import * as root from "../../src/index"
import { captureOptions } from "../../src/registry/options"
import { newEtcdRegistry } from "../../src/registry/index"
import { newEtcdStore } from "../../src/store/index"

const fetch = async function fetchEtcd(): Promise<Response> {
  return new Response(null)
}

test("one client is accepted by every socket and a foreign object is rejected", () => {
  let reads = 0
  const client = newEtcdClient({
    get fetch() {
      reads += 1
      return fetch
    },
    get address() {
      reads += 1
      return "https://example.test:443"
    },
    get token() {
      reads += 1
      return "raw-token"
    }
  })
  expect(reads).toBe(3)
  expect(openEtcdClient(client)).toEqual({
    fetch,
    origin: "https://example.test",
    token: "raw-token"
  })
  expect(Object.isFrozen(client)).toBe(true)
  expect(Object.keys(client)).toEqual([])
  expect(Object.keys(newEtcdRegistry(client)).sort()).toEqual([
    "deregister",
    "getService",
    "register",
    "watch"
  ])
  expect(etcdSource(client, { key: "app/config" }).name).toBe("etcd")
  expect(typeof newEtcdStore(client).write).toBe("function")
  expect(() => captureOptions(client, null as never)).toThrow("must be an object")
  expect(() => newEtcdRegistry({} as never)).toThrow("Etcd client must be created by newEtcdClient")
  expect(() => newEtcdStore({} as never)).toThrow("Etcd client must be created by newEtcdClient")
  expect(() => etcdSource({} as never, { key: "app/config" })).toThrow(
    "Etcd client must be created by newEtcdClient"
  )
  expect(() => openEtcdClient(null as never)).toThrow(
    "Etcd client must be created by newEtcdClient"
  )
  expect(() => openEtcdClient(1 as never)).toThrow("Etcd client must be created by newEtcdClient")
  expect(Object.keys(root).sort()).toEqual(["newEtcdClient"])
})

test("validates the connection once before any I/O", () => {
  expect(() => newEtcdClient(null as never)).toThrow("etcd client options must be an object")
  expect(() => newEtcdClient({ fetch: 1 as never, address: "http://example.test" })).toThrow(
    "etcd Fetch capability must be callable"
  )
  expect(() => newEtcdClient({ fetch, address: 1 as never })).toThrow(
    "etcd address must be a string"
  )
  expect(() => newEtcdClient({ fetch, address: "not a url" })).toThrow(
    "etcd address must be a valid HTTP or HTTPS origin"
  )
  expect(() => newEtcdClient({ fetch, address: "ftp://example.test" })).toThrow(
    "etcd address must use HTTP or HTTPS"
  )
  for (const address of [
    "http://user@example.test",
    "http://:secret@example.test",
    "http://example.test/path",
    "http://example.test?",
    "http://example.test#fragment"
  ]) {
    expect(() => newEtcdClient({ fetch, address })).toThrow(
      "etcd address must be an origin without credentials, path, query, or fragment"
    )
  }
  for (const token of ["", "bad\r\n", 1]) {
    expect(() =>
      newEtcdClient({ fetch, address: "http://example.test", token: token as never })
    ).toThrow("etcd token must be a non-empty HTTP header value")
  }
  expect(() => newEtcdClient({ fetch, address: "http://example.test", token: "\u0000" })).toThrow(
    "etcd token must be a valid HTTP header value"
  )
  const plain = newEtcdClient({ fetch, address: "http://example.test:80/" })
  expect(openEtcdClient(plain).token).toBeUndefined()
  expect(openEtcdClient(plain).origin).toBe("http://example.test")
})

test("sends the raw token and builds gateway URLs", () => {
  const headers = etcdHeaders("raw-token")
  expect(headers.get("Authorization")).toBe("raw-token")
  expect(headers.get("Content-Type")).toBe("application/json")
  expect(etcdHeaders(undefined).has("Authorization")).toBe(false)
  expect(etcdUrl("http://example.test", "/v3/kv/range").href).toBe(
    "http://example.test/v3/kv/range"
  )
})

test("builds frozen shared errors and reads a bounded gRPC code", () => {
  const native = new Error("native-secret")
  const http = newEtcdHttpError("store.read", 503, 14)
  const kept = newEtcdTransportError("config.range", native, false)
  const stripped = newEtcdTransportError("registry.txn", native, true)
  const foreign = newEtcdTransportError("store.write", "nope", false)
  const protocol = newEtcdProtocolError("config.watch")
  for (const error of [http, kept, stripped, foreign, protocol]) {
    expect(Object.isFrozen(error)).toBe(true)
  }
  expect(http).toMatchObject({
    name: "EtcdHttpError",
    code: "GO_LIKE_ETCD_HTTP",
    operation: "store.read",
    status: 503,
    grpcCode: 14
  })
  expect(kept.cause).toBe(native)
  expect(kept.code).toBe("GO_LIKE_ETCD_TRANSPORT")
  expect(stripped.cause.message).toContain("secret-bearing")
  expect(String(stripped.cause)).not.toContain("native-secret")
  expect(foreign.cause.message).toContain("non-Error")
  expect(protocol).toMatchObject({
    name: "EtcdProtocolError",
    code: "GO_LIKE_ETCD_PROTOCOL",
    operation: "config.watch"
  })
  expect(boundaryError(native, "fallback")).toBe(native)
  expect(boundaryError(null, "fallback").message).toBe("fallback")
  expect(grpcCode('{"code":5}')).toBe(5)
  expect(grpcCode("not-json")).toBeNull()
  expect(grpcCode("null")).toBeNull()
  expect(grpcCode("[]")).toBeNull()
  expect(grpcCode("true")).toBeNull()
  expect(grpcCode('{"code":"5"}')).toBeNull()
  expect(grpcCode('{"code":1.5}')).toBeNull()
  expect(grpcCode(`{"padding":"${"x".repeat(65_536)}"}`)).toBeNull()
})
