import { describe, expect, test } from "bun:test"

import { background, withCancelCause } from "@go-like/context"

import { newMemoryMDNSNetwork } from "../src/testing"

describe("portable in-memory mDNS host", () => {
  test("preserves cancellation and validates direct datagram boundaries", async () => {
    const network = newMemoryMDNSNetwork()
    expect(() => network.host("")).toThrow(TypeError)
    const host = network.host("direct")
    const [canceled, cancel] = withCancelCause(background())
    const failure = new Error("caller canceled")
    cancel(failure)
    await expect(host.networkInterfaces(canceled)).rejects.toBe(failure)
    await expect(
      host.bindDatagram(canceled, {
        family: "ipv4",
        bindAddress: "0.0.0.0",
        port: 5_353,
        interfaceId: "direct-ipv4",
        interfaceAddress: "127.0.0.1",
        reuseAddress: true,
        multicastTTL: 255
      })
    ).rejects.toBe(failure)

    const socket = await host.bindDatagram(background(), {
      family: "ipv4",
      bindAddress: "0.0.0.0",
      port: 5_353,
      interfaceId: "direct-ipv4",
      interfaceAddress: "127.0.0.1",
      reuseAddress: true,
      multicastTTL: 255
    })
    await expect(socket.receive(canceled)).rejects.toBe(failure)
    await expect(
      socket.send(background(), new Uint8Array(), {
        family: "ipv4",
        address: "224.0.0.251",
        port: 9_999
      })
    ).rejects.toThrow("does not match")
    await socket.close(background())
    await socket.settled()
    expect(network.activeSockets()).toBe(0)
  })
})
