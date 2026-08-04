import { newMemoryCache, type MemoryCache } from "@go-like/cache-memory"
import type { Handler } from "@go-like/web"

import { newRealEstateHandler } from "./http"
import { newMemoryListingRepository, type ListingRepository } from "./repository"
import { newRealEstateIndex } from "./service"

export interface RealEstateSearchService {
  readonly cache: MemoryCache
  readonly handler: Handler
  readonly repository: ListingRepository
}

/** Composes the search handler with its projection-cache resource. */
export function newRealEstateSearchService(): RealEstateSearchService {
  const repository = newMemoryListingRepository()
  const cache = newMemoryCache()
  const index = newRealEstateIndex(repository, cache)
  return Object.freeze({
    cache,
    handler: newRealEstateHandler(index),
    repository
  })
}
