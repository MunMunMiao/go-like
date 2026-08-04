import { background } from "@go-like/context"
import { describe, expect, test } from "bun:test"

import { newRealEstateSearchService } from "../src/cache"

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
})
