import { newClient, withAddress, withTransport } from "@go-like/client"
import { background } from "@go-like/context"
import { name, newApp, server } from "@go-like/core"
import { describe, expect, spyOn, test } from "bun:test"
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

  test("reports malformed, missing and unsupported appointment HTTP operations", async () => {
    const repository = newMemoryAppointmentRepository()
    const handler = newAppointmentHandler(
      newBookAppointment(repository, () => 1_000),
      newCancelAppointment(repository)
    )

    const malformed = await handler(
      new Request("https://example.test/v1/appointments", {
        method: "POST",
        body: JSON.stringify({ appointmentId: "missing" })
      })
    )
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toMatchObject({
      code: "appointment_rejected",
      message: "invalid appointment command"
    })

    const missingId = await handler(
      new Request("https://example.test/v1/appointments/", { method: "DELETE" })
    )
    expect(missingId.status).toBe(400)
    expect(await missingId.json()).toMatchObject({
      code: "appointment_rejected",
      message: "invalid appointmentId"
    })

    const notFound = await handler(
      new Request("https://example.test/v1/appointments/web-unknown", { method: "GET" })
    )
    expect(notFound.status).toBe(404)
    expect(await notFound.json()).toEqual({ code: "not_found" })

    const missingAppointment = await handler(
      new Request("https://example.test/v1/appointments/unknown", { method: "DELETE" })
    )
    expect(missingAppointment.status).toBe(409)
    expect(await missingAppointment.json()).toMatchObject({
      code: "appointment_rejected",
      message: "appointment not found"
    })
  })

  test("enforces appointment identity and time validation at the service boundary", () => {
    const repository = newMemoryAppointmentRepository()
    const book = newBookAppointment(repository, () => 1_000)
    const command = Object.freeze({
      appointmentId: "same-id",
      doctorId: "doctor-1",
      patientId: "patient-1",
      startsAt: 2_000,
      endsAt: 3_000
    })
    expect(book(background(), command)).toBe(book(background(), command))
    expect(() => book(background(), { ...command, endsAt: 3_500, patientId: "patient-2" })).toThrow(
      "idempotency conflict"
    )
    expect(() =>
      book(background(), { ...command, appointmentId: "past", startsAt: 1_000 })
    ).toThrow("startsAt must be in the future")
    expect(() =>
      book(background(), { ...command, appointmentId: "bad-end", endsAt: 2_000 })
    ).toThrow("endsAt must be after startsAt")
  })

  test("rejects invalid policy configuration before transport startup", () => {
    expect(() => newAppointmentPolicyService(0)).toThrow(
      "maximumDurationMs must be a positive safe integer"
    )
  })

  test("rejects malformed policy messages over the public client and server transport", async () => {
    const policy = newAppointmentPolicyService()
    const app = newApp(name("healthcare-appointments-policy-boundary-test"), server(policy.server))
    const running = app.run()
    await policy.server.endpoint(background())
    const transport = policy.server.options().transport
    if (transport === null) throw new Error("policy server did not retain its transport")
    const client = newClient(withTransport(transport))
    const call = (body: string) =>
      client.call(
        background(),
        {
          service: "appointment-policy",
          endpoint: "AppointmentPolicy.Check",
          message: {
            header: Object.freeze({ "content-type": "application/json" }),
            body: new TextEncoder().encode(body)
          }
        },
        withAddress("memory://appointment-policy")
      )
    try {
      await expect(call("null")).rejects.toThrow("internal service error")
      await expect(call(JSON.stringify({ appointmentId: "only-id" }))).rejects.toThrow(
        "internal service error"
      )
    } finally {
      await client.close(background())
      await app.stop()
      await running
    }
  })

  test("rejects a policy response that does not allow the appointment", async () => {
    const policy = newAppointmentPolicyService()
    const app = newApp(
      name("healthcare-appointments-invalid-policy-response-test"),
      server(policy.server)
    )
    const running = app.run()
    await policy.server.endpoint(background())
    const originalParse = JSON.parse
    const parse = spyOn(JSON, "parse").mockImplementation((text) => {
      if (text === '{"allowed":true}') return { allowed: false }
      return originalParse(text)
    })
    try {
      await expect(
        policy.validate(background(), {
          appointmentId: "invalid-response",
          doctorId: "doctor-1",
          patientId: "patient-1",
          startsAt: 2_000,
          endsAt: 3_000
        })
      ).rejects.toThrow("appointment policy returned an invalid response")
    } finally {
      parse.mockRestore()
      await app.stop()
      await running
    }
  })

  test("checks appointment policy through go-like client, server and memory transport", async () => {
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
