import type { Context } from "@go-like/context"
import { contextHandler, type Handler } from "@go-like/web"
import type { Appointment, BookAppointmentCommand, CancelAppointment } from "./service"

type BookAppointmentEndpoint = (
  ctx: Context,
  command: BookAppointmentCommand
) => Appointment | Promise<Appointment>

function commandFrom(value: unknown): BookAppointmentCommand {
  if (value === null || typeof value !== "object") throw new TypeError("invalid JSON body")
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
    throw new TypeError("invalid appointment command")
  }
  return Object.freeze({ appointmentId, doctorId, patientId, startsAt, endsAt })
}

function failureResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : "appointment operation failed"
  const status = error instanceof TypeError || error instanceof RangeError ? 400 : 409
  return Response.json({ code: "appointment_rejected", message }, { status })
}

/** Creates the standard Fetch entrypoint for appointment operations. */
export function newAppointmentHandler(
  bookAppointment: BookAppointmentEndpoint,
  cancelAppointment: CancelAppointment
): Handler {
  return contextHandler(async function appointmentHandler(
    ctx: Context,
    request: Request
  ): Promise<Response> {
    const url = new URL(request.url)
    try {
      if (request.method === "POST" && url.pathname === "/v1/appointments") {
        const appointment = await bookAppointment(ctx, commandFrom(await request.json()))
        return Response.json(appointment, { status: 201 })
      }
      const prefix = "/v1/appointments/"
      if (request.method === "DELETE" && url.pathname.startsWith(prefix)) {
        const appointmentId = decodeURIComponent(url.pathname.slice(prefix.length))
        if (appointmentId.length === 0) throw new TypeError("invalid appointmentId")
        return Response.json(cancelAppointment(ctx, appointmentId))
      }
      return Response.json({ code: "not_found" }, { status: 404 })
    } catch (error) {
      return failureResponse(error)
    }
  })
}
