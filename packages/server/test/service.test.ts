import { background, type Context } from "@go-like/context"
import { newClient, withEndpoint, withRetry, withTransport } from "@go-like/client"
import { struct } from "@go-like/struct"
import { defineService, type ServiceHandler } from "@go-like/transport"
import { describe, expect, test } from "bun:test"
import { newMemoryTransport } from "@go-like/transport-memory"

import { address, newServer, transport } from "../src/index"

const request = struct.object({ value: struct.number() })
const response = struct.object({ value: struct.number() })
const payments = defineService("payments.v1", {
  add: { request, response },
  health: { response }
})

describe("defineService server integration", () => {
  test("registers one class handler on two memory servers", async () => {
    const memory = newMemoryTransport()
    const first = newServer(transport(memory), address("memory://payments-one"))
    const second = newServer(transport(memory), address("memory://payments-two"))
    class Implementation {
      readonly offset = 2

      add(_ctx: Context, value: { value: number }): { value: number } {
        return { value: value.value + this.offset }
      }

      health(_ctx: Context): { value: number } {
        return { value: this.offset }
      }
    }
    const handler: ServiceHandler<typeof payments> = new Implementation()
    payments.registerHandler(first, handler)
    payments.registerHandler(second, handler)
    const firstRunning = first.start(background())
    const secondRunning = second.start(background())
    await Promise.all([first.endpoint(background()), second.endpoint(background())])
    const firstConn = newClient(withTransport(memory), withEndpoint("memory://payments-one"))
    const secondConn = newClient(withTransport(memory), withEndpoint("memory://payments-two"))
    const retry = withRetry({
      authorization: "idempotent",
      maxAttempts: 2,
      shouldRetry: () => false
    })
    try {
      const firstProxy = payments.newClient(firstConn)
      const secondProxy = payments.newClient(secondConn)
      await expect(firstProxy.add(background(), { value: 3 }, retry)).resolves.toEqual({
        value: 5
      })
      await expect(firstProxy.health(background(), retry)).resolves.toEqual({ value: 2 })
      await expect(secondProxy.add(background(), { value: 4 })).resolves.toEqual({ value: 6 })
      await expect(
        firstConn.call(background(), payments.endpoints.add, { value: 1 })
      ).resolves.toEqual({ value: 3 })
      await expect(firstProxy.add(background(), { value: "no" } as never)).rejects.toThrow()
    } finally {
      await Promise.all([firstConn.close(background()), secondConn.close(background())])
      await Promise.all([first.stop(background()), second.stop(background())])
      await Promise.all([firstRunning, secondRunning])
    }
  })
})
