import { background } from "@likego/context"
import { name, newApp, server } from "@likego/core"
import { describe, expect, test } from "bun:test"
import { newAppointmentHandler } from "../src/http"
import {
  newBookAppointment,
  newCancelAppointment,
  newMemoryAppointmentRepository
} from "../src/service"
import { newAppointmentPolicyService, newValidatedBookAppointment } from "../src/transport"

describe("healthcare appointments", () => {
  test("rejects overlapping active slots for the same doctor", () => {
    const repository = newMemoryAppointmentRepository()
    const book = newBookAppointment(repository, () => 1_000)
    book(background(), {
      appointmentId: "a-1",
      doctorId: "doctor-1",
      patientId: "patient-1",
      startsAt: 2_000,
      endsAt: 3_000
    })

    expect(() =>
      book(background(), {
        appointmentId: "a-2",
        doctorId: "doctor-1",
        patientId: "patient-2",
        startsAt: 2_500,
        endsAt: 3_500
      })
    ).toThrow("doctor time conflict")
    expect(
      book(background(), {
        appointmentId: "a-3",
        doctorId: "doctor-2",
        patientId: "patient-2",
        startsAt: 2_500,
        endsAt: 3_500
      }).status
    ).toBe("booked")
  })

  test("releases a cancelled slot and keeps cancellation idempotent", () => {
    const repository = newMemoryAppointmentRepository()
    const book = newBookAppointment(repository, () => 1_000)
    const cancel = newCancelAppointment(repository)
    book(background(), {
      appointmentId: "a-1",
      doctorId: "doctor-1",
      patientId: "patient-1",
      startsAt: 2_000,
      endsAt: 3_000
    })

    expect(cancel(background(), "a-1").status).toBe("cancelled")
    expect(cancel(background(), "a-1").status).toBe("cancelled")
    expect(
      book(background(), {
        appointmentId: "a-2",
        doctorId: "doctor-1",
        patientId: "patient-2",
        startsAt: 2_000,
        endsAt: 3_000
      }).status
    ).toBe("booked")
  })

  test("exposes booking and cancellation through a standard Fetch handler", async () => {
    const repository = newMemoryAppointmentRepository()
    const handler = newAppointmentHandler(
      newBookAppointment(repository, () => 1_000),
      newCancelAppointment(repository)
    )
    const created = await handler(
      new Request("https://example.test/v1/appointments", {
        method: "POST",
        body: JSON.stringify({
          appointmentId: "web-1",
          doctorId: "doctor-1",
          patientId: "patient-1",
          startsAt: 2_000,
          endsAt: 3_000
        }),
        headers: { "content-type": "application/json" }
      })
    )
    expect(created.status).toBe(201)

    const cancelled = await handler(
      new Request("https://example.test/v1/appointments/web-1", { method: "DELETE" })
    )
    expect(cancelled.status).toBe(200)
    expect(await cancelled.json()).toMatchObject({ appointmentId: "web-1", status: "cancelled" })
  })

  test("checks appointment policy through LikeGo client, server and memory transport", async () => {
    const policy = newAppointmentPolicyService(3_600_000)
    const app = newApp(name("healthcare-appointments-test"), server(policy.server))
    const running = app.run()
    await policy.server.endpoint(background())
    const repository = newMemoryAppointmentRepository()
    const book = newValidatedBookAppointment(
      newBookAppointment(repository, () => 1_000),
      policy.validate
    )
    try {
      await expect(
        book(background(), {
          appointmentId: "remote-rejected",
          doctorId: "doctor-1",
          patientId: "patient-1",
          startsAt: 2_000,
          endsAt: 3_603_000
        })
      ).rejects.toMatchObject({ code: "appointment_policy_rejected", status: 409 })
      expect(repository.get(background(), "remote-rejected")).toBeUndefined()

      await expect(
        book(background(), {
          appointmentId: "remote-accepted",
          doctorId: "doctor-1",
          patientId: "patient-1",
          startsAt: 2_000,
          endsAt: 3_602_000
        })
      ).resolves.toMatchObject({ status: "booked" })
    } finally {
      await app.stop()
      await running
    }
  })
})
