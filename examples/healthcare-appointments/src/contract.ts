import { struct } from "@go-like/struct"
import { defineService } from "@go-like/transport"

const appointmentPolicyCommand = struct.object({
  appointmentId: struct.string(),
  doctorId: struct.string(),
  patientId: struct.string(),
  startsAt: struct.number(),
  endsAt: struct.number()
})

const appointmentPolicyDecision = struct.object({
  allowed: struct.literal(true)
})

/** Defines the internal appointment-policy contract shared by Client and Server. */
export const appointmentPolicy = defineService("appointment-policy.v1", {
  check: {
    request: appointmentPolicyCommand,
    response: appointmentPolicyDecision
  }
})
