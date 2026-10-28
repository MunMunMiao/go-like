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
    await expect(socket.joinMulticast(background(), "224.0.0.251", "other")).rejects.toThrow(
      "interface mismatch"
    )
    await expect(socket.joinMulticast(background(), "", "direct-ipv4")).rejects.toThrow(
      "group is invalid"
    )
    await expect(socket.setMulticastLoopback(background(), 1 as never)).rejects.toThrow(
      "must be boolean"
    )
    await expect(socket.setMulticastInterface(background(), "other")).rejects.toThrow(
      "interface mismatch"
    )
    await expect(
      socket.send(background(), [] as never, {
        family: "ipv4",
        address: "224.0.0.251",
        port: 5_353
      })
    ).rejects.toThrow("must be Uint8Array")
    expect(() => host.crash("failure" as never)).toThrow("must be an Error")
    await expect(
      socket.send(background(), new Uint8Array(), {
        family: "ipv4",
        address: "224.0.0.251",
        port: 9_999
      })
    ).rejects.toThrow("does not match")
    await socket.close(background())
    await socket.settled()
    await expect(socket.receive(background())).rejects.toThrow("socket is closed")
    expect(network.activeSockets()).toBe(0)
  })
})
