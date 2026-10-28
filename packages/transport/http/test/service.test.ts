import { background, type Context } from "@go-like/context"
import { newClient, withEndpoint, withTransport } from "@go-like/client"
import { address, newServer, transport as serverTransport } from "@go-like/server"
import { struct } from "@go-like/struct"
import { defineService, type ServiceHandler } from "@go-like/transport"
import { expect, test } from "bun:test"

import { newNodeHTTPTransport } from "../src/node"

const noProxy = [process.env.NO_PROXY, process.env.no_proxy, "127.0.0.1", "localhost", "::1"]
  .filter(Boolean)
  .join(",")
process.env.NO_PROXY = noProxy
process.env.no_proxy = noProxy

const request = struct.object({ value: struct.number() })
const response = struct.object({ value: struct.number() })
const payments = defineService("payments.v1", {
  add: { request, response },
  health: { response }
})

test("calls unary service methods over HTTP", async () => {
  const nodeTransport = newNodeHTTPTransport()
  const server = newServer(serverTransport(nodeTransport), address("127.0.0.1:0"))
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
  payments.registerHandler(server, handler)
  const running = server.start(background())
  try {
    const endpointAddress = await server.endpoint(background())
    const conn = newClient(withTransport(nodeTransport), withEndpoint(endpointAddress))
    try {
      const proxy = payments.newClient(conn)
      await expect(proxy.add(background(), { value: 3 })).resolves.toEqual({ value: 5 })
      await expect(proxy.health(background())).resolves.toEqual({ value: 2 })
    } finally {
      await conn.close(background())
    }
  } finally {
    await server.stop(background())
    await running
  }
})
