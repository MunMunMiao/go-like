import { newMemoryCache } from "@go-like/cache-memory"
import {
  newClient,
  withDiscovery,
  withSelector,
  withTransport,
  type CallRequest,
  type CallOption
} from "@go-like/client"
import { background, type Context } from "@go-like/context"
import { newRoundRobinSelector, type Discovery, type ServiceInstance } from "@go-like/registry"
import { executor, newHTTPTransport } from "@go-like/transport-http"
import { expect, test } from "bun:test"

import { findAmountMinor } from "../src/catalog"
import { newCatalogHandler } from "../src/http"
import { decodePricingRequest, newPricingHandler, type PricingClient } from "../src/pricing"

/** Creates a Client that invokes the real Pricing handler without network I/O. */
function directClient(onCall: () => void): PricingClient {
  const pricing = newPricingHandler()
  const client: PricingClient = {
    async call(ctx: Context, request: CallRequest, ..._options: readonly CallOption[]) {
      onCall()
      return await pricing(ctx, request.message)
    }
  }
  return Object.freeze(client)
}

/** Creates one immediately usable memory Cache. */
function memoryCache() {
  return newMemoryCache()
}

test("serves a product through Pricing once and then the cache", async () => {
  const cache = memoryCache()
  let pricingCalls = 0
  const handler = newCatalogHandler({
    cache,
    client: directClient(function called(): void {
      pricingCalls += 1
    })
  })
  const url = "http://example.test/v1/products/sku-001?currency=USD"
  const first = await handler(new Request(url))
  const second = await handler(new Request(url))
  expect(first.status).toBe(200)
  expect(await first.json()).toEqual({
    id: "sku-001",
    name: "go-like Mug",
    price: { currency: "USD", amountMinor: 1299 }
  })
  expect(second.status).toBe(200)
  expect(await second.json()).toEqual({
    id: "sku-001",
    name: "go-like Mug",
    price: { currency: "USD", amountMinor: 1299 }
  })
  expect(pricingCalls).toBe(1)
})

test("retries one transient Pricing failure through the production handler", async () => {
  const cache = memoryCache()
  const instance: ServiceInstance = Object.freeze({
    id: "unit-pricing",
    name: "pricing",
    version: "v1",
    endpoints: Object.freeze(["http://pricing.test"]),
    metadata: Object.freeze({})
  })
  let stopWatcher: (() => void) | null = null
  const watcherStopped = new Promise<void>((resolve) => {
    stopWatcher = resolve
  })
  const discovery: Discovery = Object.freeze({
    async getService(): Promise<readonly ServiceInstance[]> {
      return Object.freeze([instance])
    },
    async watch() {
      let initialSnapshot = true
      return Object.freeze({
        async next(): Promise<readonly ServiceInstance[]> {
          if (initialSnapshot) {
            initialSnapshot = false
            return Object.freeze([instance])
          }
          await watcherStopped
          throw new Error("test discovery watcher stopped")
        },
        async stop(): Promise<void> {
          stopWatcher?.()
        }
      })
    }
  })
  const handlePricing = newPricingHandler()
  let attempts = 0
  async function retryExecutor(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    attempts += 1
    if (attempts === 1) throw new TypeError("transient Pricing failure")
    const request = new Request(input, init)
    const response = await handlePricing(
      background(),
      Object.freeze({
        header: Object.freeze(Object.fromEntries(request.headers.entries())),
        body: new Uint8Array(await request.arrayBuffer())
      })
    )
    const body = new ArrayBuffer(response.body.byteLength)
    new Uint8Array(body).set(response.body)
    return new Response(body, { headers: response.header })
  }
  retryExecutor.preconnect = function preconnect(): void {}
  const client = newClient(
    withDiscovery(discovery),
    withSelector(newRoundRobinSelector()),
    withTransport(newHTTPTransport(executor(retryExecutor)))
  )
  const handler = newCatalogHandler({ cache, client })

  try {
    const response = await handler(
      new Request("http://example.test/v1/products/sku-001?currency=USD")
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      id: "sku-001",
      name: "go-like Mug",
      price: { currency: "USD", amountMinor: 1299 }
    })
    expect(attempts).toBe(2)
  } finally {
    await client.close(background())
  }
})

test("rejects invalid and unknown products before Pricing I/O", async () => {
  const cache = memoryCache()
  let pricingCalls = 0
  const handler = newCatalogHandler({
    cache,
    client: directClient(function called(): void {
      pricingCalls += 1
    })
  })
  const invalid = await handler(new Request("http://example.test/v1/products/sku-001?currency=BTC"))
  const missing = await handler(new Request("http://example.test/v1/products/sku-999?currency=USD"))
  const inherited = await handler(
    new Request("http://example.test/v1/products/constructor?currency=USD")
  )
  expect(invalid.status).toBe(400)
  expect(missing.status).toBe(404)
  expect(inherited.status).toBe(404)
  expect(pricingCalls).toBe(0)
})

test("rejects prototype-sensitive products at the Pricing service boundary", () => {
  const pricing = newPricingHandler()
  expect(() =>
    pricing(
      background(),
      Object.freeze({
        header: Object.freeze({}),
        body: new TextEncoder().encode(
          JSON.stringify({ productId: "constructor", currency: "USD" })
        )
      })
    )
  ).toThrow("price is unavailable")
})

test("does not read inherited currency properties from the price table", () => {
  expect(findAmountMinor("sku-001", "constructor")).toBeNull()
})

test.each([{}, { productId: "sku-001" }, { currency: "USD" }, { productId: 1, currency: "USD" }])(
  "rejects an incomplete Pricing request %#",
  (value) => {
    expect(() => decodePricingRequest(new TextEncoder().encode(JSON.stringify(value)))).toThrow(
      "invalid Pricing.Get request"
    )
  }
)

test("exposes live and cache readiness handlers", async () => {
  const cache = memoryCache()
  const handler = newCatalogHandler({
    cache,
    client: directClient(function unused(): void {})
  })
  expect((await handler(new Request("http://example.test/livez"))).status).toBe(200)
  expect((await handler(new Request("http://example.test/readyz"))).status).toBe(200)
})
