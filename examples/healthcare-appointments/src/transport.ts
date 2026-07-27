import { newClient, withAddress, withTransport } from "@likego/client"
import type { Context } from "@likego/context"
import {
  address,
  handler,
  newServer,
  transport as serverTransport,
  type Server
} from "@likego/server"
import { serviceError, type Message } from "@likego/transport"
import { newMemoryTransport } from "@likego/transport-memory"
import type { Appointment, BookAppointment, BookAppointmentCommand } from "./service"

const Encoder = new TextEncoder()
const Decoder = new TextDecoder("utf-8", { fatal: true })
const PolicyServiceName = "appointment-policy"
const PolicyEndpointName = "AppointmentPolicy.Check"
const PolicyAddress = "memory://appointment-policy"
export type ValidateAppointmentPolicy = (
  ctx: Context,
  command: BookAppointmentCommand
) => Promise<void>

export type ValidatedBookAppointment = (
  ctx: Context,
  command: BookAppointmentCommand
) => Promise<Appointment>

export interface AppointmentPolicyService {
  readonly server: Server
  readonly validate: ValidateAppointmentPolicy
}

/** Decodes only the policy fields used by the internal service boundary. */
function policyCommand(message: Message): BookAppointmentCommand {
  const value: unknown = JSON.parse(Decoder.decode(message.body))
  if (value === null || typeof value !== "object") {
    throw new TypeError("invalid appointment policy request")
  }
  const appointmentId: unknown = Reflect.get(value, "appointmentId")
  const doctorId: unknown = Reflect.get(value, "doctorId")
  const patientId: unknown = Reflect.get(value, "patientId")
  const startsAt: unknown = Reflect.get(value, "startsAt")
  const endsAt: unknown = Reflect.get(value, "endsAt")
  if (
    typeof appointmentId !== "string" ||
    typeof doctorId !== "string" ||
    typeof patientId !== "string" ||
    typeof startsAt !== "number" ||
    typeof endsAt !== "number"
  ) {
    throw new TypeError("invalid appointment policy request")
  }
  return Object.freeze({ appointmentId, doctorId, patientId, startsAt, endsAt })
}

/** Composes an internal unary appointment-policy service over the memory transport. */
export function newAppointmentPolicyService(
  maximumDurationMs: number = 7_200_000
): AppointmentPolicyService {
  if (!Number.isSafeInteger(maximumDurationMs) || maximumDurationMs <= 0) {
    throw new RangeError("maximumDurationMs must be a positive safe integer")
  }
  const transport = newMemoryTransport()
  const server = newServer(
    serverTransport(transport),
    address(PolicyAddress),
    handler(
      PolicyServiceName,
      PolicyEndpointName,
      function validatePolicy(_ctx: Context, request: Message): Message {
        const command = policyCommand(request)
        if (command.endsAt - command.startsAt > maximumDurationMs) {
          throw serviceError(
            "appointment_policy_rejected",
            "appointment duration exceeds policy",
            409
          )
        }
        return Object.freeze({
          header: Object.freeze({ "content-type": "application/json" }),
          body: Encoder.encode('{"allowed":true}')
        })
      }
    )
  )
  const client = newClient(withTransport(transport))

  return Object.freeze({
    server,
    async validate(callContext: Context, command: BookAppointmentCommand): Promise<void> {
      const response = await client.call(
        callContext,
        {
          service: PolicyServiceName,
          endpoint: PolicyEndpointName,
          message: {
            header: Object.freeze({ "content-type": "application/json" }),
            body: Encoder.encode(JSON.stringify(command))
          }
        },
        withAddress(PolicyAddress)
      )
      const result: unknown = JSON.parse(Decoder.decode(response.body))
      if (
        result === null ||
        typeof result !== "object" ||
        Reflect.get(result, "allowed") !== true
      ) {
        throw new Error("appointment policy returned an invalid response")
      }
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
