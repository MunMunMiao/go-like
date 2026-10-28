import { background } from "@go-like/context"
import type { Discovery, Selector } from "@go-like/registry"
import type { Transport } from "@go-like/transport"
import { expect, test } from "bun:test"

import * as ClientPackage from "../src/index"
import {
  newClient,
  withDiscovery,
  withEndpoint,
  withTransport,
  type ClientOptions
} from "../src/index"

const baseOptions: ClientOptions = Object.freeze({
  addresses: Object.freeze([]),
  service: null,
  discovery: null,
  selector: null,
  transport: null,
  block: false,
  middleware: Object.freeze([]),
  operationMiddleware: new Map(),
  closeTimeoutMs: 1_000,
  poolSize: 100,
  poolTtlMs: 60_000
})

const transport = {
  dial(): never {
    throw new Error("dial should not run")
  }
} as unknown as Transport
const discovery = {
  getService(): never {
    throw new Error("getService should not run")
  },
  watch(): never {
    throw new Error("watch should not run")
  }
} as unknown as Discovery
const selector = {
  select(): never {
    throw new Error("select should not run")
  }
} as unknown as Selector

test("withEndpoint keeps a direct address exactly, including non-root HTTP", () => {
  expect(withEndpoint("memory://payment")(baseOptions).addresses).toEqual(["memory://payment"])
  expect(withEndpoint("memory://payment")(baseOptions).service).toBeNull()
  expect(withEndpoint("https://payment.example.test/rpc")(baseOptions).addresses).toEqual([
    "https://payment.example.test/rpc"
  ])
  expect(withEndpoint("http://orders.example/rpc?x=1#fragment")(baseOptions).addresses).toEqual([
    "http://orders.example/rpc?x=1#fragment"
  ])
  expect(withEndpoint("https://user:secret@orders.example/")(baseOptions).addresses).toEqual([
    "https://user:secret@orders.example/"
  ])
  expect(withEndpoint("not a url")(baseOptions).addresses).toEqual(["not a url"])
  expect(withEndpoint(["HTTPS://A", "https://a/"])(baseOptions).addresses).toEqual([
    "HTTPS://A",
    "https://a/"
  ])
})

test("withEndpoint copies a direct address list and ignores later caller mutation", () => {
  const targets = ["memory://payment-a", "memory://payment-b"]
  const option = withEndpoint(targets)
  targets.push("memory://payment-c")
  expect(option(baseOptions)).toMatchObject({
    addresses: ["memory://payment-a", "memory://payment-b"],
    service: null
  })
  expect(Object.isFrozen(option(baseOptions).addresses)).toBe(true)
})

test("withEndpoint parses one discovery:/// name and clears direct addresses", () => {
  expect(withEndpoint("discovery:///payment")(baseOptions)).toMatchObject({
    addresses: [],
    service: "payment"
  })
  expect(withEndpoint("discovery:///order.v1.OrderService")(baseOptions).service).toBe(
    "order.v1.OrderService"
  )
  expect(withEndpoint("discovery:///orders-http")(baseOptions).service).toBe("orders-http")
  expect(withEndpoint("DISCOVERY:///Payment")(baseOptions).service).toBe("Payment")
  expect(withEndpoint("discovery:///订单")(baseOptions).service).toBe("订单")
  expect(withEndpoint("discovery:///payment%3Fx%3D1")(baseOptions).service).toBe("payment?x=1")
  expect(withEndpoint("discovery:///foo%2Fbar")(baseOptions).service).toBe("foo/bar")
  expect(withEndpoint("discovery:///\uD800\uDC00")(baseOptions).service).toBe("\uD800\uDC00")
})

test("withEndpoint rejects an empty target when the option is created", () => {
  expect(() => withEndpoint("")).toThrow("withEndpoint requires a non-empty endpoint")
  expect(() => withEndpoint([])).toThrow("withEndpoint requires at least one endpoint")
  expect(() => withEndpoint(1 as never)).toThrow("withEndpoint requires a non-empty endpoint")
})

test("withEndpoint rejects duplicate direct addresses when the option is created", () => {
  expect(() => withEndpoint(["memory://payment", "memory://payment"])).toThrow(
    "withEndpoint must not contain duplicate addresses"
  )
})

test("withEndpoint rejects a discovery target inside an address array", () => {
  expect(() => withEndpoint(["discovery:///payment"])).toThrow(
    "withEndpoint arrays only accept direct addresses"
  )
  expect(() => withEndpoint(["memory://payment", "discovery:///other"])).toThrow(
    "withEndpoint arrays only accept direct addresses"
  )
  expect(() => withEndpoint(["DISCOVERY:///payment"])).toThrow(
    "withEndpoint arrays only accept direct addresses"
  )
  expect(() => withEndpoint(["discovery:/payment"])).toThrow(
    "withEndpoint arrays only accept direct addresses"
  )
})

test("withEndpoint rejects a malformed array entry before parsing discovery", () => {
  expect(() => withEndpoint([""])).toThrow(
    "withEndpoint entry must be a non-empty well-formed string"
  )
  expect(() => withEndpoint(["\ud800"])).toThrow(
    "withEndpoint entry must be a non-empty well-formed string"
  )
  expect(() => withEndpoint(["memory://payment", 1 as never])).toThrow(
    "withEndpoint entry must be a non-empty well-formed string"
  )
})

test("withEndpoint rejects an ill-formed endpoint string", () => {
  expect(() => withEndpoint("\ud800")).toThrow("withEndpoint endpoint must be well-formed")
  expect(() => withEndpoint("\udc00")).toThrow("withEndpoint endpoint must be well-formed")
  expect(() => withEndpoint("discovery:///\ud800")).toThrow(
    "withEndpoint endpoint must be well-formed"
  )
  expect(typeof withEndpoint("\uD800\uDC00")).toBe("function")
})

test("withEndpoint rejects a discovery URI whose authority, name, or shape is wrong", () => {
  expect(() => withEndpoint("discovery://payment")).toThrow(
    "withEndpoint discovery authority must be empty"
  )
  expect(() => withEndpoint("discovery://user:secret@payment/name")).toThrow(
    "withEndpoint discovery authority must be empty"
  )
  expect(() => withEndpoint("discovery:///")).toThrow(
    "withEndpoint discovery target must be non-empty"
  )
  expect(() => withEndpoint("discovery:/payment")).toThrow(
    "withEndpoint discovery endpoint must be discovery:///name"
  )
  expect(() => withEndpoint("discovery:payment")).toThrow(
    "withEndpoint discovery endpoint must be discovery:///name"
  )
  expect(() => withEndpoint("discovery:///payment?x=1")).toThrow(
    "withEndpoint discovery endpoint must be discovery:///name"
  )
  expect(() => withEndpoint("discovery:///payment#fragment")).toThrow(
    "withEndpoint discovery endpoint must be discovery:///name"
  )
  expect(() => withEndpoint("discovery://user@/payment")).toThrow(
    "withEndpoint discovery endpoint must be discovery:///name"
  )
  expect(() => withEndpoint("discovery:///100%")).toThrow(
    "withEndpoint discovery endpoint must be discovery:///name"
  )
})

test("a later withEndpoint replaces the earlier target and keeps unrelated options", () => {
  const seeded: ClientOptions = {
    ...baseOptions,
    addresses: Object.freeze(["memory://stale"]),
    service: "stale",
    discovery,
    selector,
    transport,
    block: true,
    closeTimeoutMs: 25,
    poolSize: 3,
    poolTtlMs: 9
  }
  const discovered = withEndpoint("discovery:///payment")(seeded)
  expect(discovered).toMatchObject({
    addresses: [],
    service: "payment",
    block: true,
    closeTimeoutMs: 25,
    poolSize: 3,
    poolTtlMs: 9
  })
  expect(discovered.discovery).toBe(discovery)
  expect(discovered.selector).toBe(selector)
  expect(discovered.transport).toBe(transport)

  const direct = withEndpoint(["memory://next-a", "memory://next-b"])(discovered)
  expect(direct.service).toBeNull()
  expect(direct.addresses).toEqual(["memory://next-a", "memory://next-b"])
  expect(direct.discovery).toBe(discovery)
  expect(direct.transport).toBe(transport)
})

test("newClient rejects a discovery endpoint without withDiscovery", () => {
  expect(() => newClient(withTransport(transport), withEndpoint("discovery:///payment"))).toThrow(
    "newClient discovery endpoint requires withDiscovery"
  )
})

test("newClient rejects withDiscovery unless the endpoint is discovery:///", () => {
  expect(() =>
    newClient(withTransport(transport), withEndpoint("memory://payment"), withDiscovery(discovery))
  ).toThrow("newClient cannot combine direct addresses with discovery")
  expect(() =>
    newClient(withTransport(transport), withDiscovery(discovery), withEndpoint("memory://payment"))
  ).toThrow("newClient cannot combine direct addresses with discovery")
  expect(() => newClient(withTransport(transport), withDiscovery(discovery))).toThrow(
    "newClient requires a discovery endpoint when withDiscovery is configured"
  )
})

test("newClient accepts either option order and lets the later endpoint win", async () => {
  const first = newClient(
    withEndpoint("discovery:///payment"),
    withDiscovery(discovery),
    withTransport(transport)
  )
  const second = newClient(
    withDiscovery(discovery),
    withTransport(transport),
    withEndpoint("discovery:///payment")
  )
  const replaced = newClient(
    withTransport(transport),
    withEndpoint("memory://payment"),
    withDiscovery(discovery),
    withEndpoint("discovery:///orders")
  )
  await first.close(background())
  await second.close(background())
  await replaced.close(background())

  expect(() =>
    newClient(
      withTransport(transport),
      withEndpoint("discovery:///payment"),
      withEndpoint("memory://payment"),
      withDiscovery(discovery)
    )
  ).toThrow("newClient cannot combine direct addresses with discovery")
})

test("the client runtime exports withEndpoint and not the removed target options", () => {
  expect(Object.keys(ClientPackage).sort()).toEqual([
    "circuitBreakerMiddleware",
    "closeTimeout",
    "middleware",
    "newClient",
    "poolSize",
    "poolTtl",
    "use",
    "withBlock",
    "withDiscovery",
    "withEndpoint",
    "withFilter",
    "withRetry",
    "withSelector",
    "withTransport"
  ])
})
