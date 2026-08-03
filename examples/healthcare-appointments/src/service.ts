import type { Context } from "@likego/context"

export interface BookAppointmentCommand {
  readonly appointmentId: string
  readonly doctorId: string
  readonly patientId: string
  readonly startsAt: number
  readonly endsAt: number
}

export type AppointmentStatus = "booked" | "cancelled"

export interface Appointment {
  readonly appointmentId: string
  readonly doctorId: string
  readonly patientId: string
  readonly startsAt: number
  readonly endsAt: number
  readonly status: AppointmentStatus
}

export interface AppointmentRepository {
  book(ctx: Context, command: BookAppointmentCommand): Appointment
  cancel(ctx: Context, appointmentId: string): Appointment
  get(ctx: Context, appointmentId: string): Appointment | undefined
}

export type BookAppointment = (ctx: Context, command: BookAppointmentCommand) => Appointment
export type CancelAppointment = (ctx: Context, appointmentId: string) => Appointment

interface SavedAppointment {
  readonly fingerprint: string
  readonly appointment: Appointment
}

function validId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value)
}

/** Validates an appointment request at the application trust boundary. */
export function validateAppointment(command: BookAppointmentCommand, now: number): void {
  if (!validId(command.appointmentId)) throw new TypeError("invalid appointmentId")
  if (!validId(command.doctorId)) throw new TypeError("invalid doctorId")
  if (!validId(command.patientId)) throw new TypeError("invalid patientId")
  if (!Number.isSafeInteger(command.startsAt) || command.startsAt <= now) {
    throw new RangeError("startsAt must be in the future")
  }
  if (!Number.isSafeInteger(command.endsAt) || command.endsAt <= command.startsAt) {
    throw new RangeError("endsAt must be after startsAt")
  }
}

function appointmentFingerprint(command: BookAppointmentCommand): string {
  return [
    command.doctorId,
    command.patientId,
    String(command.startsAt),
    String(command.endsAt)
  ].join("\u0000")
}

function overlaps(
  leftStartsAt: number,
  leftEndsAt: number,
  rightStartsAt: number,
  rightEndsAt: number
): boolean {
  return leftStartsAt < rightEndsAt && rightStartsAt < leftEndsAt
}

/** Creates a memory repository with one synchronous doctor-calendar critical section. */
export function newMemoryAppointmentRepository(): AppointmentRepository {
  const appointments = new Map<string, SavedAppointment>()

  return Object.freeze({
    book(ctx: Context, command: BookAppointmentCommand): Appointment {
      const failure = ctx.err()
      if (failure !== null) throw failure
      const fingerprint = appointmentFingerprint(command)
      const saved = appointments.get(command.appointmentId)
      if (saved !== undefined) {
        if (saved.fingerprint !== fingerprint) throw new Error("idempotency conflict")
        return saved.appointment
      }
      for (const candidate of appointments.values()) {
        const appointment = candidate.appointment
        if (
          appointment.status === "booked" &&
          appointment.doctorId === command.doctorId &&
          overlaps(appointment.startsAt, appointment.endsAt, command.startsAt, command.endsAt)
        ) {
          throw new Error("doctor time conflict")
        }
      }
      const appointment: Appointment = Object.freeze({
        appointmentId: command.appointmentId,
        doctorId: command.doctorId,
        patientId: command.patientId,
        startsAt: command.startsAt,
        endsAt: command.endsAt,
        status: "booked"
      })
      appointments.set(command.appointmentId, Object.freeze({ fingerprint, appointment }))
      return appointment
    },
    cancel(ctx: Context, appointmentId: string): Appointment {
      const failure = ctx.err()
      if (failure !== null) throw failure
      const saved = appointments.get(appointmentId)
      if (saved === undefined) throw new Error("appointment not found")
      if (saved.appointment.status === "cancelled") return saved.appointment
      const appointment: Appointment = Object.freeze({
        appointmentId: saved.appointment.appointmentId,
        doctorId: saved.appointment.doctorId,
        patientId: saved.appointment.patientId,
        startsAt: saved.appointment.startsAt,
        endsAt: saved.appointment.endsAt,
        status: "cancelled"
      })
      appointments.set(
        appointmentId,
        Object.freeze({ fingerprint: saved.fingerprint, appointment })
      )
      return appointment
    },
    get(ctx: Context, appointmentId: string): Appointment | undefined {
      const failure = ctx.err()
      if (failure !== null) throw failure
      return appointments.get(appointmentId)?.appointment
    }
  })
}

/** Creates the booking use case with an injectable clock. */
export function newBookAppointment(
  repository: AppointmentRepository,
  now: () => number = Date.now
): BookAppointment {
  return function bookAppointment(ctx: Context, command: BookAppointmentCommand): Appointment {
    validateAppointment(command, now())
    return repository.book(ctx, command)
  }
}

/** Creates the cancellation use case. */
export function newCancelAppointment(repository: AppointmentRepository): CancelAppointment {
  return function cancelAppointment(ctx: Context, appointmentId: string): Appointment {
    return repository.cancel(ctx, appointmentId)
  }
}
