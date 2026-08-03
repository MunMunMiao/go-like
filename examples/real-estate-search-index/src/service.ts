import type { MemoryCache } from "@likego/cache-memory"
import type { Context } from "@likego/context"
import type { IndexChange, ListingRepository } from "./repository"

export interface ListingUpdate {
  readonly listingId: string
  readonly city: string
  readonly priceMinor: number
  readonly bedrooms: number
  readonly active: boolean
  readonly revision: number
}

export interface SearchQuery {
  readonly city: string
  readonly maximumPriceMinor: number
  readonly minimumBedrooms: number
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
const cityPattern = /^[A-Za-z][A-Za-z -]{0,63}$/

/** Validates one listing projection update at the application trust boundary. */
export function validateListing(update: ListingUpdate): void {
  if (!identifierPattern.test(update.listingId)) throw new TypeError("invalid listingId")
  if (!cityPattern.test(update.city)) throw new TypeError("invalid city")
  if (!Number.isSafeInteger(update.priceMinor) || update.priceMinor <= 0) {
    throw new RangeError("priceMinor must be a positive safe integer")
  }
  if (!Number.isSafeInteger(update.bedrooms) || update.bedrooms < 0 || update.bedrooms > 100) {
    throw new RangeError("bedrooms must be an integer from 0 through 100")
  }
  if (!Number.isSafeInteger(update.revision) || update.revision < 1) {
    throw new RangeError("revision must be a positive safe integer")
  }
}

/** Validates one bounded listing search query. */
export function validateSearch(query: SearchQuery): void {
  if (!cityPattern.test(query.city)) throw new TypeError("invalid city")
  if (!Number.isSafeInteger(query.maximumPriceMinor) || query.maximumPriceMinor <= 0) {
    throw new RangeError("maximumPriceMinor must be a positive safe integer")
  }
  if (
    !Number.isSafeInteger(query.minimumBedrooms) ||
    query.minimumBedrooms < 0 ||
    query.minimumBedrooms > 100
  ) {
    throw new RangeError("minimumBedrooms must be an integer from 0 through 100")
  }
}

/** Produces one stable content identity for same-revision conflict detection. */
export function listingFingerprint(update: ListingUpdate): string {
  return `${update.city}\u0000${update.priceMinor}\u0000${update.bedrooms}\u0000${update.active}`
}

/** Produces one canonical cache key for a listing search. */
export function searchCacheKey(query: SearchQuery): string {
  return `search:${encodeURIComponent(query.city)}:${query.maximumPriceMinor}:${query.minimumBedrooms}`
}

export interface RealEstateIndex {
  index(ctx: Context, update: ListingUpdate): Promise<IndexChange>
  search(ctx: Context, query: SearchQuery): Promise<readonly ListingUpdate[]>
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Converts unknown cached JSON into one listing projection. */
function listingFrom(value: unknown): ListingUpdate {
  if (value === null || typeof value !== "object") throw new TypeError("invalid cached listing")
  const listingId: unknown = Reflect.get(value, "listingId")
  const city: unknown = Reflect.get(value, "city")
  const priceMinor: unknown = Reflect.get(value, "priceMinor")
  const bedrooms: unknown = Reflect.get(value, "bedrooms")
  const active: unknown = Reflect.get(value, "active")
  const revision: unknown = Reflect.get(value, "revision")
  if (
    typeof listingId !== "string" ||
    typeof city !== "string" ||
    typeof priceMinor !== "number" ||
    typeof bedrooms !== "number" ||
    typeof active !== "boolean" ||
    typeof revision !== "number"
  ) {
    throw new TypeError("invalid cached listing")
  }
  const listing = Object.freeze({
    listingId,
    city,
    priceMinor,
    bedrooms,
    active,
    revision
  })
  validateListing(listing)
  return listing
}

/** Converts one cached JSON list without trusting its element shapes. */
function listingsFrom(value: unknown): readonly ListingUpdate[] {
  if (!Array.isArray(value)) throw new TypeError("invalid cached listing result")
  const listings: ListingUpdate[] = []
  for (const item of value) listings.push(listingFrom(item))
  return Object.freeze(listings)
}

/** Creates a search-index use case with explicit cache invalidation on applied revisions. */
export function newRealEstateIndex(
  repository: ListingRepository,
  cache: MemoryCache
): RealEstateIndex {
  const cacheKeysByCity = new Map<string, Set<string>>()

  /** Invalidates every observed search projection for one affected city. */
  async function invalidateCity(ctx: Context, city: string): Promise<void> {
    const keys = cacheKeysByCity.get(city)
    if (keys === undefined) return
    for (const key of keys) await cache.delete(ctx, key)
    cacheKeysByCity.delete(city)
  }

  return Object.freeze({
    async index(ctx: Context, update: ListingUpdate): Promise<IndexChange> {
      validateListing(update)
      const change = repository.upsert(ctx, update)
      if (!change.applied) return change
      for (const city of change.affectedCities) await invalidateCity(ctx, city)
      return change
    },
    async search(ctx: Context, query: SearchQuery): Promise<readonly ListingUpdate[]> {
      validateSearch(query)
      const key = searchCacheKey(query)
      const cached = await cache.get(ctx, key)
      if (cached !== null) return listingsFrom(JSON.parse(decoder.decode(cached)))
      const listings = repository.search(ctx, query)
      await cache.put(ctx, key, encoder.encode(JSON.stringify(listings)))
      const keys = cacheKeysByCity.get(query.city) ?? new Set<string>()
      keys.add(key)
      cacheKeysByCity.set(query.city, keys)
      return listings
    }
  })
}
