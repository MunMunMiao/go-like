import { background } from "@go-like/context"
import { describe, expect, test } from "bun:test"
import { newSecuritiesMarketDataHandler, newSecuritiesMarketDataHTTP } from "../src/http"
import {
  newMemoryMarketDataRepository,
  newPublishMarketQuote,
  newSecuritiesMarketDataService
} from "../src/service"

function quote(sequence: number) {
  return Object.freeze({
    symbol: "ACME",
    sequence,
    bidPriceMicros: 10_000,
    bidQuantity: 100,
    askPriceMicros: 10_100,
    askQuantity: 120
  })
}

describe("securities market data", () => {
  test("accepts advancing sequences and exposes the latest quote", () => {
    const repository = newMemoryMarketDataRepository()
    const publish = newPublishMarketQuote(repository, 100)
    publish(background(), quote(10))
    publish(background(), quote(11))
    expect(repository.latest(background(), "ACME")?.sequence).toBe(11)
    expect(() => publish(background(), quote(9))).toThrow("stale market sequence")
  })

  test("deduplicates an exact replay and rejects conflicting sequence content", () => {
    const publish = newPublishMarketQuote(newMemoryMarketDataRepository(), 100)
    const original = quote(10)
    expect(publish(background(), original)).toBe(publish(background(), original))
    expect(() =>
      publish(background(), {
        symbol: "ACME",
        sequence: 10,
        bidPriceMicros: 9_900,
        bidQuantity: 100,
        askPriceMicros: 10_100,
        askQuantity: 120
      })
    ).toThrow("market sequence conflict")
  })

  test("rejects crossed books and prices outside the configured tick", () => {
    const publish = newPublishMarketQuote(newMemoryMarketDataRepository(), 100)
    expect(() =>
      publish(background(), {
        symbol: "ACME",
        sequence: 1,
        bidPriceMicros: 10_100,
        bidQuantity: 10,
        askPriceMicros: 10_100,
        askQuantity: 10
      })
    ).toThrow("bid must be below ask")
    expect(() =>
      publish(background(), {
        symbol: "ACME",
        sequence: 1,
        bidPriceMicros: 10_050,
        bidQuantity: 10,
        askPriceMicros: 10_100,
        askQuantity: 10
      })
    ).toThrow("price is not aligned to tick size")
  })

  test("serves quote ingestion through a standard Fetch handler", async () => {
    const response = await newSecuritiesMarketDataHandler(
      newPublishMarketQuote(newMemoryMarketDataRepository(), 100)
    )(
      new Request("https://example.test/v1/market-quotes", {
        method: "POST",
        body: JSON.stringify(quote(1))
      })
    )
    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({ symbol: "ACME", sequence: 1 })
  })

  test("reports readiness only after the required market quote arrives", async () => {
    const service = newSecuritiesMarketDataService(100, "ACME")
    const handler = newSecuritiesMarketDataHTTP(service)
    expect((await handler(new Request("https://example.test/readyz"))).status).toBe(503)
    expect((await handler(new Request("https://example.test/livez"))).status).toBe(200)

    const ingested = await handler(
      new Request("https://example.test/v1/market-quotes", {
        method: "POST",
        body: JSON.stringify(quote(1))
      })
    )
    expect(ingested.status).toBe(202)
    const ready = await handler(new Request("https://example.test/readyz"))
    expect(ready.status).toBe(200)
    expect(await ready.json()).toEqual({
      status: "ok",
      checks: [{ name: "required-market-quote", status: "ok" }]
    })
  })
})
