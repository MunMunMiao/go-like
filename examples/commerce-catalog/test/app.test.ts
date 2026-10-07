import { expiresIn, type Cache } from "@go-like/cache"
import { newMemoryCache } from "@go-like/cache-memory"
import {
  newClient,
  withDiscovery,
  withEndpoint,
  withSelector,
  withTransport,
  type CallOptions,
  type CallOption,
  type Client
} from "@go-like/client"
import { background, type Context } from "@go-like/context"
import { name, newApp, server } from "@go-like/core"
import { newRoundRobinSelector, type Discovery, type ServiceInstance } from "@go-like/registry"
import { address, newServer, transport as serverTransport } from "@go-like/server"
import { newMemoryTransport } from "@go-like/transport-memory"
import { executor, newHTTPTransport } from "@go-like/transport-http"
import { expect, test } from "bun:test"

import { findAmountMinor, type PriceQuote } from "../src/catalog"
import { pricing } from "../src/contract"
import { newCatalogHandler } from "../src/http"
import {
  decodePrice,
  encodePrice,
  newPricingClient,
  newPricingHandler,
  type PricingClient,
  type PricingRequest
} from "../src/pricing"

/** Creates a Client that invokes the real Pricing handler without network I/O. */
function directClient(onCall: () => void): PricingClient {
  const pricingHandler = newPricingHandler()
  const client = Object.freeze({
    async call(ctx: Context, _endpoint: unknown, request: PricingRequest) {
      onCall()
      return pricingHandler(ctx, request)
    },
    async close(): Promise<void> {
      return
    }
  }) as unknown as Client
  return newPricingClient(client)
}

/** Creates one immediately usable memory Cache. */
function memoryCache(): Cache {
  return newMemoryCache()
}

function failingCache(overrides: Partial<Cache> = {}): Cache {
  return Object.freeze({
    async get() {
      throw new Error("cache get failed")
    },
    async put() {
      throw new Error("cache put failed")
    },
    async delete() {
      throw new Error("cache delete failed")
    },
    string() {
      return "failing-cache"
    },
    ...overrides
  })
}

test("registers the Pricing handler on its exact service endpoint", async () => {
  let registration: readonly { readonly endpoint: unknown; readonly handler: unknown }[] =
    Object.freeze([])
  let called = false
  const pricingServer = {
    registerHandlers(
      handlers: readonly { readonly endpoint: unknown; readonly handler: unknown }[]
    ): void {
      registration = handlers
    }
  }
  expect(pricing.endpoints.get).toMatchObject({
    service: "pricing.v1",
    endpoint: "get"
  })
  pricing.registerHandler(pricingServer, {
    get(ctx, request) {
      called = true
      return newPricingHandler()(ctx, request)
    }
  })

  expect(registration[0]?.endpoint).toEqual(pricing.endpoints.get)
  expect(typeof registration[0]?.handler).toBe("function")
  const registered = registration[0]?.handler as (
    ctx: Context,
    request: PricingRequest
  ) => PriceQuote
  await registered(background(), { productId: "sku-001", currency: "USD" })
  expect(called).toBe(true)
})

test("creates a typed Pricing client that preserves codec, options and errors", async () => {
  const ctx = background()
  const response = Object.freeze({
    productId: "sku-001",
    currency: "USD",
    amountMinor: 1_299,
    validUntil: Date.now() + 60_000
  })
  const option: CallOption = (options) => options
  const failure = new Error("Pricing unavailable")
  let rejected = false
  let observed: readonly unknown[] = Object.freeze([])
  const client = Object.freeze({
    async call(...args: readonly unknown[]) {
      observed = args
      if (rejected) throw failure
      return response
    },
    async close(): Promise<void> {}
  }) as unknown as Client
  expect(pricing.endpoints.get).toMatchObject({
    service: "pricing.v1",
    endpoint: "get"
  })
  const { fetchPrice } = newPricingClient(client)

  expect(await fetchPrice(ctx, "sku-001", "USD", option)).toEqual(response)
  expect(observed[0]).toBe(ctx)
  expect(observed[1]).toEqual(pricing.endpoints.get)
  expect(observed[2]).toEqual({ productId: "sku-001", currency: "USD" })
  const observedOptions = observed.slice(3) as readonly CallOption[]
  expect(observedOptions.at(-1)).toBe(option)
  let callOptions: CallOptions = Object.freeze({ filters: Object.freeze([]), retry: null })
  for (const configure of observedOptions.slice(0, -1)) callOptions = configure(callOptions)
  expect(callOptions.filters).toHaveLength(1)
  expect(callOptions.retry).toMatchObject({ authorization: "idempotent", maxAttempts: 3 })
  rejected = true
  await expect(fetchPrice(ctx, "sku-001", "USD")).rejects.toBe(failure)
})

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
    name: "pricing.v1",
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
  let pricingRoute = ""
  async function retryExecutor(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    attempts += 1
    if (attempts === 1) throw new TypeError("transient Pricing failure")
    const request = new Request(input, init)
    pricingRoute = new URL(request.url).pathname
    const payload: unknown = await request.json()
    if (
      payload === null ||
      typeof payload !== "object" ||
      !Object.hasOwn(payload, "productId") ||
      !Object.hasOwn(payload, "currency")
    ) {
      throw new TypeError("invalid pricing request")
    }
    const productId = Reflect.get(payload, "productId")
    const currency = Reflect.get(payload, "currency")
    if (typeof productId !== "string" || typeof currency !== "string") {
      throw new TypeError("invalid pricing request")
    }
    return Response.json(handlePricing(background(), { productId, currency }))
  }
  const client = newClient(
    withDiscovery(discovery),
    withEndpoint("discovery:///pricing.v1"),
    withSelector(newRoundRobinSelector()),
    withTransport(newHTTPTransport(executor(retryExecutor)))
  )
  const handler = newCatalogHandler({ cache, client: newPricingClient(client) })

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
    expect(pricingRoute).toBe("/pricing.v1/get")
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
  const pricingHandler = newPricingHandler()
  expect(() => pricingHandler(background(), { productId: "constructor", currency: "USD" })).toThrow(
    "price is unavailable"
  )
})

test("rejects Pricing field values that fail business validation", () => {
  const pricingHandler = newPricingHandler()
  expect(() => pricingHandler(background(), { productId: "bad product", currency: "USD" })).toThrow(
    "invalid pricing request"
  )
})

test("rejects malformed Pricing requests at the server boundary", async () => {
  const memory = newMemoryTransport()
  const pricingAddress = "memory://commerce-pricing"
  const pricingServer = newServer(serverTransport(memory), address(pricingAddress))
  pricing.registerHandler(pricingServer, { get: newPricingHandler() })
  const app = newApp(name("commerce-pricing-boundary"), server(pricingServer))
  const running = app.run()
  await pricingServer.endpoint(background())
  const raw = newClient(withEndpoint(pricingAddress), withTransport(memory))
  const call = (body: string) =>
    raw.call(background(), {
      service: "pricing.v1",
      endpoint: "get",
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode(body)
    })
  try {
    await expect(call("{")).rejects.toThrow("invalid request body")
    await expect(call("null")).rejects.toThrow("invalid request body")
    await expect(call(JSON.stringify({ productId: "sku-001" }))).rejects.toThrow(
      "invalid request body"
    )
    await expect(call(JSON.stringify({ currency: "USD" }))).rejects.toThrow("invalid request body")
    await expect(call(JSON.stringify({ productId: 1, currency: "USD" }))).rejects.toThrow(
      "invalid request body"
    )
    await expect(call("{}")).rejects.toThrow("invalid request body")
  } finally {
    await raw.close(background())
    await app.stop()
    await running
  }
})

test("does not read inherited currency properties from the price table", () => {
  expect(findAmountMinor("sku-001", "constructor")).toBeNull()
})

test("rejects invalid cached payloads and still serves the authoritative Pricing result", async () => {
  const cache = newMemoryCache()
  const key = "price:v1:USD:sku-001"
  await cache.put(background(), key, new TextEncoder().encode("not-json"), expiresIn(30_000))
  const handler = newCatalogHandler({ cache, client: directClient(() => {}) })
  const response = await handler(
    new Request("http://example.test/v1/products/sku-001?currency=USD")
  )
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ price: { amountMinor: 1299 } })
  expect(await cache.get(background(), key)).not.toBeNull()
})

test("keeps Pricing errors and invalid responses distinct from cache failures", async () => {
  const cache = failingCache()
  const unavailable = newCatalogHandler({
    cache,
    client: {
      async fetchPrice() {
        throw new Error("pricing unavailable")
      }
    }
  })
  expect(
    (await unavailable(new Request("http://example.test/v1/products/sku-001?currency=USD"))).status
  ).toBe(503)

  const invalid = newCatalogHandler({
    cache,
    client: {
      async fetchPrice() {
        return null
      }
    }
  })
  expect(
    (await invalid(new Request("http://example.test/v1/products/sku-001?currency=USD"))).status
  ).toBe(502)
})

test("rejects malformed and expired Pricing responses", () => {
  const now = Date.now()
  expect(decodePrice(new TextEncoder().encode("{}"), "sku-001", "USD")).toBeNull()
  expect(
    decodePrice(
      new TextEncoder().encode(
        JSON.stringify({
          productId: "sku-001",
          currency: "USD",
          amountMinor: -1,
          validUntil: now + 1_000
        })
      ),
      "sku-001",
      "USD"
    )
  ).toBeNull()
  expect(
    decodePrice(
      new TextEncoder().encode(
        JSON.stringify({
          productId: "sku-001",
          currency: "USD",
          amountMinor: 1,
          validUntil: now - 1
        })
      ),
      "sku-001",
      "USD"
    )
  ).toBeNull()
  expect(decodePrice(new TextEncoder().encode("{"), "sku-001", "USD")).toBeNull()
  expect(
    encodePrice({ productId: "sku-001", currency: "USD", amountMinor: 1, validUntil: now + 1_000 })
  ).toBeInstanceOf(Uint8Array)
})

test("exposes live and cache readiness handlers", async () => {
  const cache = memoryCache()
  const handler = newCatalogHandler({
    cache,
    client: directClient(function unused(): void {})
  })
  expect((await handler(new Request("http://example.test/livez"))).status).toBe(200)
  expect((await handler(new Request("http://example.test/readyz"))).status).toBe(200)
})
