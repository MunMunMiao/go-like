import { background, withCancel } from "@go-like/context"
import { fromClientContext, get, values, type Metadata } from "@go-like/metadata"
import { describe, expect, test } from "bun:test"
import { newLaboratoryResultHandler } from "../src/http"
import {
  newLaboratoryProbeRegistry,
  newMemoryLaboratoryResultRepository,
  newMemoryResultAuditSink,
  newRecordLaboratoryResult,
  newSafeResultAuditSink,
  withLaboratoryServerMetadata
} from "../src/service"

const encounter = Object.freeze({
  encounterId: "encounter-1",
  patientId: "patient-1",
  orderingClinicianId: "clinician-1"
})

const command = Object.freeze({
  resultId: "result-1",
  encounterId: "encounter-1",
  patientId: "patient-1",
  orderingClinicianId: "clinician-1",
  testCode: "HB",
  value: "sensitive-result-value"
})

describe("laboratory results", () => {
  test("rejects a result that does not match the registered encounter", () => {
    const repository = newMemoryLaboratoryResultRepository({ encounters: [encounter] })
    const audit = newMemoryResultAuditSink()
    const record = newRecordLaboratoryResult(repository, audit)

    expect(() =>
      record(
        background(),
        Object.freeze({
          resultId: "wrong-patient",
          encounterId: "encounter-1",
          patientId: "patient-2",
          orderingClinicianId: "clinician-1",
          testCode: "HB",
          value: "must-not-be-stored"
        })
      )
    ).toThrow("result does not match encounter")
    expect(repository.get(background(), "wrong-patient")).toBeUndefined()
    expect(audit.events(background())).toHaveLength(0)
  })

  test("stores the clinical value but emits only the safe audit contract", () => {
    const repository = newMemoryLaboratoryResultRepository({ encounters: [encounter] })
    const audit = newMemoryResultAuditSink()
    const receipt = newRecordLaboratoryResult(repository, audit)(background(), command)

    expect(receipt).toEqual({
      resultId: "result-1",
      encounterId: "encounter-1",
      status: "accepted"
    })
    expect(repository.get(background(), "result-1")?.value).toBe("sensitive-result-value")
    const serializedAudit = JSON.stringify(audit.events(background()))
    expect(serializedAudit).not.toContain("sensitive-result-value")
    expect(serializedAudit).not.toContain("patient-1")
  })

  test("binds encounter metadata and omits the result value from Fetch responses", async () => {
    const repository = newMemoryLaboratoryResultRepository({ encounters: [encounter] })
    const handler = newLaboratoryResultHandler(
      newRecordLaboratoryResult(repository, newMemoryResultAuditSink())
    )
    const accepted = await handler(
      new Request("https://example.test/v1/laboratory-results", {
        method: "POST",
        body: JSON.stringify(command),
        headers: {
          "content-type": "application/json",
          "x-encounter-id": "encounter-1"
        }
      })
    )
    expect(accepted.status).toBe(202)
    const responseBody = JSON.stringify(await accepted.json())
    expect(responseBody).not.toContain("sensitive-result-value")
    expect(responseBody).not.toContain("patient-1")

    const mismatch = await handler(
      new Request("https://example.test/v1/laboratory-results", {
        method: "POST",
        body: JSON.stringify(command),
        headers: {
          "content-type": "application/json",
          "x-encounter-id": "encounter-2"
        }
      })
    )
    expect(mismatch.status).toBe(400)
  })

  test("propagates only safe metadata to the downstream audit service", () => {
    const repository = newMemoryLaboratoryResultRepository({ encounters: [encounter] })
    const forwarded: Metadata[] = []
    const audit = newSafeResultAuditSink({
      write(ctx): void {
        const metadata = fromClientContext(ctx)
        if (metadata === null) throw new Error("downstream metadata is missing")
        forwarded.push(metadata)
      }
    })
    const ctx = withLaboratoryServerMetadata(background(), {
      authorization: "Bearer sensitive-token",
      cookie: "session=sensitive",
      "patient-id": "patient-1",
      "result-value": "sensitive-result-value",
      "x-encounter-id": "encounter-1",
      "x-request-id": ["request-1", "request-1-retry"]
    })

    newRecordLaboratoryResult(repository, audit)(ctx, command)

    const metadata = forwarded[0]
    if (metadata === undefined) throw new Error("audit metadata was not observed")
    expect(get(metadata, "x-encounter-id")).toBe("encounter-1")
    expect(values(metadata, "x-request-id")).toEqual(["request-1", "request-1-retry"])
    expect(get(metadata, "authorization")).toBeNull()
    expect(get(metadata, "cookie")).toBeNull()
    expect(get(metadata, "patient-id")).toBeNull()
    expect(get(metadata, "result-value")).toBeNull()
  })

  test("reports encounter-index readiness without leaking clinical identifiers", async () => {
    const repository = newMemoryLaboratoryResultRepository({ encounters: [encounter] })
    const probes = newLaboratoryProbeRegistry(repository, "encounter-1")
    const ready = await probes.check(background(), "ready")
    expect(ready).toMatchObject({ ok: true, checks: [{ name: "laboratory.encounter-index" }] })
    const live = await probes.check(background(), "live")
    expect(live).toMatchObject({ ok: true, checks: [{ name: "laboratory.receiver" }] })

    const unavailable = await newLaboratoryProbeRegistry(repository, "missing").check(
      background(),
      "ready"
    )
    expect(unavailable.ok).toBe(false)
    expect(unavailable.checks[0]?.error?.message).toBe("encounter index is unavailable")
    expect(JSON.stringify(unavailable)).not.toContain("patient-1")
  })

  test("validates laboratory identifiers, test codes, values, and repository idempotency", () => {
    const repository = newMemoryLaboratoryResultRepository({ encounters: [encounter] })
    const audit = newMemoryResultAuditSink()
    const record = newRecordLaboratoryResult(repository, audit)

    for (const [field, value] of [
      ["resultId", ""],
      ["encounterId", ""],
      ["patientId", ""],
      ["orderingClinicianId", ""]
    ] as const) {
      expect(() => record(background(), { ...command, [field]: value })).toThrow(`invalid ${field}`)
    }
    expect(() => record(background(), { ...command, testCode: "test code" })).toThrow(
      "invalid testCode"
    )
    expect(() => record(background(), { ...command, value: "" })).toThrow(
      "invalid result value length"
    )
    expect(() => record(background(), { ...command, value: "x".repeat(4_097) })).toThrow(
      "invalid result value length"
    )

    expect(record(background(), command)).toEqual(record(background(), command))
    expect(() => repository.save(background(), { ...command, value: "changed" })).toThrow(
      "idempotency conflict"
    )
  })

  test("rejects missing and malformed HTTP requests without storing a result", async () => {
    const repository = newMemoryLaboratoryResultRepository({ encounters: [encounter] })
    const handler = newLaboratoryResultHandler(
      newRecordLaboratoryResult(repository, newMemoryResultAuditSink())
    )
    const notFound = await handler(new Request("https://example.test/v1/other", { method: "GET" }))
    expect(notFound.status).toBe(404)

    const invalidShape = await handler(
      new Request("https://example.test/v1/laboratory-results", {
        method: "POST",
        body: JSON.stringify({ ...command, value: 123 })
      })
    )
    expect(invalidShape.status).toBe(400)
    expect(await invalidShape.json()).toMatchObject({ code: "laboratory_result_rejected" })

    const missingHeader = await handler(
      new Request("https://example.test/v1/laboratory-results", {
        method: "POST",
        body: JSON.stringify(command)
      })
    )
    expect(missingHeader.status).toBe(400)

    const unknownEncounter = await handler(
      new Request("https://example.test/v1/laboratory-results", {
        method: "POST",
        body: JSON.stringify({ ...command, encounterId: "missing" }),
        headers: { "x-encounter-id": "missing" }
      })
    )
    expect(unknownEncounter.status).toBe(409)
  })

  test("propagates terminal Context failures through repositories, audit, and probes", async () => {
    const repository = newMemoryLaboratoryResultRepository({ encounters: [encounter] })
    const audit = newMemoryResultAuditSink()
    const [ctx, cancel] = withCancel(background())
    cancel()
    expect(() => repository.encounter(ctx, "encounter-1")).toThrow()
    expect(() => repository.save(ctx, command)).toThrow()
    expect(() => repository.get(ctx, "result-1")).toThrow()
    expect(() =>
      audit.write(ctx, {
        action: "laboratory_result_accepted",
        resultId: "result-1",
        encounterId: "encounter-1",
        testCode: "HB"
      })
    ).toThrow()
    expect(() => audit.events(ctx)).toThrow()
    const probes = newLaboratoryProbeRegistry(repository, "encounter-1")
    expect((await probes.check(ctx, "live")).ok).toBe(false)
    expect((await probes.check(ctx, "ready")).ok).toBe(false)
  })
})
