import { struct } from "@go-like/struct"
import { defineService } from "@go-like/transport"

const provisionCommand = struct.object({
  orderId: struct.string(),
  subscriberId: struct.string(),
  simId: struct.string(),
  plan: struct.enum(["mobile-basic", "mobile-premium"])
})

const provisionedService = struct.object({
  orderId: struct.string(),
  subscriberId: struct.string(),
  simId: struct.string(),
  plan: struct.enum(["mobile-basic", "mobile-premium"]),
  monthlyFeeMinor: struct.number(),
  status: struct.literal("active")
})

/** Defines the internal telecom provisioning contract shared by Client and Server. */
export const telecomProvisioning = defineService("telecom-provisioning.v1", {
  activate: {
    request: provisionCommand,
    response: provisionedService
  }
})
