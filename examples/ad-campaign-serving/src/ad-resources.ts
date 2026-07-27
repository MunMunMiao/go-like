import type { MemoryCache } from "@likego/cache-memory"
import type { Context } from "@likego/context"
import type { CircuitBreaker } from "@likego/resilience"

import {
  adRequestFingerprint,
  campaignEligible,
  validateCampaign,
  type AdRequest,
  type CampaignCharge,
  type CampaignDefinition
} from "./campaigns"

export interface CampaignRepository {
  select(ctx: Context, request: AdRequest): CampaignDefinition
  commit(ctx: Context, request: AdRequest, campaignId: string): CampaignCharge
  remaining(ctx: Context, campaignId: string): number
}

export interface CreativeSource {
  load(ctx: Context, creativeId: string): Promise<string>
  loads(): number
}

export interface CreativeGateway {
  get(ctx: Context, creativeId: string): Promise<string>
}

interface SavedCharge {
  readonly fingerprint: string
  readonly charge: CampaignCharge
}

/** Rejects work admitted from an already terminal Context. */
function checkContext(ctx: Context): void {
  const failure = ctx.err()
  if (failure !== null) throw failure
}

/** Copies one campaign definition so callers cannot mutate serving policy after admission. */
function snapshotCampaign(campaign: CampaignDefinition): CampaignDefinition {
  const segments: string[] = []
  for (const segment of campaign.audienceSegments) segments.push(segment)
  return Object.freeze({
    id: campaign.id,
    placement: campaign.placement,
    audienceSegments: Object.freeze(segments),
    creativeId: campaign.creativeId,
    bidMinor: campaign.bidMinor,
    budgetMinor: campaign.budgetMinor,
    active: campaign.active
  })
}

/** Creates a single-process campaign repository with atomic budget commits. */
export function newMemoryCampaignRepository(
  campaigns: readonly CampaignDefinition[]
): CampaignRepository {
  const definitions = new Map<string, CampaignDefinition>()
  const remaining = new Map<string, number>()
  const served = new Map<string, SavedCharge>()
  for (const candidate of campaigns) {
    validateCampaign(candidate)
    if (definitions.has(candidate.id)) throw new Error("duplicate campaign id")
    const campaign = snapshotCampaign(candidate)
    definitions.set(campaign.id, campaign)
    remaining.set(campaign.id, campaign.budgetMinor)
  }

  /** Returns the exact remaining budget for one known campaign. */
  function remainingFor(campaignId: string): number {
    const value = remaining.get(campaignId)
    if (value === undefined) throw new Error("unknown campaign")
    return value
  }

  return Object.freeze({
    select(ctx: Context, request: AdRequest): CampaignDefinition {
      checkContext(ctx)
      const saved = served.get(request.requestId)
      if (saved !== undefined) {
        if (saved.fingerprint !== adRequestFingerprint(request)) {
          throw new Error("idempotency conflict")
        }
        const previous = definitions.get(saved.charge.campaignId)
        if (previous === undefined) throw new Error("saved campaign is unavailable")
        return previous
      }
      let winner: CampaignDefinition | null = null
      for (const campaign of definitions.values()) {
        if (!campaignEligible(campaign, request, remainingFor(campaign.id))) continue
        if (
          winner === null ||
          campaign.bidMinor > winner.bidMinor ||
          (campaign.bidMinor === winner.bidMinor && campaign.id < winner.id)
        ) {
          winner = campaign
        }
      }
      if (winner === null) throw new Error("no eligible campaign")
      return winner
    },
    commit(ctx: Context, request: AdRequest, campaignId: string): CampaignCharge {
      checkContext(ctx)
      const fingerprint = adRequestFingerprint(request)
      const saved = served.get(request.requestId)
      if (saved !== undefined) {
        if (saved.fingerprint !== fingerprint) throw new Error("idempotency conflict")
        return saved.charge
      }
      const campaign = definitions.get(campaignId)
      if (campaign === undefined) throw new Error("unknown campaign")
      const available = remainingFor(campaignId)
      if (!campaignEligible(campaign, request, available)) {
        throw new Error("campaign is no longer eligible")
      }
      const charge = Object.freeze({
        requestId: request.requestId,
        campaignId,
        chargedMinor: campaign.bidMinor,
        remainingBudgetMinor: available - campaign.bidMinor
      })
      remaining.set(campaignId, charge.remainingBudgetMinor)
      served.set(request.requestId, Object.freeze({ fingerprint, charge }))
      return charge
    },
    remaining(ctx: Context, campaignId: string): number {
      checkContext(ctx)
      return remainingFor(campaignId)
    }
  })
}

/** Creates an observable process-local creative source. */
export function newMemoryCreativeSource(
  creatives: Readonly<Record<string, string>>
): CreativeSource {
  const values = new Map<string, string>()
  let loadCount = 0
  for (const [creativeId, creative] of Object.entries(creatives)) {
    values.set(creativeId, creative)
  }
  return Object.freeze({
    async load(ctx: Context, creativeId: string): Promise<string> {
      checkContext(ctx)
      loadCount += 1
      const creative = values.get(creativeId)
      if (creative === undefined) throw new Error("creative is unavailable")
      return creative
    },
    loads(): number {
      return loadCount
    }
  })
}

/** Creates a cache-first creative gateway protected by a LikeGo circuit breaker. */
export function newCachedCreativeGateway(
  cache: MemoryCache,
  source: CreativeSource,
  breaker: CircuitBreaker
): CreativeGateway {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  return Object.freeze({
    async get(ctx: Context, creativeId: string): Promise<string> {
      const cached = await cache.get(ctx, `creative:${creativeId}`)
      if (cached !== null) return decoder.decode(cached)
      const creative = await breaker.execute(ctx, function load(loadCtx): Promise<string> {
        return source.load(loadCtx, creativeId)
      })
      await cache.put(ctx, `creative:${creativeId}`, encoder.encode(creative))
      return creative
    }
  })
}
