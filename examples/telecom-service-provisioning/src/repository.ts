import type { Context } from "@likego/context"

import {
  sameProvisionCommand,
  type ProvisionedService,
  type ProvisionServiceCommand
} from "./service"

export interface ProvisioningRepository {
  activate(
    ctx: Context,
    command: ProvisionServiceCommand,
    monthlyFeeMinor: number
  ): ProvisionedService
  count(): number
}

/** Rejects repository work after its operation Context has ended. */
function checkContext(ctx: Context): void {
  const failure = ctx.err()
  if (failure !== null) throw failure
}

/** Creates an in-memory provisioning store with unique order and SIM admission. */
export function newMemoryProvisioningRepository(): ProvisioningRepository {
  const byOrder = new Map<string, ProvisionedService>()
  const simOwners = new Map<string, string>()
  return Object.freeze({
    /** Activates one service or returns the exact prior idempotent result. */
    activate(ctx: Context, command: ProvisionServiceCommand, feeMinor: number): ProvisionedService {
      checkContext(ctx)
      const existing = byOrder.get(command.orderId)
      if (existing !== undefined) {
        if (!sameProvisionCommand(existing, command)) {
          throw new Error("provisioning order identity conflict")
        }
        return existing
      }
      const simOwner = simOwners.get(command.simId)
      if (simOwner !== undefined && simOwner !== command.subscriberId) {
        throw new Error("SIM is already assigned to another subscriber")
      }
      const service: ProvisionedService = Object.freeze({
        orderId: command.orderId,
        subscriberId: command.subscriberId,
        simId: command.simId,
        plan: command.plan,
        monthlyFeeMinor: feeMinor,
        status: "active"
      })
      byOrder.set(command.orderId, service)
      simOwners.set(command.simId, command.subscriberId)
      return service
    },
    /** Returns the number of uniquely provisioned orders. */
    count(): number {
      return byOrder.size
    }
  })
}
