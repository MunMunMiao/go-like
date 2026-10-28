import {
  newConfig,
  source,
  objectSource,
  type Config,
  type ConfigObject,
  type ConfigValue
} from "@go-like/config"
import type { Context } from "@go-like/context"

import {
  newChangeSubscription,
  newMemoryBillingAdjustmentRepository,
  type BillingAdjustment,
  type ChangeSubscription,
  type ChangeSubscriptionCommand
} from "./service"

export interface BillingPolicy {
  readonly maximumAdjustmentCents: number
}

export interface SubscriptionBillingService {
  readonly config: Config<ConfigObject>
  readonly change: ChangeSubscription
}

/** Reads and validates the billing policy from one Config value. */
function billingPolicyFrom(maximumAdjustmentCents: ConfigValue | null): BillingPolicy {
  if (
    typeof maximumAdjustmentCents !== "number" ||
    !Number.isSafeInteger(maximumAdjustmentCents) ||
    maximumAdjustmentCents < 1
  ) {
    throw new RangeError("maximumAdjustmentCents must be a positive safe integer")
  }
  return Object.freeze({ maximumAdjustmentCents })
}

/** Reads the current loaded policy after the deterministic domain calculation. */
function withBillingConfig(
  change: ChangeSubscription,
  config: Config<ConfigObject>
): ChangeSubscription {
  return function configuredChange(
    ctx: Context,
    command: ChangeSubscriptionCommand
  ): BillingAdjustment {
    const adjustment = change(ctx, command)
    const policy = billingPolicyFrom(config.value("maximumAdjustmentCents").load())
    if (Math.abs(adjustment.amountCents) > policy.maximumAdjustmentCents) {
      throw new RangeError("billing adjustment exceeds configured maximum")
    }
    return adjustment
  }
}

/** Creates a billing service whose Config lifecycle is owned by the application. */
export function newSubscriptionBillingService(document: ConfigObject): SubscriptionBillingService {
  const config = newConfig(source(objectSource("subscription-billing", document)))
  const change = withBillingConfig(
    newChangeSubscription(newMemoryBillingAdjustmentRepository()),
    config
  )
  return Object.freeze({
    config,
    change
  })
}
