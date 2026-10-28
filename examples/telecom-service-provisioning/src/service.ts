import type { Context } from "@go-like/context"
import type { ProvisioningRepository } from "./repository"

const publicId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export type TelecomPlan = "mobile-basic" | "mobile-premium"

export interface ProvisionServiceCommand {
  readonly orderId: string
  readonly subscriberId: string
  readonly simId: string
  readonly plan: TelecomPlan
}

export interface ProvisionedService extends ProvisionServiceCommand {
  readonly monthlyFeeMinor: number
  readonly status: "active"
}

/** Validates one telecom provisioning command before resource admission. */
export function validateProvisionCommand(command: ProvisionServiceCommand): void {
  if (
    !publicId.test(command.orderId) ||
    !publicId.test(command.subscriberId) ||
    !publicId.test(command.simId)
  ) {
    throw new TypeError("invalid provisioning identity")
  }
  if (command.plan !== "mobile-basic" && command.plan !== "mobile-premium") {
    throw new TypeError("unsupported telecom plan")
  }
}

/** Returns the fixed integer monthly fee for one admitted plan. */
export function monthlyFeeMinor(plan: TelecomPlan): number {
  return plan === "mobile-basic" ? 2_900 : 5_900
}

/** Reports whether one result represents an identical idempotent command. */
export function sameProvisionCommand(
  service: ProvisionedService,
  command: ProvisionServiceCommand
): boolean {
  return (
    service.orderId === command.orderId &&
    service.subscriberId === command.subscriberId &&
    service.simId === command.simId &&
    service.plan === command.plan
  )
}

export type ProvisionTelecomService = (
  ctx: Context,
  command: ProvisionServiceCommand
) => Promise<ProvisionedService>

/** Creates the idempotent telecom provisioning use case. */
export function newProvisionTelecomService(
  repository: ProvisioningRepository
): ProvisionTelecomService {
  return async function provisionTelecomService(
    ctx: Context,
    command: ProvisionServiceCommand
  ): Promise<ProvisionedService> {
    validateProvisionCommand(command)
    return repository.activate(ctx, command, monthlyFeeMinor(command.plan))
  }
}
