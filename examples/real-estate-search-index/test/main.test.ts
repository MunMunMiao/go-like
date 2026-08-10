import { background, withCancel } from "@go-like/context"
import { describe, expect, test } from "bun:test"

import { newMemoryCache } from "@go-like/cache-memory"
import { newRealEstateSearchService } from "../src/cache"
import { newRealEstateHandler } from "../src/http"
import { newMemoryListingRepository } from "../src/repository"
import {
  listingFingerprint,
  newRealEstateIndex,
  searchCacheKey,
  validateListing,
  validateSearch
} from "../src/service"

/** Runs one assertion against an isolated service instance. */
async function withService(run: () => Promise<void>): Promise<void> {
  await run()
}

/** Applies one listing projection through the public Fetch boundary. */
function indexListing(
  service: ReturnType<typeof newRealEstateSearchService>,
  listingId: string,
  city: string,
  priceMinor: number,
  bedrooms: number,
  active: boolean,
  revision: number
): Promise<Response> {
  return Promise.resolve(
    service.handler(
      new Request("https://example.test/v1/listings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ listingId, city, priceMinor, bedrooms, active, revision })
      })
    )
  )
}

/** Searches one city through the public Fetch boundary. */
function search(
  service: ReturnType<typeof newRealEstateSearchService>,
  city: string,
  maximumPriceMinor: number,
  minimumBedrooms: number
): Promise<Response> {
  const url = new URL("https://example.test/v1/listings/search")
  url.searchParams.set("city", city)
  url.searchParams.set("maximumPriceMinor", String(maximumPriceMinor))
  url.searchParams.set("minimumBedrooms", String(minimumBedrooms))
  return Promise.resolve(service.handler(new Request(url)))
}

describe("real estate search index", () => {
  test("returns only active listings that satisfy every query bound", async () => {
    const service = newRealEstateSearchService()
    await withService(async function verify(): Promise<void> {
      await indexListing(service, "cheap", "Shanghai", 2_000, 2, true, 1)
      await indexListing(service, "expensive", "Shanghai", 5_000, 3, true, 1)
      await indexListing(service, "over-limit", "Shanghai", 7_000, 3, true, 1)
      await indexListing(service, "inactive", "Shanghai", 1_000, 4, false, 1)
      await indexListing(service, "other-city", "Beijing", 1_000, 4, true, 1)
      const response = await search(service, "Shanghai", 6_000, 2)
      expect(await response.json()).toEqual({
        listings: [
          {
            listingId: "cheap",
            city: "Shanghai",
            priceMinor: 2_000,
            bedrooms: 2,
            active: true,
            revision: 1
          },
          {
            listingId: "expensive",
            city: "Shanghai",
            priceMinor: 5_000,
            bedrooms: 3,
            active: true,
            revision: 1
          }
        ]
      })
    })
  })

  test("ignores stale revisions instead of replacing a newer projection", async () => {
    const service = newRealEstateSearchService()
    await withService(async function verify(): Promise<void> {
      await indexListing(service, "listing-one", "Shenzhen", 3_000, 2, true, 2)
      const stale = await indexListing(service, "listing-one", "Shenzhen", 1_000, 2, true, 1)
      expect(await stale.json()).toEqual({ applied: false, affectedCities: [] })
      const response = await search(service, "Shenzhen", 5_000, 1)
      expect(await response.json()).toMatchObject({
        listings: [{ priceMinor: 3_000, revision: 2 }]
      })
    })
  })

  test("rejects different listing content at the same revision", async () => {
    const service = newRealEstateSearchService()
    await withService(async function verify(): Promise<void> {
      expect((await indexListing(service, "conflict", "Chengdu", 2_000, 2, true, 1)).status).toBe(
        202
      )
      expect((await indexListing(service, "conflict", "Chengdu", 2_500, 2, true, 1)).status).toBe(
        409
      )
    })
  })

  test("serves repeated searches from cache and invalidates after an applied update", async () => {
    const service = newRealEstateSearchService()
    await withService(async function verify(): Promise<void> {
      await indexListing(service, "cached", "Hangzhou", 4_000, 2, true, 1)
      await search(service, "Hangzhou", 10_000, 1)
      await search(service, "Hangzhou", 10_000, 1)
      expect(service.repository.searches()).toBe(1)

      await indexListing(service, "cached", "Hangzhou", 4_500, 2, true, 2)
      const refreshed = await search(service, "Hangzhou", 10_000, 1)
      expect(service.repository.searches()).toBe(2)
      expect(await refreshed.json()).toMatchObject({
        listings: [{ priceMinor: 4_500, revision: 2 }]
      })
    })
  })

  test("validates listing and search boundaries and canonical identities", () => {
    const listing = {
      listingId: "listing-1",
      city: "New York",
      priceMinor: 100,
      bedrooms: 2,
      active: true,
      revision: 1
    }
    expect(listingFingerprint(listing)).toBe("New York\u0000100\u00002\u0000true")
    expect(searchCacheKey({ city: "New York", maximumPriceMinor: 100, minimumBedrooms: 2 })).toBe(
      "search:New%20York:100:2"
    )
    expect(() => validateListing({ ...listing, listingId: "bad id" })).toThrow("invalid listingId")
    expect(() => validateListing({ ...listing, city: "123" })).toThrow("invalid city")
    expect(() => validateListing({ ...listing, priceMinor: 0 })).toThrow("priceMinor")
    expect(() => validateListing({ ...listing, bedrooms: 101 })).toThrow("bedrooms")
    expect(() => validateListing({ ...listing, revision: 0 })).toThrow("revision")
    expect(() => validateSearch({ city: "123", maximumPriceMinor: 1, minimumBedrooms: 1 })).toThrow(
      "invalid city"
    )
    expect(() =>
      validateSearch({ city: "Paris", maximumPriceMinor: 0, minimumBedrooms: 1 })
    ).toThrow("maximumPriceMinor")
    expect(() =>
      validateSearch({ city: "Paris", maximumPriceMinor: 1, minimumBedrooms: 101 })
    ).toThrow("minimumBedrooms")
  })

  test("rejects malformed requests, malformed cache values, and cancelled contexts", async () => {
    const service = newRealEstateSearchService()
    const malformedBody = await service.handler(
      new Request("https://example.test/v1/listings", {
        method: "POST",
        body: JSON.stringify({ listingId: "only-id" })
      })
    )
    expect(malformedBody.status).toBe(400)
    const missingCity = await service.handler(
      new Request("https://example.test/v1/listings/search?maximumPriceMinor=1&minimumBedrooms=0")
    )
    expect(missingCity.status).toBe(400)
    const badInteger = await service.handler(
      new Request(
        "https://example.test/v1/listings/search?city=Paris&maximumPriceMinor=nope&minimumBedrooms=0"
      )
    )
    expect(badInteger.status).toBe(400)
    expect((await service.handler(new Request("https://example.test/nope"))).status).toBe(404)

    const repository = newMemoryListingRepository()
    const same = {
      listingId: "same",
      city: "Paris",
      priceMinor: 1,
      bedrooms: 0,
      active: true,
      revision: 1
    }
    expect(repository.upsert(background(), same)).toMatchObject({ applied: true })
    expect(repository.upsert(background(), same)).toEqual({ applied: false, affectedCities: [] })
    const samePrice = newMemoryListingRepository()
    samePrice.upsert(background(), {
      listingId: "z-listing",
      city: "Paris",
      priceMinor: 1,
      bedrooms: 1,
      active: true,
      revision: 1
    })
    samePrice.upsert(background(), {
      listingId: "a-listing",
      city: "Paris",
      priceMinor: 1,
      bedrooms: 1,
      active: true,
      revision: 1
    })
    expect(
      samePrice
        .search(background(), { city: "Paris", maximumPriceMinor: 1, minimumBedrooms: 1 })
        .map((item) => item.listingId)
    ).toEqual(["a-listing", "z-listing"])
    const canceled = withCancel(background())
    canceled[1]()
    expect(() =>
      repository.search(canceled[0], { city: "Paris", maximumPriceMinor: 1, minimumBedrooms: 0 })
    ).toThrow()
    expect(() =>
      repository.upsert(canceled[0], {
        listingId: "listing-1",
        city: "Paris",
        priceMinor: 1,
        bedrooms: 0,
        active: true,
        revision: 1
      })
    ).toThrow()

    const cache = newMemoryCache()
    const index = newRealEstateIndex(repository, cache)
    await cache.put(
      background(),
      searchCacheKey({ city: "Paris", maximumPriceMinor: 1, minimumBedrooms: 0 }),
      new TextEncoder().encode("null")
    )
    await expect(
      index.search(background(), { city: "Paris", maximumPriceMinor: 1, minimumBedrooms: 0 })
    ).rejects.toThrow("invalid cached listing result")
    await cache.put(
      background(),
      searchCacheKey({ city: "Paris", maximumPriceMinor: 1, minimumBedrooms: 0 }),
      new TextEncoder().encode("[{}]")
    )
    await expect(
      index.search(background(), { city: "Paris", maximumPriceMinor: 1, minimumBedrooms: 0 })
    ).rejects.toThrow("invalid cached listing")
  })

  test("invalidates caches for a listing moved between cities", async () => {
    const service = newRealEstateSearchService()
    await indexListing(service, "moved", "Paris", 1_000, 1, true, 1)
    await indexListing(service, "other", "Berlin", 1_500, 1, true, 1)
    await search(service, "Paris", 2_000, 1)
    await search(service, "Berlin", 2_000, 1)
    expect(service.repository.searches()).toBe(2)
    await indexListing(service, "moved", "Berlin", 1_200, 1, true, 2)
    await search(service, "Paris", 2_000, 1)
    await search(service, "Berlin", 2_000, 1)
    expect(service.repository.searches()).toBe(4)
  })
})
