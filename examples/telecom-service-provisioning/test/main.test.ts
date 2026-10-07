import type { CallOption, Client } from "@go-like/client"
import { background } from "@go-like/context"
import { name, newApp, server } from "@go-like/core"
import { describe, expect, test } from "bun:test"

import { telecomProvisioning } from "../src/contract"
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

  test("rejects invalid provisioning identities and unsupported plans", async () => {
    const provision = newProvisionTelecomService(newMemoryProvisioningRepository())
    await expect(
      provision(background(), {
        orderId: "bad order",
        subscriberId: "subscriber-1",
        simId: "sim-1",
        plan: "mobile-basic"
      })
    ).rejects.toThrow("invalid provisioning identity")
    await expect(
      provision(background(), {
        orderId: "order-1",
        subscriberId: "subscriber-1",
        simId: "sim-1",
        plan: "unsupported" as never
      })
    ).rejects.toThrow("unsupported telecom plan")
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

  test("rejects commands after their Context is canceled", async () => {
    const repository = newMemoryProvisioningRepository()
    const provision = newProvisionTelecomService(repository)
    const context = {
      err() {
        return new Error("operation canceled")
      }
    } as never
    await expect(
      provision(context, {
        orderId: "order-1",
        subscriberId: "subscriber-1",
        simId: "sim-1",
        plan: "mobile-basic"
      })
    ).rejects.toThrow("operation canceled")
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

  test("maps public route, malformed body, and provisioning failures", async () => {
    const notFoundHandler = newTelecomProvisioningHandler(async function unusedProvision() {
      throw new Error("must not call")
    })
    expect((await notFoundHandler(new Request("https://example.test/wrong"))).status).toBe(404)
    const invalidHandler = newTelecomProvisioningHandler(async function unusedProvision() {
      throw new Error("must not call")
    })
    const invalid = await invalidHandler(
      new Request("https://example.test/v1/telecom-services", {
        method: "POST",
        body: "not-json"
      })
    )
    expect(invalid.status).toBe(409)
    const nullBody = await invalidHandler(
      new Request("https://example.test/v1/telecom-services", {
        method: "POST",
        body: JSON.stringify(null)
      })
    )
    expect(nullBody.status).toBe(400)
    const incomplete = await invalidHandler(
      new Request("https://example.test/v1/telecom-services", {
        method: "POST",
        body: JSON.stringify({ orderId: "order-1" })
      })
    )
    expect(incomplete.status).toBe(400)
    const rejectedHandler = newTelecomProvisioningHandler(async function rejectProvision() {
      throw new Error("provisioning dependency failed")
    })
    const rejected = await rejectedHandler(
      new Request("https://example.test/v1/telecom-services", {
        method: "POST",
        body: JSON.stringify({
          orderId: "order-1",
          subscriberId: "subscriber-1",
          simId: "sim-1",
          plan: "mobile-basic"
        })
      })
    )
    expect(rejected.status).toBe(409)
    expect(await rejected.json()).toMatchObject({
      code: "provisioning_rejected",
      message: "provisioning dependency failed"
    })
  })

  test("creates a typed telecom client that preserves codec, options and errors", async () => {
    const ctx = background()
    const command: ProvisionServiceCommand = Object.freeze({
      orderId: "client-order",
      subscriberId: "subscriber-1",
      simId: "sim-1",
      plan: "mobile-premium"
    })
    const result = Object.freeze({
      ...command,
      monthlyFeeMinor: 5_900,
      status: "active" as const
    })
    const option: CallOption = (options) => options
    const failure = new Error("telecom service unavailable")
    let rejected = false
    let observed: readonly unknown[] = Object.freeze([])
    const client = Object.freeze({
      async call(...args: readonly unknown[]) {
        observed = args
        if (rejected) throw failure
        return result
      },
      async close(): Promise<void> {}
    }) as unknown as Client
    expect(telecomProvisioning.endpoints.activate).toMatchObject({
      service: "telecom-provisioning.v1",
      endpoint: "activate"
    })
    const provision = telecomProvisioning.newClient(client).activate

    expect(await provision(ctx, command, option)).toEqual(result)
    expect(observed).toEqual([ctx, telecomProvisioning.endpoints.activate, command, option])
    rejected = true
    await expect(provision(ctx, command)).rejects.toBe(failure)
  })

  test("rejects invalid internal messages and service responses", async () => {
    const repository = newMemoryProvisioningRepository()
    const service = newTelecomProvisioningMicroservice(newProvisionTelecomService(repository))
    const app = newApp(name("telecom-invalid-message"), server(service.server))
    const running = app.run()
    await service.server.endpoint(background())
    try {
      await expect(service.client.activate(background(), null as never)).rejects.toThrow()
      await expect(
        service.client.activate(background(), {
          orderId: "order-1",
          subscriberId: "subscriber-1",
          simId: "sim-1",
          plan: "landline"
        } as never)
      ).rejects.toThrow()
      await expect(
        service.client.activate(background(), {
          orderId: "order-1",
          subscriberId: "subscriber-1",
          simId: "sim-1",
          plan: "mobile-basic"
        })
      ).resolves.toMatchObject({ status: "active" })
      expect(repository.count()).toBe(1)
    } finally {
      await app.stop()
      await running
    }

    const invalidServer = newTelecomProvisioningMicroservice(async () => {
      return {
        orderId: "order-1",
        subscriberId: "subscriber-1",
        simId: "sim-1",
        plan: "mobile-basic",
        monthlyFeeMinor: 2_900,
        status: "paused"
      } as never
    })
    const invalidApp = newApp(name("telecom-invalid-response"), server(invalidServer.server))
    const invalidRunning = invalidApp.run()
    await invalidServer.server.endpoint(background())
    try {
      await expect(
        invalidServer.client.activate(background(), {
          orderId: "order-1",
          subscriberId: "subscriber-1",
          simId: "sim-1",
          plan: "mobile-basic"
        })
      ).rejects.toThrow("internal service error")
    } finally {
      await invalidApp.stop()
      await invalidRunning
    }
  })

  test("calls the internal service through go-like Memory Transport", async () => {
    const repository = newMemoryProvisioningRepository()
    const service = newTelecomProvisioningMicroservice(newProvisionTelecomService(repository))
    const handler = newTelecomProvisioningHandler(service.client.activate)
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
