import { background, type Context } from "@go-like/context"
import { struct } from "@go-like/struct"
import { isStruct } from "@go-like/struct/runtime"
import { describe, expect, test } from "bun:test"

import { defineService, type Endpoint, type ServiceHandler } from "../src/index"

const request = struct.object({ value: struct.number() })
const response = struct.object({ value: struct.number() })

interface RecordedHandler {
  readonly name: string
  readonly stream: boolean
  readonly handler: (ctx: Context, value: unknown) => unknown
}

/** Records typed registrations without invoking the real Server. */
function recordingServer(recorded: RecordedHandler[]): {
  registerHandlers(
    handlers: readonly {
      readonly endpoint: Endpoint
      readonly handler: (ctx: Context, value: unknown) => unknown
    }[]
  ): void
} {
  return {
    registerHandlers(handlers): void {
      for (const binding of handlers) {
        recorded.push({
          name: binding.endpoint.endpoint,
          stream: binding.endpoint.stream,
          handler: binding.handler
        })
      }
    }
  }
}

describe("defineService", () => {
  test("freezes a service whose endpoint names and structs are declared once", () => {
    const count = struct.number()
    const service = defineService("pay.v1", {
      "a_b~c-d": { request, response },
      health: { response },
      ping: { response },
      count: { request: count, response: count },
      watch: { request, response, stream: true }
    })

    expect(service.name).toBe("pay.v1")
    expect(service.endpoints["a_b~c-d"]).toMatchObject({
      service: "pay.v1",
      endpoint: "a_b~c-d",
      request,
      response,
      stream: false
    })
    expect(service.endpoints.health.stream).toBe(false)
    expect(service.endpoints.health.request).toBe(service.endpoints.ping.request)
    expect(isStruct(service.endpoints.health.request)).toBe(true)
    expect(service.endpoints.count.request).toBe(count)
    expect(service.endpoints.count.response).toBe(count)
    expect(service.endpoints.watch.stream).toBe(true)
    expect(Object.isFrozen(service)).toBe(true)
    expect(Object.isFrozen(service.endpoints)).toBe(true)
    expect(Object.isFrozen(service.endpoints.watch)).toBe(true)
    expect(() => {
      ;(service as { name: string }).name = "other"
    }).toThrow(TypeError)
  })

  test("rejects invalid service declarations before any contract is published", () => {
    expect(() => defineService("", { add: { request, response } })).toThrow(
      "service name must be a URL unreserved route token"
    )
    expect(() => defineService("payments/v1", { add: { request, response } })).toThrow(TypeError)
    expect(() => defineService("订单", { add: { request, response } })).toThrow(TypeError)
    expect(() => defineService("pay v1", { add: { request, response } })).toThrow(TypeError)
    expect(() => defineService(1 as never, { add: { request, response } })).toThrow(TypeError)
    expect(() => defineService("payments.v1", null as never)).toThrow("endpoints must be an object")
    expect(() => defineService("payments.v1", [{ request, response }] as never)).toThrow(
      "endpoints must be an object"
    )
    expect(() => defineService("payments.v1", (() => undefined) as never)).toThrow(
      "endpoints must be an object"
    )
    expect(() => defineService("payments.v1", {})).toThrow("at least one endpoint")
    expect(() =>
      defineService("payments.v1", { add: { request: struct.number(), response } })
    ).not.toThrow()
    expect(() => defineService("payments.v1", { add: { request: {} as never, response } })).toThrow(
      "add request must be a Struct"
    )
    expect(() => defineService("payments.v1", { add: { request, response: {} as never } })).toThrow(
      "add response must be a Struct"
    )
    expect(() => defineService("payments.v1", { add: { request } as never })).toThrow(
      "add requires response"
    )
    expect(() =>
      defineService("payments.v1", { add: { request, response, stream: false as never } })
    ).toThrow("stream must be true or omitted")
    expect(() =>
      defineService("payments.v1", {
        add: { request, response, stream: undefined as never }
      })
    ).toThrow("stream must be true or omitted")
    expect(() =>
      defineService("payments.v1", {
        add: { request, response, extra: true } as never
      })
    ).toThrow("has unknown field extra")
    expect(() => defineService(".", { ok: { response } })).toThrow(
      "service name must be a URL unreserved route token"
    )
    expect(() => defineService("..", { ok: { response } })).toThrow(
      "service name must be a URL unreserved route token"
    )
    expect(() => defineService("payments.v1", { ".": { response } })).toThrow(
      "endpoint . must be a URL unreserved route token"
    )
    expect(() => defineService("payments.v1", { "..": { response } })).toThrow(
      "endpoint .. must be a URL unreserved route token"
    )
    expect(() => defineService("payments.v1", { "a/b": { request, response } })).toThrow(
      "endpoint a/b must be a URL unreserved route token"
    )
    const embedded = defineService("a.b", {
      "a..b": { response },
      "...": { response },
      ".a": { response }
    })
    expect(embedded.endpoints["a..b"]).toMatchObject({ service: "a.b", endpoint: "a..b" })
    expect(embedded.endpoints["..."]).toMatchObject({ endpoint: "..." })
    expect(embedded.endpoints[".a"]).toMatchObject({ endpoint: ".a" })
    expect(() => defineService("payments.v1", { constructor: { request, response } })).toThrow(
      "constructor collides with Object.prototype"
    )
    expect(() => defineService("payments.v1", { toString: { request, response } })).toThrow(
      "toString collides with Object.prototype"
    )
    expect(() => defineService("payments.v1", { ["__proto__"]: { request, response } })).toThrow(
      "__proto__ collides with Object.prototype"
    )
    const symbolic = { add: { request, response } }
    Object.defineProperty(symbolic, Symbol("hidden"), {
      value: { request, response },
      enumerable: true
    })
    expect(() => defineService("payments.v1", symbolic)).toThrow("endpoint name must be a string")
    expect(() => defineService("payments.v1", { add: null as never })).toThrow(
      "add must be an object"
    )
    expect(() => defineService("payments.v1", { add: [request] as never })).toThrow(
      "add must be an object"
    )
  })

  test("checks every handler before registering and keeps the handler as this", () => {
    const service = defineService("payments.v1", {
      add: { request, response },
      health: { response }
    })
    const recorded: RecordedHandler[] = []
    expect(() =>
      service.registerHandler(recordingServer(recorded), {
        add(_ctx: Context, _value: { value: number }) {
          return { value: 1 }
        }
      } as never)
    ).toThrow("missing handler for endpoint health")
    expect(recorded).toEqual([])
    expect(() =>
      service.registerHandler(null as never, { add() {}, health() {} } as never)
    ).toThrow("server must implement registerHandlers")
    expect(() =>
      service.registerHandler(
        { registerHandlers: "no" } as never,
        { add() {}, health() {} } as never
      )
    ).toThrow("server must implement registerHandlers")
    expect(() => service.registerHandler(recordingServer(recorded), null as never)).toThrow(
      "handler must be an object"
    )
    expect(() =>
      service.registerHandler(recordingServer(recorded), (() => undefined) as never)
    ).toThrow("handler must be an object")

    class Implementation {
      readonly offset = 2

      add(_ctx: Context, value: { value: number }): { value: number } {
        return { value: value.value + this.offset }
      }

      health(_ctx: Context, ...rest: readonly unknown[]): { value: number } {
        return { value: rest.length + this.offset }
      }
    }
    const handler: ServiceHandler<typeof service> = new Implementation()
    service.registerHandler(recordingServer(recorded), handler)
    expect(recorded.map((entry) => entry.name)).toEqual(["add", "health"])
    expect(recorded[0]?.handler(background(), { value: 3 })).toEqual({ value: 5 })
    expect(recorded[1]?.handler(background(), { value: 99 })).toEqual({ value: 2 })
  })

  test("registers a stream endpoint without dropping stream", () => {
    const service = defineService("payments.v1", {
      add: { request, response },
      watch: { request, response, stream: true }
    })
    const recorded: RecordedHandler[] = []
    expect(() =>
      service.registerHandler(recordingServer(recorded), {
        add(_ctx: Context, value: { value: number }) {
          return value
        }
      } as never)
    ).toThrow("missing handler for endpoint watch")
    expect(recorded).toEqual([])
    service.registerHandler(recordingServer(recorded), {
      add(_ctx: Context, value: { value: number }) {
        return value
      },
      async *watch(): AsyncIterable<{ value: number }> {}
    })
    expect(recorded.map((entry) => [entry.name, entry.stream])).toEqual([
      ["add", false],
      ["watch", true]
    ])
  })

  test("borrows a connection and only exposes contract methods", async () => {
    const service = defineService("payments.v1", {
      add: { request, response },
      health: { response },
      watch: { request, response, stream: true },
      tail: { response, stream: true }
    })
    const calls: unknown[][] = []
    const streams: unknown[][] = []
    let closed = 0
    const ctx = background()
    const optionA = (): undefined => undefined
    const optionB = (): undefined => undefined
    const conn = {
      async call(...args: readonly unknown[]): Promise<{ value: number }> {
        calls.push([...args])
        return { value: 1 }
      },
      async stream(...args: readonly unknown[]): Promise<unknown> {
        streams.push([...args])
        return {
          async *[Symbol.asyncIterator](): AsyncGenerator<never> {},
          async close(): Promise<void> {},
          async [Symbol.asyncDispose](): Promise<void> {}
        }
      },
      async close(): Promise<void> {
        closed += 1
      }
    }
    expect(() => service.newClient(null as never)).toThrow("connection must implement call")
    expect(() => service.newClient({ call: "no" } as never)).toThrow(
      "connection must implement call"
    )
    const client = service.newClient(conn)
    expect(Object.keys(client).sort()).toEqual(["add", "health", "tail", "watch"])
    expect(Object.isFrozen(client)).toBe(true)
    expect(Object.hasOwn(client, "close")).toBe(false)

    await expect(client.add(ctx, { value: 4 }, optionA, optionB)).resolves.toEqual({
      value: 1
    })
    await expect(client.health(ctx, optionA)).resolves.toEqual({ value: 1 })
    const watched = await client.watch(ctx, { value: 4 }, optionA)
    expect(typeof watched.close).toBe("function")
    expect(typeof watched[Symbol.asyncIterator]).toBe("function")
    const tailed = await client.tail(ctx, optionA)
    expect(typeof tailed.close).toBe("function")
    const unaryOnly = service.newClient({
      async call(): Promise<{ value: number }> {
        return { value: 1 }
      }
    })
    await expect(unaryOnly.watch(ctx, { value: 1 })).rejects.toThrow(
      "transport service connection must implement stream"
    )

    expect(calls).toEqual([
      [ctx, service.endpoints.add, { value: 4 }, optionA, optionB],
      [ctx, service.endpoints.health, {}, optionA]
    ])
    expect(streams).toEqual([
      [ctx, service.endpoints.watch, { value: 4 }, optionA],
      [ctx, service.endpoints.tail, {}, optionA]
    ])
    expect(closed).toBe(0)
  })

  test("registers every endpoint through one batch call", () => {
    const service = defineService("payments.v1", {
      add: { request, response },
      health: { response }
    })
    const recorded: Endpoint[] = []
    let batches = 0
    const server = {
      registerHandler(endpoint: Endpoint): void {
        recorded.push(endpoint)
      },
      registerHandlers(handlers: readonly { readonly endpoint: Endpoint }[]): void {
        batches += 1
        for (const binding of handlers) recorded.push(binding.endpoint)
      }
    }
    service.registerHandler(server, {
      add(_ctx: Context, value: { value: number }) {
        return value
      },
      health(_ctx: Context) {
        return { value: 1 }
      }
    })
    expect(batches).toBe(1)
    expect(recorded.map((item) => item.endpoint)).toEqual(["add", "health"])
  })

  test("leaves no partial registration when the registrar fails on a later endpoint", () => {
    const service = defineService("payments.v1", {
      add: { request, response },
      health: { response }
    })
    const handler = {
      add(_ctx: Context, value: { value: number }) {
        return value
      },
      health(_ctx: Context) {
        return { value: 1 }
      }
    }
    const recorded: Endpoint[] = []
    const throwing = {
      registerHandler(endpoint: Endpoint): void {
        recorded.push(endpoint)
        if (recorded.length === 2) throw new Error("boom")
      }
    }
    expect(() => service.registerHandler(throwing as never, handler)).toThrow(
      "transport service server must implement registerHandlers"
    )
    expect(recorded).toEqual([])

    recorded.length = 0
    const failingBatch = {
      registerHandler(endpoint: Endpoint): void {
        recorded.push(endpoint)
      },
      registerHandlers(): void {
        throw new Error("boom")
      }
    }
    expect(() => service.registerHandler(failingBatch, handler)).toThrow("boom")
    expect(recorded).toEqual([])
  })
})
