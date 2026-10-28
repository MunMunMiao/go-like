import { newClient, withEndpoint, withTransport, type CallOption } from "@go-like/client"
import type { Context } from "@go-like/context"
import { address, newServer, transport as serverTransport, type Server } from "@go-like/server"
import { serviceError } from "@go-like/transport"
import { newMemoryTransport } from "@go-like/transport-memory"

import { appointmentPolicy } from "./contract"
import type { Appointment, BookAppointment, BookAppointmentCommand } from "./service"

const PolicyAddress = "memory://appointment-policy.v1"

/** Validates one booking command against the internal appointment policy. */
export type ValidateAppointmentPolicy = (
  ctx: Context,
  command: BookAppointmentCommand,
  ...options: readonly CallOption[]
) => Promise<void>

/** Books one appointment after the policy call succeeds. */
export type ValidatedBookAppointment = (
  ctx: Context,
  command: BookAppointmentCommand
) => Promise<Appointment>

/** Owns the in-process appointment-policy Server and its validating caller. */
export interface AppointmentPolicyService {
  readonly server: Server
  readonly validate: ValidateAppointmentPolicy
}

/** Composes an internal unary appointment-policy service over the memory transport. */
export function newAppointmentPolicyService(
  maximumDurationMs: number = 7_200_000
): AppointmentPolicyService {
  if (!Number.isSafeInteger(maximumDurationMs) || maximumDurationMs <= 0) {
    throw new RangeError("maximumDurationMs must be a positive safe integer")
  }
  const transport = newMemoryTransport()
  const server = newServer(serverTransport(transport), address(PolicyAddress))
  appointmentPolicy.registerHandler(server, {
    check(_ctx, command) {
      if (command.endsAt - command.startsAt > maximumDurationMs) {
        throw serviceError(
          "appointment_policy_rejected",
          "appointment duration exceeds policy",
          409
        )
      }
      return { allowed: true as const }
    }
  })
  const caller = appointmentPolicy.newClient(
    newClient(withTransport(transport), withEndpoint(PolicyAddress))
  )
  return Object.freeze({
    server,
    async validate(
      ctx: Context,
      command: BookAppointmentCommand,
      ...options: readonly CallOption[]
    ): Promise<void> {
      await caller.check(ctx, command, ...options)
    }
  })
}

/** Composes internal policy validation before the existing booking use case. */
export function newValidatedBookAppointment(
  bookAppointment: BookAppointment,
  validatePolicy: ValidateAppointmentPolicy
): ValidatedBookAppointment {
  return async function validatedBookAppointment(
    ctx: Context,
    command: BookAppointmentCommand
  ): Promise<Appointment> {
    await validatePolicy(ctx, command)
    return bookAppointment(ctx, command)
  }
}
