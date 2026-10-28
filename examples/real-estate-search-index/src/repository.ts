import type { Context } from "@go-like/context"

import { listingFingerprint, type ListingUpdate, type SearchQuery } from "./service"

export interface IndexChange {
  readonly applied: boolean
  readonly affectedCities: readonly string[]
}

export interface ListingRepository {
  upsert(ctx: Context, update: ListingUpdate): IndexChange
  search(ctx: Context, query: SearchQuery): readonly ListingUpdate[]
  searches(): number
}

/** Rejects work admitted from an already terminal Context. */
function checkContext(ctx: Context): void {
  const failure = ctx.err()
  if (failure !== null) throw failure
}

/** Copies one listing projection into immutable repository state. */
function snapshotListing(update: ListingUpdate): ListingUpdate {
  return Object.freeze({
    listingId: update.listingId,
    city: update.city,
    priceMinor: update.priceMinor,
    bedrooms: update.bedrooms,
    active: update.active,
    revision: update.revision
  })
}

/** Creates a process-local revision-aware listing projection repository. */
export function newMemoryListingRepository(): ListingRepository {
  const listings = new Map<string, ListingUpdate>()
  let searchCount = 0
  return Object.freeze({
    upsert(ctx: Context, update: ListingUpdate): IndexChange {
      checkContext(ctx)
      const previous = listings.get(update.listingId)
      if (previous !== undefined) {
        if (update.revision < previous.revision) {
          return Object.freeze({ applied: false, affectedCities: Object.freeze([]) })
        }
        if (update.revision === previous.revision) {
          if (listingFingerprint(update) !== listingFingerprint(previous)) {
            throw new Error("listing revision conflict")
          }
          return Object.freeze({ applied: false, affectedCities: Object.freeze([]) })
        }
      }
      listings.set(update.listingId, snapshotListing(update))
      const affectedCities: string[] = []
      if (previous !== undefined && previous.city !== update.city) {
        affectedCities.push(previous.city)
      }
      affectedCities.push(update.city)
      return Object.freeze({ applied: true, affectedCities: Object.freeze(affectedCities) })
    },
    search(ctx: Context, query: SearchQuery): readonly ListingUpdate[] {
      checkContext(ctx)
      searchCount += 1
      const matched: ListingUpdate[] = []
      for (const listing of listings.values()) {
        if (
          listing.active &&
          listing.city === query.city &&
          listing.priceMinor <= query.maximumPriceMinor &&
          listing.bedrooms >= query.minimumBedrooms
        ) {
          matched.push(listing)
        }
      }
      matched.sort(function compare(first, second): number {
        if (first.priceMinor !== second.priceMinor) return first.priceMinor - second.priceMinor
        return first.listingId.localeCompare(second.listingId)
      })
      return Object.freeze(matched)
    },
    searches(): number {
      return searchCount
    }
  })
}
