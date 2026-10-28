import { background, type Context } from "@go-like/context"
import { describe, expect, test } from "bun:test"
import { newPrescriptionHandler } from "../src/http"
import {
  isTransientInventoryError,
  newCancelPrescription,
  newDispensePrescription,
  newMemoryPharmacyInventory,
  newMemoryPrescriptionRepository,
  newRetryingPharmacyInventory,
  transientInventoryError,
  validateDispensePrescription,
  validatePrescription,
  type PharmacyInventory,
  type Prescription
} from "../src/service"

function issuedPrescription(quantity: number = 2): Prescription {
  return Object.freeze({
    prescriptionId: "rx-1",
    patientId: "patient-1",
    drugCode: "drug-a",
    quantity,
    status: "issued"
  })
}

describe("pharmacy prescription", () => {
  test("does not mark a prescription dispensed when stock fails", async () => {
    const repository = newMemoryPrescriptionRepository({
      prescriptions: [issuedPrescription(3)]
    })
    const inventory = newMemoryPharmacyInventory({ stock: { "drug-a": 2 } })
    const dispense = newDispensePrescription(repository, inventory)

    await expect(
      dispense(background(), { requestId: "request-1", prescriptionId: "rx-1" })
    ).rejects.toThrow("insufficient pharmacy stock")
    expect(repository.get(background(), "rx-1")?.status).toBe("issued")
    expect(inventory.available(background(), "drug-a")).toBe(2)
  })

  test("dispenses once and keeps an idempotent retry from taking stock twice", async () => {
    const repository = newMemoryPrescriptionRepository({
      prescriptions: [issuedPrescription()]
    })
    const inventory = newMemoryPharmacyInventory({ stock: { "drug-a": 5 } })
    const dispense = newDispensePrescription(repository, inventory)
    const command = { requestId: "request-1", prescriptionId: "rx-1" }

    expect((await dispense(background(), command)).status).toBe("dispensed")
    expect((await dispense(background(), command)).status).toBe("dispensed")
    expect(inventory.available(background(), "drug-a")).toBe(3)
  })

  test("enforces legal cancellation and exposes the workflow through Fetch", async () => {
    const repository = newMemoryPrescriptionRepository({
      prescriptions: [issuedPrescription()]
    })
    const inventory = newMemoryPharmacyInventory({ stock: { "drug-a": 5 } })
    await newDispensePrescription(repository, inventory)(background(), {
      requestId: "request-1",
      prescriptionId: "rx-1"
    })
    expect(() => newCancelPrescription(repository)(background(), "rx-1")).toThrow(
      "illegal prescription transition"
    )

    const webRepository = newMemoryPrescriptionRepository({
      prescriptions: [issuedPrescription()]
    })
    const response = await newPrescriptionHandler(
      newDispensePrescription(
        webRepository,
        newMemoryPharmacyInventory({ stock: { "drug-a": 5 } })
      ),
      newCancelPrescription(webRepository)
    )(
      new Request("https://example.test/v1/prescriptions/rx-1/dispense", {
        method: "POST",
        body: JSON.stringify({ requestId: "web-1" }),
        headers: { "content-type": "application/json" }
      })
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      prescriptionId: "rx-1",
      status: "dispensed"
    })
  })

  test("retries only transient inventory failures and preserves one stock deduction", async () => {
    const repository = newMemoryPrescriptionRepository({
      prescriptions: [issuedPrescription()]
    })
    const inventory = newMemoryPharmacyInventory({ stock: { "drug-a": 5 } })
    let attempts = 0
    const flakyGateway: PharmacyInventory = Object.freeze({
      take(
        ctx: Context,
        requestId: string,
        drugCode: string,
        quantity: number
      ): void | Promise<void> {
        attempts += 1
        const committed = inventory.take(ctx, requestId, drugCode, quantity)
        if (attempts === 1) throw transientInventoryError("inventory response was lost")
        return committed
      },
      available(ctx: Context, drugCode: string): number {
        return inventory.available(ctx, drugCode)
      }
    })
    const dispense = newDispensePrescription(repository, newRetryingPharmacyInventory(flakyGateway))

    await expect(
      dispense(background(), { requestId: "retry-1", prescriptionId: "rx-1" })
    ).resolves.toMatchObject({ status: "dispensed" })
    expect(attempts).toBe(2)
    expect(inventory.available(background(), "drug-a")).toBe(3)
  })

  test("does not retry permanent inventory failures", async () => {
    const repository = newMemoryPrescriptionRepository({
      prescriptions: [issuedPrescription(3)]
    })
    const inventory = newMemoryPharmacyInventory({ stock: { "drug-a": 2 } })
    let attempts = 0
    const permanentGateway: PharmacyInventory = Object.freeze({
      take(
        ctx: Context,
        requestId: string,
        drugCode: string,
        quantity: number
      ): void | Promise<void> {
        attempts += 1
        return inventory.take(ctx, requestId, drugCode, quantity)
      },
      available(ctx: Context, drugCode: string): number {
        return inventory.available(ctx, drugCode)
      }
    })

    await expect(
      newDispensePrescription(repository, newRetryingPharmacyInventory(permanentGateway))(
        background(),
        { requestId: "permanent-1", prescriptionId: "rx-1" }
      )
    ).rejects.toThrow("insufficient pharmacy stock")
    expect(attempts).toBe(1)
    expect(repository.get(background(), "rx-1")?.status).toBe("issued")
  })

  test("covers prescription, repository, inventory and HTTP boundary errors", async () => {
    expect(() =>
      validateDispensePrescription({ requestId: "bad id", prescriptionId: "rx-1" })
    ).toThrow("invalid requestId")
    expect(() =>
      validateDispensePrescription({ requestId: "request-1", prescriptionId: "bad id" })
    ).toThrow("invalid prescriptionId")
    expect(() =>
      validatePrescription({ ...issuedPrescription(), prescriptionId: "bad id" })
    ).toThrow("invalid prescriptionId")
    expect(() => validatePrescription({ ...issuedPrescription(), patientId: "bad id" })).toThrow(
      "invalid patientId"
    )
    expect(() => validatePrescription({ ...issuedPrescription(), drugCode: "bad code" })).toThrow(
      "invalid drugCode"
    )
    expect(() => validatePrescription({ ...issuedPrescription(), quantity: 0 })).toThrow(
      "quantity must be a positive safe integer"
    )
    expect(() => newMemoryPharmacyInventory({ stock: { "drug-a": -1 } })).toThrow("invalid stock")
    expect(isTransientInventoryError(transientInventoryError("temporary"))).toBe(true)
    expect(isTransientInventoryError(new Error("permanent"))).toBe(false)
    expect(() =>
      newRetryingPharmacyInventory(newMemoryPharmacyInventory({ stock: {} }), 0)
    ).toThrow("maxAttempts must be a positive safe integer")

    const repository = newMemoryPrescriptionRepository({
      prescriptions: [
        issuedPrescription(),
        { ...issuedPrescription(), prescriptionId: "rx-cancel", status: "cancelled" },
        { ...issuedPrescription(), prescriptionId: "rx-issued-cancel", status: "issued" },
        { ...issuedPrescription(), prescriptionId: "rx-available-cancel", status: "issued" },
        { ...issuedPrescription(), prescriptionId: "rx-dispensed", status: "dispensed" },
        { ...issuedPrescription(), prescriptionId: "rx-dispensed-mapped", status: "issued" }
      ]
    })
    const inventory = newMemoryPharmacyInventory({ stock: { "drug-a": 5 } })
    const retryingInventory = newRetryingPharmacyInventory(inventory)
    const dispense = newDispensePrescription(repository, retryingInventory)
    await expect(
      dispense(background(), { requestId: "missing", prescriptionId: "unknown" })
    ).rejects.toThrow("prescription not found")
    await expect(
      dispense(background(), { requestId: "cancel-request", prescriptionId: "rx-cancel" })
    ).rejects.toThrow("prescription is not dispensable")
    expect(repository.cancel(background(), "rx-cancel").status).toBe("cancelled")
    expect(repository.cancel(background(), "rx-cancel").status).toBe("cancelled")
    expect(repository.cancel(background(), "rx-available-cancel").status).toBe("cancelled")
    await expect(
      dispense(background(), { requestId: "dispensed-request", prescriptionId: "rx-dispensed" })
    ).rejects.toThrow("prescription is not dispensable")
    repository.markDispensed(background(), "rx-dispensed-mapped", "dispensed-request")
    expect(
      repository.markDispensed(background(), "rx-dispensed-mapped", "dispensed-request").status
    ).toBe("dispensed")
    expect(() => repository.markDispensed(background(), "unknown", "request-unknown")).toThrow(
      "prescription not found"
    )
    await dispense(background(), { requestId: "request-dispense", prescriptionId: "rx-1" })
    await expect(
      dispense(background(), { requestId: "request-dispense", prescriptionId: "rx-issued-cancel" })
    ).rejects.toThrow("idempotency conflict")
    expect(() => repository.markDispensed(background(), "rx-1", "request-dispense")).not.toThrow()
    expect(() =>
      repository.markDispensed(background(), "rx-issued-cancel", "request-dispense")
    ).toThrow("idempotency conflict")
    expect(() => repository.markDispensed(background(), "rx-1", "request-other")).toThrow(
      "illegal prescription transition"
    )
    expect(() =>
      repository.markDispensed(background(), "rx-issued-cancel", "request-different")
    ).not.toThrow()
    expect(retryingInventory.available(background(), "drug-a")).toBe(3)
    expect(() => inventory.take(background(), "inventory-1", "unknown", 1)).toThrow("unknown drug")
    expect(() => inventory.available(background(), "unknown")).toThrow("unknown drug")
    inventory.take(background(), "inventory-1", "drug-a", 1)
    expect(() => inventory.take(background(), "inventory-1", "drug-a", 2)).toThrow(
      "inventory idempotency conflict"
    )

    const handler = newPrescriptionHandler(
      newDispensePrescription(repository, inventory),
      newCancelPrescription(repository)
    )
    const conflictHandler = newPrescriptionHandler(async () => {
      throw new Error("idempotency conflict")
    }, newCancelPrescription(repository))
    const conflictResponse = await conflictHandler(
      new Request("https://example.test/v1/prescriptions/rx-1/dispense", {
        method: "POST",
        body: JSON.stringify({ requestId: "request-conflict" })
      })
    )
    expect(conflictResponse.status).toBe(409)
    expect(
      (
        await handler(
          new Request("https://example.test/v1/prescriptions/rx-1/dispense", { method: "GET" })
        )
      ).status
    ).toBe(404)
    const invalidBody = await handler(
      new Request("https://example.test/v1/prescriptions/rx-1/dispense", {
        method: "POST",
        body: JSON.stringify({})
      })
    )
    expect(invalidBody.status).toBe(400)
    expect(await invalidBody.json()).toMatchObject({ code: "prescription_rejected" })
    const missingDelete = await handler(
      new Request("https://example.test/v1/prescriptions/unknown", { method: "DELETE" })
    )
    expect(missingDelete.status).toBe(409)
    const emptyPath = await handler(
      new Request("https://example.test/v1/prescriptions/", { method: "DELETE" })
    )
    expect(emptyPath.status).toBe(404)
  })
})
