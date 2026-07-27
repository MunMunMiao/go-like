import { background } from "@likego/context"
import { name, newApp, server } from "@likego/core"
import { describe, expect, test } from "bun:test"

import { newTelecomProvisioningHandler } from "../src/http"
import { newMemoryProvisioningRepository } from "../src/repository"
import { newProvisionTelecomService, type ProvisionServiceCommand } from "../src/service"
import { newTelecomProvisioningMicroservice } from "../src/transport"

describe("telecom service provisioning", () => {
  test("maps only admitted plans to fixed integer monthly fees", async () => {
    const provision = newProvisionTelecomService(newMemoryProvisioningRepository())
    await expect(
      provision(background(), {
        orderId: "order-basic",
        subscriberId: "subscriber-1",
        simId: "sim-1",
        plan: "mobile-basic"
      })
    ).resolves.toMatchObject({ status: "active", monthlyFeeMinor: 2_900 })
    await expect(
      provision(background(), {
        orderId: "order-premium",
        subscriberId: "subscriber-2",
        simId: "sim-2",
        plan: "mobile-premium"
      })
    ).resolves.toMatchObject({ status: "active", monthlyFeeMinor: 5_900 })
  })

  test("keeps identical order retries idempotent and rejects identity conflicts", async () => {
    const repository = newMemoryProvisioningRepository()
    const provision = newProvisionTelecomService(repository)
    const command: ProvisionServiceCommand = Object.freeze({
      orderId: "order-1",
      subscriberId: "subscriber-1",
      simId: "sim-1",
      plan: "mobile-basic"
    })
    const first = await provision(background(), command)
    expect(await provision(background(), command)).toBe(first)
    expect(repository.count()).toBe(1)
    await expect(
      provision(background(), {
        orderId: "order-1",
        subscriberId: "subscriber-1",
        simId: "sim-2",
        plan: "mobile-basic"
      })
    ).rejects.toThrow("provisioning order identity conflict")
  })

  test("never assigns one SIM to different subscribers", async () => {
    const provision = newProvisionTelecomService(newMemoryProvisioningRepository())
    await provision(background(), {
      orderId: "order-1",
      subscriberId: "subscriber-1",
      simId: "sim-1",
      plan: "mobile-basic"
    })
    await expect(
      provision(background(), {
        orderId: "order-2",
        subscriberId: "subscriber-2",
        simId: "sim-1",
        plan: "mobile-premium"
      })
    ).rejects.toThrow("SIM is already assigned to another subscriber")
  })

  test("calls the internal service through LikeGo Memory Transport", async () => {
    const repository = newMemoryProvisioningRepository()
    const service = newTelecomProvisioningMicroservice(newProvisionTelecomService(repository))
    const handler = newTelecomProvisioningHandler(service.client)
    const app = newApp(name("telecom-service-provisioning-transport-test"), server(service.server))
    const running = app.run()
    await service.server.endpoint(background())
    try {
      const response = await handler(
        new Request("https://example.test/v1/telecom-services", {
          method: "POST",
          body: JSON.stringify({
            orderId: "web-order",
            subscriberId: "subscriber-1",
            simId: "sim-1",
            plan: "mobile-premium"
          })
        })
      )
      expect(response.status).toBe(201)
      expect(await response.json()).toMatchObject({
        orderId: "web-order",
        status: "active",
        monthlyFeeMinor: 5_900
      })
      expect(repository.count()).toBe(1)
    } finally {
      await app.stop()
      await running
    }
  })
})
