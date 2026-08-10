import { background } from "@go-like/context"
import { name, newApp, server } from "@go-like/core"
import { describe, expect, test } from "bun:test"

import { newGovernmentPermitService } from "../src/service"
import { newMemoryPermitRepository, newSubmitPermit } from "../src/permits"

/** Submits one permit through the public Fetch boundary. */
function submit(
  service: ReturnType<typeof newGovernmentPermitService>,
  applicationId: string,
  permitType: "renovation" | "restaurant",
  documents: readonly string[]
): Promise<Response> {
  return Promise.resolve(
    service.handler(
      new Request("https://example.test/v1/permits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          applicationId,
          applicantId: "applicant-one",
          permitType,
          documents
        })
      })
    )
  )
}

/** Reads one permit through the public Fetch boundary. */
function get(
  service: ReturnType<typeof newGovernmentPermitService>,
  applicationId: string
): Promise<Response> {
  return Promise.resolve(
    service.handler(new Request(`https://example.test/v1/permits/${applicationId}`))
  )
}

/** Lets Core own one permit worker for the duration of an assertion. */
async function withWorker(
  service: ReturnType<typeof newGovernmentPermitService>,
  run: () => Promise<void>
): Promise<void> {
  const app = newApp(name("government-permit-workflow-test"), server(service.worker))
  const running = app.run()
  await Promise.resolve()
  await Promise.resolve()
  try {
    await run()
  } finally {
    await app.stop()
    await running
  }
}

describe("government permit workflow", () => {
  test("keeps duplicate submissions idempotent and rejects conflicting reuse", async () => {
    const service = newGovernmentPermitService()
    const documents = Object.freeze(["identity", "site-plan"])
    const first = await submit(service, "permit-one", "renovation", documents)
    const retry = await submit(service, "permit-one", "renovation", documents)
    const conflict = await submit(service, "permit-one", "restaurant", documents)
    expect(await first.json()).toEqual(await retry.json())
    expect(conflict.status).toBe(409)
  })

  test("does not review permits before Core starts the worker", async () => {
    const service = newGovernmentPermitService()
    await submit(
      service,
      "permit-before-start",
      "renovation",
      Object.freeze(["identity", "site-plan"])
    )
    expect(() => service.worker.processNext(background())).toThrow(
      "permit review worker is not running"
    )
    expect(service.worker.diagnostics()).toEqual({ status: "idle", reviewed: 0 })
  })

  test("requests missing fire-safety evidence for restaurant permits", async () => {
    const service = newGovernmentPermitService()
    await submit(service, "restaurant-one", "restaurant", Object.freeze(["identity", "site-plan"]))
    await withWorker(service, async function review(): Promise<void> {
      expect(service.worker.processNext(background())).toMatchObject({
        status: "needs_information",
        missingDocuments: ["fire-safety"]
      })
      expect(await (await get(service, "restaurant-one")).json()).toMatchObject({
        status: "needs_information"
      })
    })
    expect(service.worker.diagnostics()).toEqual({ status: "stopped", reviewed: 1 })
  })

  test("approves a complete renovation and drains the worker cleanly", async () => {
    const service = newGovernmentPermitService()
    await submit(service, "renovation-one", "renovation", Object.freeze(["site-plan", "identity"]))
    await withWorker(service, async function review(): Promise<void> {
      expect(service.worker.processNext(background())).toMatchObject({
        status: "approved",
        missingDocuments: []
      })
    })
    expect(() => service.worker.processNext(background())).toThrow(
      "permit review worker is not running"
    )
  })

  test("returns null when a running worker has no pending permits", async () => {
    const service = newGovernmentPermitService()
    await withWorker(service, async function drainEmptyQueue(): Promise<void> {
      expect(service.worker.processNext(background())).toBeNull()
    })
    expect(service.worker.diagnostics()).toEqual({ status: "stopped", reviewed: 0 })
  })

  test("rejects malformed Fetch commands and reports missing permits", async () => {
    const service = newGovernmentPermitService()

    const malformedJson = await service.handler(
      new Request("https://example.test/v1/permits", {
        method: "POST",
        body: JSON.stringify(null)
      })
    )
    expect(malformedJson.status).toBe(400)
    expect(await malformedJson.json()).toMatchObject({
      code: "permit_rejected",
      message: "invalid JSON body"
    })

    const invalidType = await service.handler(
      new Request("https://example.test/v1/permits", {
        method: "POST",
        body: JSON.stringify({
          applicationId: "bad-type",
          applicantId: "applicant-one",
          permitType: "construction",
          documents: []
        })
      })
    )
    expect(invalidType.status).toBe(400)
    expect(await invalidType.json()).toMatchObject({
      code: "permit_rejected",
      message: "invalid permitType"
    })

    const invalidDocuments = await service.handler(
      new Request("https://example.test/v1/permits", {
        method: "POST",
        body: JSON.stringify({
          applicationId: "bad-documents",
          applicantId: "applicant-one",
          permitType: "renovation",
          documents: ["identity", 7]
        })
      })
    )
    expect(invalidDocuments.status).toBe(400)
    expect(await invalidDocuments.json()).toMatchObject({
      code: "permit_rejected",
      message: "documents must contain strings"
    })

    const notFound = await service.handler(
      new Request("https://example.test/v1/unknown", { method: "GET" })
    )
    expect(notFound.status).toBe(404)

    const missing = await get(service, "does-not-exist")
    expect(missing.status).toBe(409)
    expect(await missing.json()).toMatchObject({
      code: "permit_rejected",
      message: "permit application not found"
    })
  })

  test("rejects invalid identifiers, missing fields and duplicate documents", async () => {
    const service = newGovernmentPermitService()
    const invalidIdentifier = await service.handler(
      new Request("https://example.test/v1/permits", {
        method: "POST",
        body: JSON.stringify({
          applicationId: "bad id",
          applicantId: "applicant-one",
          permitType: "renovation",
          documents: []
        })
      })
    )
    expect(invalidIdentifier.status).toBe(400)
    expect(await invalidIdentifier.json()).toMatchObject({
      code: "permit_rejected",
      message: "invalid applicationId"
    })

    const missingApplicant = await service.handler(
      new Request("https://example.test/v1/permits", {
        method: "POST",
        body: JSON.stringify({
          applicationId: "missing-applicant",
          permitType: "renovation",
          documents: []
        })
      })
    )
    expect(missingApplicant.status).toBe(400)
    expect(await missingApplicant.json()).toMatchObject({
      code: "permit_rejected",
      message: "invalid permit submission"
    })

    const duplicateDocuments = await service.handler(
      new Request("https://example.test/v1/permits", {
        method: "POST",
        body: JSON.stringify({
          applicationId: "duplicate-documents",
          applicantId: "applicant-one",
          permitType: "renovation",
          documents: ["identity", "identity"]
        })
      })
    )
    expect(duplicateDocuments.status).toBe(409)
    expect(await duplicateDocuments.json()).toMatchObject({
      code: "permit_rejected",
      message: "duplicate document"
    })

    const submit = newSubmitPermit(newMemoryPermitRepository())
    expect(() =>
      submit(background(), {
        applicationId: "invalid-type",
        applicantId: "applicant-one",
        permitType: "unsupported" as never,
        documents: []
      })
    ).toThrow("invalid permitType")
  })
})
