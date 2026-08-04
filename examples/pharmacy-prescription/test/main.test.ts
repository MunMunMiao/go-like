import { background, type Context } from "@go-like/context"
import { describe, expect, test } from "bun:test"
import { newPrescriptionHandler } from "../src/http"
import {
  newCancelPrescription,
  newDispensePrescription,
  newMemoryPharmacyInventory,
  newMemoryPrescriptionRepository,
  newRetryingPharmacyInventory,
  transientInventoryError,
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
})
