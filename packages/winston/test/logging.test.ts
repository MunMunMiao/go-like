import { describe, expect, test } from "bun:test"

import type { Broker, BrokerEvent, BrokerMessage, Subscriber } from "@likego/broker"
import type { CallOption, CallRequest, Client } from "@likego/client"
import { background, withCancelCause, type Context } from "@likego/context"
import type { BodyCodec, Endpoint, Message } from "@likego/transport"
import { endpoint, request as service } from "@likego/transport/headers"
import type { Logger } from "winston"

import { logBroker, logClient, logUnaryMiddleware, logWebHandler } from "../src/index"

interface LogEntry {
  readonly level: "info" | "error"
  readonly message: string
  readonly fields: object
}

const secretSentinel = "LIKEGO_SECRET_SENTINEL"

/** Creates one secret-bearing Error with valid bounded diagnostic identifiers. */
function secretFailure(name = "SensitiveError", code = "LIKEGO_TEST_FAILURE"): Error {
  const failure = new Error(secretSentinel, { cause: new Error(secretSentinel) })
  failure.name = name
  failure.stack = `${secretSentinel}_STACK`
  Object.defineProperty(failure, "code", { enumerable: true, value: code })
  return failure
}

/** Creates one Error whose diagnostic getters throw secret-bearing failures. */
function hostileFailure(): Error {
  const failure = new Error(secretSentinel, { cause: new Error(secretSentinel) })
  failure.stack = `${secretSentinel}_STACK`
  Object.defineProperties(failure, {
    name: {
      get(): never {
        throw new Error(`${secretSentinel}_NAME`)
      }
    },
    code: {
      get(): never {
        throw new Error(`${secretSentinel}_CODE`)
      }
    }
  })
  return failure
}

/** Captures native Winston calls while checking that method receivers remain intact. */
class CaptureLogger {
  readonly marker = "capture"
  readonly entries: LogEntry[] = []
  throwWrites = false

  info(message: string, fields: object): void {
    if (this.marker !== "capture") throw new Error("invalid info receiver")
    if (this.throwWrites) throw new Error("logger unavailable")
    this.entries.push({ level: "info", message, fields })
  }

  error(message: string, fields: object): void {
    if (this.marker !== "capture") throw new Error("invalid error receiver")
    if (this.throwWrites) throw new Error("logger unavailable")
    this.entries.push({ level: "error", message, fields })
  }

  official(): Logger {
    return this as unknown as Logger
  }
}

/** Reads one own structured field without weakening the test type boundary. */
function field(entry: LogEntry, name: string): unknown {
  return Object.getOwnPropertyDescriptor(entry.fields, name)?.value
}

/** Returns one callback captured through a provider boundary. */
function required<T>(value: T | null, label: string): T {
  if (value === null) throw new Error(`${label} was not captured`)
  return value
}

/** Checks the common privacy-bounded completion record. */
function expectCompletion(
  entry: LogEntry,
  level: "info" | "error",
  component: string,
  operation: string,
  outcome: string,
  extra: readonly string[] = []
): void {
  expect(entry.level).toBe(level)
  expect(entry.message).toBe("LikeGo operation completed")
  expect(field(entry, "component")).toBe(component)
  expect(field(entry, "operation")).toBe(operation)
  expect(field(entry, "outcome")).toBe(outcome)
  expect(field(entry, "durationMs")).toBeNumber()
  expect(Number(field(entry, "durationMs"))).toBeGreaterThanOrEqual(0)
  expect(Object.keys(entry.fields).sort()).toEqual(
    ["component", "durationMs", "operation", "outcome"].concat(extra).sort()
  )
}

const response: Message = Object.freeze({
  header: Object.freeze({ result: "ok" }),
  body: new Uint8Array([2])
})

describe("native Winston request logging", () => {
  test("logs Client completion once while preserving receiver, options, result, and failures", async () => {
    const logger = new CaptureLogger()
    const failure = new Error("call failed")
    let nextFailure: unknown = null
    let optionSeen = false
    let closeReceiver = false
    const raw = {
      marker: "client",
      async call(
        _ctx: Context,
        _request: CallRequest,
        ...options: readonly CallOption[]
      ): Promise<Message> {
        expect(this.marker).toBe("client")
        expect(options).toHaveLength(optionSeen ? 0 : 1)
        if (!optionSeen) optionSeen = true
        if (nextFailure !== null) throw nextFailure
        return response
      },
      close() {
        closeReceiver = this.marker === "client"
        return Promise.resolve()
      }
    }
    const client = logClient(raw as unknown as Client, logger.official())
    const option: CallOption = (options) => options
    const request = {
      service: "catalog",
      endpoint: "Get",
      message: { header: { secret: "not logged" }, body: new Uint8Array([1]) }
    }

    expect(await client.call(background(), request, option)).toBe(response)
    expectCompletion(logger.entries[0]!, "info", "client", "catalog/Get", "success")

    const canceled = withCancelCause(background())
    canceled[1](failure)
    expect(await client.call(canceled[0], request)).toBe(response)
    expectCompletion(logger.entries[1]!, "info", "client", "catalog/Get", "success")

    nextFailure = failure
    await expect(client.call(background(), request)).rejects.toBe(failure)
    expectCompletion(logger.entries[2]!, "error", "client", "catalog/Get", "failure", ["errorType"])

    await expect(client.call(canceled[0], request)).rejects.toBe(failure)
    expectCompletion(logger.entries[3]!, "info", "client", "catalog/Get", "canceled")

    const hostileContext: Context = Object.freeze({
      deadline(): readonly [Date, boolean] {
        return [new Date(0), false]
      },
      done(): AbortSignal | null {
        return null
      },
      err(): Error | null {
        throw new Error("context failed")
      },
      value(): unknown {
        return null
      }
    })
    await expect(client.call(hostileContext, request)).rejects.toBe(failure)
    expectCompletion(logger.entries[4]!, "error", "client", "catalog/Get", "failure", ["errorType"])

    logger.throwWrites = true
    nextFailure = null
    expect(await client.call(background(), request)).toBe(response)
    nextFailure = failure
    await expect(client.call(background(), request)).rejects.toBe(failure)
    expect(logger.entries).toHaveLength(5)
    await client.close(background())
    expect(closeReceiver).toBeTrue()
  })

  test("preserves typed Client calls and validates their runtime arguments", async () => {
    const logger = new CaptureLogger()
    const codec: BodyCodec<{ readonly id: number }> = {
      contentType: "application/json",
      encode() {
        return new Uint8Array()
      },
      decode() {
        return { id: 0 }
      }
    }
    const contract: Endpoint<{ readonly id: number }, { readonly id: number }> = Object.freeze({
      service: "catalog",
      endpoint: "Typed",
      requestCodec: codec,
      responseCodec: codec
    })
    const result = Object.freeze({ id: 2 })
    let optionSeen = false
    const native = {
      marker: "typed-client",
      async call(
        this: { readonly marker: string },
        _ctx: Context,
        received: Endpoint<{ readonly id: number }, { readonly id: number }>,
        request: { readonly id: number },
        ...options: readonly CallOption[]
      ): Promise<{ readonly id: number }> {
        expect(this.marker).toBe("typed-client")
        expect(received).toBe(contract)
        expect(request).toEqual({ id: 1 })
        optionSeen = options.length === 1
        return result
      },
      async close(): Promise<void> {}
    }
    const client = logClient(native as unknown as Client, logger.official())
    const option: CallOption = (options) => options

    expect(await client.call(background(), contract, { id: 1 }, option)).toBe(result)
    expect(optionSeen).toBeTrue()
    expectCompletion(logger.entries[0]!, "info", "client", "catalog/Typed", "success")

    await expect(Reflect.apply(client.call, client, [background(), contract])).rejects.toThrow(
      "Client typed call requires a request value"
    )
    await expect(
      Reflect.apply(client.call, client, [background(), contract, { id: 1 }, 1])
    ).rejects.toThrow("Client call option must be a function")
    expectCompletion(logger.entries[1]!, "error", "client", "catalog/Typed", "failure", [
      "errorType"
    ])
    expectCompletion(logger.entries[2]!, "error", "client", "catalog/Typed", "failure", [
      "errorType"
    ])
  })

  test("logs routed unary Server completion without exposing message data", async () => {
    const logger = new CaptureLogger()
    const failure = new Error("handler failed")
    const request: Message = {
      header: { [service.toUpperCase()]: "orders", [endpoint]: "Create", authorization: "hidden" },
      body: new Uint8Array([1, 2, 3])
    }
    const success = logUnaryMiddleware(logger.official())((_ctx, message) => {
      expect(message).toBe(request)
      return response
    })
    expect(await success(background(), request)).toBe(response)
    expectCompletion(logger.entries[0]!, "info", "server", "orders/Create", "success")

    const failed = logUnaryMiddleware(logger.official())(() => {
      throw failure
    })
    await expect(failed(background(), { header: {}, body: new Uint8Array() })).rejects.toBe(failure)
    expectCompletion(logger.entries[1]!, "error", "server", "unknown/unknown", "failure", [
      "errorType"
    ])

    const canceled = withCancelCause(background())
    canceled[1](failure)
    await expect(failed(canceled[0], request)).rejects.toBe(failure)
    expectCompletion(logger.entries[2]!, "info", "server", "orders/Create", "canceled")
  })

  test("preserves synchronous and asynchronous Web Handler behavior", async () => {
    const logger = new CaptureLogger()
    const syncResponse = new Response(null, { status: 201 })
    const sync = logWebHandler(() => syncResponse, logger.official())
    const syncResult = sync(new Request("https://example.test/private/path", { method: "POST" }))
    expect(syncResult).toBe(syncResponse)
    expect(syncResult).not.toBeInstanceOf(Promise)
    expectCompletion(logger.entries[0]!, "info", "web", "POST", "success", ["httpStatus"])
    expect(field(logger.entries[0]!, "httpStatus")).toBe(201)

    const asyncResponse = new Response(null, { status: 204 })
    const asyncHandler = logWebHandler(async () => {
      await Promise.resolve()
      return asyncResponse
    }, logger.official())
    const asyncResult = asyncHandler(new Request("https://example.test/another-secret"))
    expect(asyncResult).toBeInstanceOf(Promise)
    expect(await asyncResult).toBe(asyncResponse)
    expectCompletion(logger.entries[1]!, "info", "web", "GET", "success", ["httpStatus"])

    const serverErrorResponse = new Response(null, { status: 503 })
    const serverError = logWebHandler(() => serverErrorResponse, logger.official())
    expect(serverError(new Request("https://example.test/unavailable"))).toBe(serverErrorResponse)
    expectCompletion(logger.entries[2]!, "error", "web", "GET", "failure", [
      "errorType",
      "httpStatus"
    ])
    expect(field(logger.entries[2]!, "httpStatus")).toBe(503)

    const failure = new Error("web failed")
    const controller = new AbortController()
    controller.abort(failure)
    const completedAfterAbort = logWebHandler(
      () => new Response(null, { status: 200 }),
      logger.official()
    )
    completedAfterAbort(
      new Request("https://example.test/canceled-success", { signal: controller.signal })
    )
    expectCompletion(logger.entries[3]!, "info", "web", "GET", "canceled", ["httpStatus"])

    const failed = logWebHandler(() => {
      throw failure
    }, logger.official())
    expect(() => failed(new Request("https://example.test/secret"))).toThrow(failure)
    expectCompletion(logger.entries[4]!, "error", "web", "GET", "failure", ["errorType"])

    const canceled = logWebHandler(() => Promise.reject(failure), logger.official())
    await expect(
      canceled(new Request("https://example.test/canceled", { signal: controller.signal }))
    ).rejects.toBe(failure)
    expectCompletion(logger.entries[5]!, "info", "web", "GET", "canceled")
  })

  test("logs Broker publish and delivery while preserving native values and lifecycle", async () => {
    interface PublishOptions {
      readonly durable: boolean
    }
    interface SubscribeOptions {
      readonly queue: string
    }
    interface NativeEvent {
      readonly sequence: number
    }
    type Delivery = (ctx: Context, event: BrokerEvent<NativeEvent>) => void | PromiseLike<void>

    const logger = new CaptureLogger()
    const nativeResult = Object.freeze({ sequence: 1 })
    const subscriber: Subscriber = Object.freeze({
      topic: "orders",
      unsubscribe(): Promise<void> {
        return Promise.resolve()
      }
    })
    let delivery: Delivery | null = null
    let publishFailure: unknown = null
    let stringReceiver = false
    const raw: Broker<PublishOptions, typeof nativeResult, SubscribeOptions, NativeEvent> & {
      readonly marker: string
    } = {
      marker: "broker",
      async publish(_ctx, topic, _message, options) {
        expect(this.marker).toBe("broker")
        expect(topic).toBe("orders")
        if (options !== undefined) expect(options.durable).toBeTrue()
        if (publishFailure !== null) throw publishFailure
        return nativeResult
      },
      async subscribe(_ctx, topic, handler, options) {
        expect(this.marker).toBe("broker")
        expect(topic).toBe("orders")
        if (options !== undefined) expect(options.queue).toBe("workers")
        delivery = handler
        return subscriber
      },
      string() {
        stringReceiver = this.marker === "broker"
        return "native-broker"
      }
    }
    const broker = logBroker(raw, logger.official())
    const message: BrokerMessage = {
      headers: { authorization: "hidden" },
      body: new Uint8Array([9])
    }

    expect(await broker.publish(background(), "orders", message, { durable: true })).toBe(
      nativeResult
    )
    expectCompletion(logger.entries[0]!, "info", "broker", "publish orders", "success")

    const failure = new Error("publish failed")
    publishFailure = failure
    await expect(broker.publish(background(), "orders", message)).rejects.toBe(failure)
    expectCompletion(logger.entries[1]!, "error", "broker", "publish orders", "failure", [
      "errorType"
    ])

    const event = Object.freeze({ topic: "orders", message, native: { sequence: 2 } })
    expect(
      await broker.subscribe(
        background(),
        "orders",
        (_ctx, received) => {
          expect(received).toBe(event)
        },
        { queue: "workers" }
      )
    ).toBe(subscriber)
    const syncDelivery = required<Delivery>(delivery, "delivery")
    expect(syncDelivery(background(), event)).toBeUndefined()
    expectCompletion(logger.entries[2]!, "info", "broker", "consume orders", "success")

    expect(
      await broker.subscribe(background(), "orders", async () => {
        await Promise.resolve()
        throw failure
      })
    ).toBe(subscriber)
    const asyncDelivery = required<Delivery>(delivery, "delivery")
    await expect(Promise.resolve(asyncDelivery(background(), event))).rejects.toBe(failure)
    expectCompletion(logger.entries[3]!, "error", "broker", "consume orders", "failure", [
      "errorType"
    ])

    await broker.subscribe(background(), "orders", async () => {
      await Promise.resolve()
    })
    const successfulAsyncDelivery = required<Delivery>(delivery, "delivery")
    await successfulAsyncDelivery(background(), event)
    expectCompletion(logger.entries[4]!, "info", "broker", "consume orders", "success")

    await broker.subscribe(background(), "orders", () => {
      throw failure
    })
    const failedSyncDelivery = required<Delivery>(delivery, "delivery")
    expect(() => failedSyncDelivery(background(), event)).toThrow(failure)
    expectCompletion(logger.entries[5]!, "error", "broker", "consume orders", "failure", [
      "errorType"
    ])

    const canceled = withCancelCause(background())
    canceled[1](failure)
    await expect(Promise.resolve(asyncDelivery(canceled[0], event))).rejects.toBe(failure)
    expectCompletion(logger.entries[6]!, "info", "broker", "consume orders", "canceled")
    expect(broker.string()).toBe("native-broker")
    expect(stringReceiver).toBeTrue()
  })

  test("rejects invalid wrappers before application I/O", () => {
    const logger = new CaptureLogger().official()
    expect(() => logClient(null as never, logger)).toThrow(TypeError)
    expect(() =>
      logClient(
        {
          call(): Promise<Message> {
            return Promise.resolve(response)
          },
          close(): Promise<void> {
            return Promise.resolve()
          }
        } as unknown as Client,
        null as never
      )
    ).toThrow(TypeError)
    expect(() => logUnaryMiddleware(null as never)).toThrow(TypeError)
    expect(() => logUnaryMiddleware(logger)(null as never)).toThrow(TypeError)
    expect(() => logWebHandler(null as never, logger)).toThrow(TypeError)
    expect(() => logBroker(null as never, logger)).toThrow(TypeError)
  })

  test("projects only bounded error identifiers from a secret-bearing failure", () => {
    const logger = new CaptureLogger()
    const failure = secretFailure()
    const failed = logWebHandler(() => {
      throw failure
    }, logger.official())

    expect(() => failed(new Request("https://example.test/"))).toThrow(failure)
    const entry = logger.entries[0]!
    expectCompletion(entry, "error", "web", "GET", "failure", ["errorCode", "errorType"])
    expect(field(entry, "errorType")).toBe("SensitiveError")
    expect(field(entry, "errorCode")).toBe("LIKEGO_TEST_FAILURE")
    expect(field(entry, "error")).toBeUndefined()
    expect(JSON.stringify(entry.fields)).not.toContain(secretSentinel)
    expect(JSON.stringify(entry.fields)).not.toContain("message")
    expect(JSON.stringify(entry.fields)).not.toContain("stack")
    expect(JSON.stringify(entry.fields)).not.toContain("cause")
  })

  test("isolates throwing diagnostic getters from the original failure", () => {
    const logger = new CaptureLogger()
    const failure = hostileFailure()
    const failed = logWebHandler(() => {
      throw failure
    }, logger.official())

    expect(() => failed(new Request("https://example.test/"))).toThrow(failure)
    expectCompletion(logger.entries[0]!, "error", "web", "GET", "failure")
  })

  test("omits malformed and oversized error identifiers", () => {
    const logger = new CaptureLogger()
    let failure = secretFailure("Invalid Error", "lowercase")
    const failed = logWebHandler(() => {
      throw failure
    }, logger.official())

    expect(() => failed(new Request("https://example.test/"))).toThrow(failure)
    failure = secretFailure("X".repeat(65), "X".repeat(65))
    expect(() => failed(new Request("https://example.test/"))).toThrow(failure)
    for (const entry of logger.entries) {
      expectCompletion(entry, "error", "web", "GET", "failure")
    }
  })
})
