/** Describes one idempotent advertising opportunity. */
export interface AdRequest {
  readonly requestId: string
  readonly placement: string
  readonly audienceSegment: string
}

export interface CampaignDefinition {
  readonly id: string
  readonly placement: string
  readonly audienceSegments: readonly string[]
  readonly creativeId: string
  readonly bidMinor: number
  readonly budgetMinor: number
  readonly active: boolean
}

export interface CampaignCharge {
  readonly requestId: string
  readonly campaignId: string
  readonly chargedMinor: number
  readonly remainingBudgetMinor: number
}

export interface ServedAd extends CampaignCharge {
  readonly creative: string
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
const targetingPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** Validates one ad request at the application trust boundary. */
export function validateAdRequest(request: AdRequest): void {
  if (!identifierPattern.test(request.requestId)) throw new TypeError("invalid requestId")
  if (!targetingPattern.test(request.placement)) throw new TypeError("invalid placement")
  if (!targetingPattern.test(request.audienceSegment)) {
    throw new TypeError("invalid audienceSegment")
  }
}

/** Validates one campaign before it enters the serving repository. */
export function validateCampaign(campaign: CampaignDefinition): void {
  if (!identifierPattern.test(campaign.id)) throw new TypeError("invalid campaign id")
  if (!targetingPattern.test(campaign.placement)) throw new TypeError("invalid campaign placement")
  if (!identifierPattern.test(campaign.creativeId)) throw new TypeError("invalid creativeId")
  if (!Number.isSafeInteger(campaign.bidMinor) || campaign.bidMinor <= 0) {
    throw new RangeError("bidMinor must be a positive safe integer")
  }
  if (!Number.isSafeInteger(campaign.budgetMinor) || campaign.budgetMinor < 0) {
    throw new RangeError("budgetMinor must be a non-negative safe integer")
  }
  if (campaign.audienceSegments.length === 0) {
    throw new TypeError("campaign requires at least one audience segment")
  }
  for (const segment of campaign.audienceSegments) {
    if (!targetingPattern.test(segment)) throw new TypeError("invalid campaign audience segment")
  }
}

/** Reports whether a campaign may compete for this impression. */
export function campaignEligible(
  campaign: CampaignDefinition,
  request: AdRequest,
  remainingBudgetMinor: number
): boolean {
  return (
    campaign.active &&
    campaign.placement === request.placement &&
    campaign.audienceSegments.includes(request.audienceSegment) &&
    remainingBudgetMinor >= campaign.bidMinor
  )
}

/** Produces the stable payload fingerprint for idempotency-key conflict detection. */
export function adRequestFingerprint(request: AdRequest): string {
  return `${request.placement}\u0000${request.audienceSegment}`
}
