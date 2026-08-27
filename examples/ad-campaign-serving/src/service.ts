import { newMemoryCache, type MemoryCache } from "@go-like/cache-memory"
import type { Context } from "@go-like/context"
import {
  newCircuitBreaker,
  newTokenBucketLimiter,
  type CircuitState,
  type RateLimiter
} from "@go-like/resilience"
import type { Handler } from "@go-like/web"

import {
  newCachedCreativeGateway,
  newMemoryCampaignRepository,
  newMemoryCreativeSource,
  type CampaignRepository,
  type CreativeGateway
} from "./ad-resources"
import {
  validateAdRequest,
  type AdRequest,
  type CampaignDefinition,
  type ServedAd
} from "./campaigns"
import { newAdServingHandler } from "./http"

export type ServeAd = (ctx: Context, request: AdRequest) => Promise<ServedAd>

/** Creates ad serving with rate admission, creative protection, and budget commit. */
export function newServeAd(
  campaigns: CampaignRepository,
  creatives: CreativeGateway,
  limiter: RateLimiter
): ServeAd {
  return async function serveAd(ctx: Context, request: AdRequest): Promise<ServedAd> {
    validateAdRequest(request)
    if (!limiter.allow(ctx).allowed) throw new Error("ad request rate limit exceeded")
    const campaign = campaigns.select(ctx, request)
    const creative = await creatives.get(ctx, campaign.creativeId)
    const charge = campaigns.commit(ctx, request, campaign.id)
    return Object.freeze({
      requestId: charge.requestId,
      campaignId: charge.campaignId,
      chargedMinor: charge.chargedMinor,
      remainingBudgetMinor: charge.remainingBudgetMinor,
      creative
    })
  }
}

export interface AdCampaignService {
  readonly cache: MemoryCache
  readonly handler: Handler
  readonly creativeLoads: () => number
  readonly remainingBudget: (ctx: Context, campaignId: string) => number
  readonly circuitState: () => CircuitState
}

/** Composes the ad Handler with one immediately usable process-local cache. */
export function newAdCampaignService(
  campaigns: readonly CampaignDefinition[],
  creatives: Readonly<Record<string, string>>,
  rateLimitCapacity: number = 100
): AdCampaignService {
  const repository = newMemoryCampaignRepository(campaigns)
  const cache = newMemoryCache()
  const source = newMemoryCreativeSource(creatives)
  const breaker = newCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 60_000 })
  const limiter = newTokenBucketLimiter({
    capacity: rateLimitCapacity,
    refillTokens: rateLimitCapacity,
    refillIntervalMs: 60_000
  })
  const creativeGateway = newCachedCreativeGateway(cache, source, breaker)
  const serveAd = newServeAd(repository, creativeGateway, limiter)
  return Object.freeze({
    cache,
    handler: newAdServingHandler(serveAd),
    creativeLoads: source.loads,
    remainingBudget(ctx: Context, campaignId: string): number {
      return repository.remaining(ctx, campaignId)
    },
    circuitState(): CircuitState {
      return breaker.snapshot().state
    }
  })
}
