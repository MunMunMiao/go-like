import type { Discovery } from "@go-like/registry"
import { expect, test } from "bun:test"

import { clientOptions, withDiscovery, withEndpoint } from "../src/options"

const discovery = {
  getService(): never {
    throw new Error("getService should not run")
  },
  watch(): never {
    throw new Error("watch should not run")
  }
} as unknown as Discovery

test("withEndpoint canonicalizes one direct gRPC root and parses discovery:///", () => {
  expect(clientOptions([withEndpoint("https://rpc.example.test")])).toMatchObject({
    addresses: ["https://rpc.example.test/"],
    service: null
  })
  expect(
    clientOptions([withEndpoint(["https://one.example.test", "http://two.example.test/"])])
      .addresses
  ).toEqual(["https://one.example.test/", "http://two.example.test/"])
  expect(
    clientOptions([withDiscovery(discovery), withEndpoint("discovery:///order.v1.OrderService")])
  ).toMatchObject({
    addresses: [],
    service: "order.v1.OrderService"
  })
  expect(
    clientOptions([withDiscovery(discovery), withEndpoint("DISCOVERY:///orders-grpc")]).service
  ).toBe("orders-grpc")
  expect(clientOptions([withDiscovery(discovery), withEndpoint("discovery:///订单")]).service).toBe(
    "订单"
  )
})

test("withEndpoint rejects an empty gRPC target when the option is created", () => {
  expect(() => withEndpoint("")).toThrow("withEndpoint requires a non-empty endpoint")
  expect(() => withEndpoint([])).toThrow("withEndpoint requires at least one endpoint")
  expect(() => withEndpoint([""])).toThrow(
    "withEndpoint entry must be a non-empty well-formed string"
  )
})

test("withEndpoint rejects duplicate direct roots after canonicalAddress", () => {
  expect(() => withEndpoint(["HTTPS://ONE.EXAMPLE.TEST:443", "https://one.example.test/"])).toThrow(
    "withEndpoint must not contain duplicate addresses"
  )
  expect(() => withEndpoint(["https://rpc.example.test", "https://rpc.example.test/"])).toThrow(
    "withEndpoint must not contain duplicate addresses"
  )
})

test("withEndpoint rejects discovery inside a direct address array", () => {
  expect(() => withEndpoint(["discovery:///orders"])).toThrow(
    "withEndpoint arrays only accept direct addresses"
  )
  expect(() => withEndpoint(["https://rpc.example.test", "DISCOVERY:///orders"])).toThrow(
    "withEndpoint arrays only accept direct addresses"
  )
})

test("withEndpoint rejects ill-formed strings before canonicalAddress", () => {
  expect(() => withEndpoint("\ud800")).toThrow("withEndpoint endpoint must be well-formed")
  expect(() => withEndpoint("\udc00")).toThrow("withEndpoint endpoint must be well-formed")
  expect(() => withEndpoint("https://rpc.example.test/\ud800")).toThrow(
    "withEndpoint endpoint must be well-formed"
  )
  expect(() => withEndpoint("https://rpc.example.test/\uD800\uDC00")).toThrow(
    "gRPC address must be a root URL"
  )
  expect(
    clientOptions([withDiscovery(discovery), withEndpoint("discovery:///\uD800\uDC00")]).service
  ).toBe("\uD800\uDC00")
})

test("withEndpoint applies canonicalAddress to a direct gRPC target immediately", () => {
  expect(() => withEndpoint("ftp://one.example.test/")).toThrow(
    "gRPC address must use http or https"
  )
  expect(() => withEndpoint("https://user:secret@one.example.test/")).toThrow(
    "gRPC address must not contain credentials"
  )
  expect(() => withEndpoint("https://one.example.test/rpc")).toThrow(
    "gRPC address must be a root URL"
  )
  expect(() => withEndpoint("https://one.example.test/?query=yes")).toThrow(
    "gRPC address must not contain a query"
  )
  expect(() => withEndpoint("https://one.example.test/#fragment")).toThrow(
    "gRPC address must not contain a fragment"
  )
  expect(() => withEndpoint("memory://orders")).toThrow("gRPC address must use http or https")
})

test("withEndpoint rejects a malformed discovery target", () => {
  expect(() => withEndpoint("discovery://orders")).toThrow(
    "withEndpoint discovery authority must be empty"
  )
  expect(() => withEndpoint("discovery:///")).toThrow(
    "withEndpoint discovery target must be non-empty"
  )
  expect(() => withEndpoint("discovery:/orders")).toThrow(
    "withEndpoint discovery endpoint must be discovery:///name"
  )
  expect(() => withEndpoint("discovery:///orders?x=1")).toThrow(
    "withEndpoint discovery endpoint must be discovery:///name"
  )
  expect(() => withEndpoint("discovery:///100%")).toThrow(
    "withEndpoint discovery endpoint must be discovery:///name"
  )
  expect(() => withEndpoint("discovery://user@/payment")).toThrow(
    "withEndpoint discovery endpoint must be discovery:///name"
  )
})

test("a later withEndpoint replaces the earlier gRPC target", () => {
  expect(
    clientOptions([
      withEndpoint("https://rpc.example.test"),
      withDiscovery(discovery),
      withEndpoint("discovery:///orders-grpc")
    ])
  ).toMatchObject({ addresses: [], service: "orders-grpc" })
  expect(
    clientOptions([
      withEndpoint("discovery:///orders-grpc"),
      withEndpoint(["https://one.example.test", "https://two.example.test"])
    ]).addresses
  ).toEqual(["https://one.example.test/", "https://two.example.test/"])
  expect(
    clientOptions([
      withEndpoint("discovery:///orders-grpc"),
      withEndpoint(["https://one.example.test", "https://two.example.test"])
    ]).service
  ).toBeNull()
})

test("clientOptions pairs a discovery endpoint with withDiscovery", () => {
  expect(() => clientOptions([withEndpoint("discovery:///orders-grpc")])).toThrow(
    "newClient discovery endpoint requires withDiscovery"
  )
  expect(() => clientOptions([withDiscovery(discovery)])).toThrow(
    "newClient requires a discovery endpoint when withDiscovery is configured"
  )
  expect(() =>
    clientOptions([withEndpoint("https://rpc.example.test"), withDiscovery(discovery)])
  ).toThrow("newClient cannot combine direct addresses with discovery")
  expect(
    clientOptions([
      withEndpoint("https://rpc.example.test"),
      withDiscovery(discovery),
      withEndpoint("discovery:///orders-grpc")
    ]).service
  ).toBe("orders-grpc")
  expect(
    clientOptions([withDiscovery(discovery), withEndpoint("discovery:///orders-grpc")]).service
  ).toBe("orders-grpc")
})
