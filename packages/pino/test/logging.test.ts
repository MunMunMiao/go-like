import { describe, expect, test } from "bun:test"

import type { Broker, BrokerEvent, BrokerMessage, Subscriber } from "@likego/broker"
import type { CallOption, Client } from "@likego/client"
import { background, withCancelCause, type Context } from "@likego/context"
import { struct } from "@likego/struct"
import { endpoint, type Message } from "@likego/transport"
import { endpoint as endpointHeader, request as service } from "@likego/transport/headers"
import type { Logger } from "pino"

import { logBroker, logClient, logUnaryMiddleware, logWebHandler } from "../src/index"

interface LoggedRecord {
  readonly level: "info" | "error"
  readonly fields: Readonly<Record<string, unknown>>
  readonly message: string
}

interface CapturedLogger {
  readonly logger: Logger
  readonly records: LoggedRecord[]
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

/** Creates a structural Logger that also proves native method receiver preservation. */
function capturedLogger(): CapturedLogger {
  const records: LoggedRecord[] = []
  const native = {
    info(this: unknown, fields: Readonly<Record<string, unknown>>, message: string): void {
      if (this !== native) throw new Error("Pino info receiver changed")
      records.push({ level: "info", fields, message })
    },
    error(this: unknown, fields: Readonly<Record<string, unknown>>, message: string): void {
      if (this !== native) throw new Error("Pino error receiver changed")
      records.push({ level: "error", fields, message })
    }
  }
  return { logger: native as unknown as Logger, records }
}

/** Creates one immutable message used at every portable byte boundary. */
function message(header: Readonly<Record<string, string>> = Object.freeze({})): Message {
  return Object.freeze({ header, body: new Uint8Array([1, 2, 3]) })
}

/** Creates one immutable broker payload without transport routing fields. */
function brokerMessage(): BrokerMessage {
  return Object.freeze({ headers: Object.freeze({}), body: new Uint8Array([1, 2, 3]) })
}

/** Requires one stable completion envelope while allowing its measured duration to vary. */
function expectCompletion(record: LoggedRecord, expected: Readonly<Record<string, unknown>>): void {
  expect(record.message).toBe("LikeGo operation completed")
  expect(record.fields).toMatchObject(expected)
  expect(record.fields.durationMs).toBeNumber()
  expect(record.fields.durationMs).toBeGreaterThanOrEqual(0)
}

describe("Pino Client and Server request logging", () => {
  test("preserves Client receiver, options, result, failure, and cancellation outcomes", async () => {
    const captured = capturedLogger()
    const response = message()
    const failure = new Error("client failed")
    let selectedFailure: Error | null = null
    let optionCount = 0
    const closed = Promise.resolve()
    const native = {
      async call(
        this: unknown,
        _ctx: Context,
        _request: Parameters<Client["call"]>[1],
        ...options: readonly CallOption[]
      ): Promise<Message> {
        if (this !== native) throw new Error("Client receiver changed")
        optionCount = options.length
        if (selectedFailure !== null) throw selectedFailure
        return response
      },
      close(this: unknown): Promise<void> {
        if (this !== native) throw new Error("Client close receiver changed")
        return closed
      }
    }
    const client = logClient(native as unknown as Client, captured.logger)
    const option: CallOption = (options) => options

    await expect(
      client.call(background(), { service: "catalog", endpoint: "Get", message: message() }, option)
    ).resolves.toBe(response)
    expect(optionCount).toBe(1)
    expectCompletion(captured.records[0]!, {
      component: "client",
      operation: "catalog/Get",
      outcome: "success"
    })

    selectedFailure = failure
    await expect(
      client.call(background(), { service: "catalog", endpoint: "Write", message: message() })
    ).rejects.toBe(failure)
    expectCompletion(captured.records[1]!, {
      component: "client",
      operation: "catalog/Write",
      outcome: "failure",
      errorType: "Error"
    })

    const canceled = withCancelCause(background())
    canceled[1](new Error("caller left"))
    await expect(
      client.call(canceled[0], { service: "catalog", endpoint: "Delete", message: message() })
    ).rejects.toBe(failure)
    expect(captured.records[2]!.level).toBe("info")
    expect(captured.records[2]!.fields).not.toHaveProperty("error")
    expectCompletion(captured.records[2]!, {
      component: "client",
      operation: "catalog/Delete",
      outcome: "canceled"
    })
    selectedFailure = null
    await expect(
      client.call(canceled[0], { service: "catalog", endpoint: "Read", message: message() })
    ).resolves.toBe(response)
    expectCompletion(captured.records[3]!, {
      component: "client",
      operation: "catalog/Read",
      outcome: "success"
    })
    expect(client.close(background())).toBe(closed)
    expect(captured.records).toHaveLength(4)
  })

  test("preserves typed Client calls and validates their runtime arguments", async () => {
    const captured = capturedLogger()
    const text = struct.string()
    const contract = endpoint("catalog", "TypedGet", text, text)
    const option: CallOption = (options) => options
    const native = {
      async call(
        this: unknown,
        _ctx: Context,
        _contract: unknown,
        request: unknown,
        ...options: readonly CallOption[]
      ): Promise<string> {
        if (this !== native) throw new Error("Client receiver changed")
        expect(request).toBe("request")
        expect(options).toEqual([option])
        return "response"
      },
      async close(): Promise<void> {}
    }
    const client = logClient(native as unknown as Client, captured.logger)

    await expect(client.call(background(), contract, "request", option)).resolves.toBe("response")
    await expect(Reflect.apply(client.call, client, [background(), contract])).rejects.toThrow(
      "requires a request value"
    )
    await expect(
      Reflect.apply(client.call, client, [background(), contract, "request", 1])
    ).rejects.toThrow("Client call option must be a function")
    expectCompletion(captured.records[0]!, {
      component: "client",
      operation: "catalog/TypedGet",
      outcome: "success"
    })
  })

  test("reads only reserved Server routing fields and preserves handler results", async () => {
    const captured = capturedLogger()
    const response = message()
    const middleware = logUnaryMiddleware(captured.logger)
    const handled = middleware(async (_ctx, _request) => response)
    const request = message({
      [service.toLowerCase()]: "orders",
      [endpointHeader.toUpperCase()]: "Create",
      Authorization: "secret"
    })

    await expect(handled(background(), request)).resolves.toBe(response)
    expectCompletion(captured.records[0]!, {
      component: "server",
      operation: "orders/Create",
      outcome: "success"
    })

    const failure = new Error("handler failed")
    const rejected = middleware(() => {
      throw failure
    })
    await expect(
      rejected(
        background(),
        message({
          [service]: "first",
          [service.toLowerCase()]: "second",
          [endpointHeader]: ""
        })
      )
    ).rejects.toBe(failure)
    expectCompletion(captured.records[1]!, {
      component: "server",
      operation: "unknown/unknown",
      outcome: "failure",
      errorType: "Error"
    })
    expect(JSON.stringify(captured.records)).not.toContain("secret")
  })

  test("rejects malformed adapters before an operation starts", () => {
    const captured = capturedLogger()
    expect(() => logClient(null as never, captured.logger)).toThrow(TypeError)
    expect(() => logClient({ call: 1 } as never, captured.logger)).toThrow(TypeError)
    expect(() =>
      logClient(
        { call: () => Promise.resolve(message()), close: () => Promise.resolve() } as never,
        null as never
      )
    ).toThrow(TypeError)
    expect(() => logUnaryMiddleware(null as never)).toThrow(TypeError)
    expect(() => logUnaryMiddleware(captured.logger)(null as never)).toThrow(TypeError)
  })

  test("keeps native logger and hostile Context failures out of application outcomes", async () => {
    const logger = {
      info(): never {
        throw new Error("logger unavailable")
      },
      error(): never {
        throw new Error("logger unavailable")
      }
    } as unknown as Logger
    const response = message()
    const failure = new Error("application failure")
    let selectedFailure: Error | null = null
    const native = {
      async call(): Promise<Message> {
        if (selectedFailure !== null) throw selectedFailure
        return response
      },
      async close(): Promise<void> {}
    }
    const client = logClient(native as unknown as Client, logger)

    await expect(
      client.call(background(), { service: "catalog", endpoint: "Get", message: message() })
    ).resolves.toBe(response)
    selectedFailure = failure
    const root = background()
    const hostile: Context = {
      deadline: root.deadline,
      done: root.done,
      err(): never {
        throw new Error("hostile Context")
      },
      value: root.value
    }
    await expect(
      client.call(hostile, { service: "catalog", endpoint: "Fail", message: message() })
    ).rejects.toBe(failure)
  })
})

describe("Pino Web request logging", () => {
  test("preserves synchronous responses and classifies HTTP failures", () => {
    const captured = capturedLogger()
    const ok = new Response(null, { status: 204 })
    const sync = logWebHandler(() => ok, captured.logger)
    const result = sync(new Request("https://example.test/private", { method: "PATCH" }))
    expect(result).toBe(ok)
    expect(result).not.toBeInstanceOf(Promise)
    expectCompletion(captured.records[0]!, {
      component: "web",
      operation: "PATCH",
      outcome: "success",
      httpStatus: 204
    })

    const unavailable = new Response(null, { status: 503 })
    expect(
      logWebHandler(() => unavailable, captured.logger)(new Request("https://example.test/"))
    ).toBe(unavailable)
    expect(captured.records[1]!.level).toBe("error")
    expectCompletion(captured.records[1]!, {
      component: "web",
      operation: "GET",
      outcome: "failure",
      httpStatus: 503,
      errorType: "Error"
    })
    expect(JSON.stringify(captured.records)).not.toContain("/private")
  })

  test("preserves asynchronous responses and rejection identities", async () => {
    const captured = capturedLogger()
    const response = new Response(null, { status: 202 })
    const pending = logWebHandler(
      async () => response,
      captured.logger
    )(new Request("https://example.test/", { method: "POST" }))
    expect(pending).toBeInstanceOf(Promise)
    await expect(pending).resolves.toBe(response)
    expectCompletion(captured.records[0]!, {
      component: "web",
      operation: "POST",
      outcome: "success",
      httpStatus: 202
    })

    const failure = new Error("async Web failure")
    const rejected = logWebHandler(
      () => Promise.reject(failure),
      captured.logger
    )(new Request("https://example.test/"))
    await expect(rejected).rejects.toBe(failure)
    expectCompletion(captured.records[1]!, {
      component: "web",
      operation: "GET",
      outcome: "failure",
      errorType: "Error"
    })
    expect(captured.records[1]!.fields).not.toHaveProperty("httpStatus")
  })

  test("logs synchronous cancellation without replacing its thrown value", () => {
    const captured = capturedLogger()
    const controller = new AbortController()
    controller.abort()
    const failure = new Error("request canceled")
    const handler = logWebHandler(() => {
      throw failure
    }, captured.logger)

    expect(() =>
      handler(new Request("https://example.test/", { signal: controller.signal }))
    ).toThrow(failure)
    expect(captured.records[0]!.level).toBe("info")
    expect(captured.records[0]!.fields).not.toHaveProperty("error")
    expectCompletion(captured.records[0]!, {
      component: "web",
      operation: "GET",
      outcome: "canceled"
    })
  })

  test("projects only bounded error identifiers from a secret-bearing failure", () => {
    const captured = capturedLogger()
    const failure = secretFailure()
    const failed = logWebHandler(() => {
      throw failure
    }, captured.logger)

    expect(() => failed(new Request("https://example.test/"))).toThrow(failure)
    const fields = captured.records[0]!.fields
    expect(fields).toEqual({
      component: "web",
      operation: "GET",
      outcome: "failure",
      durationMs: expect.any(Number),
      errorType: "SensitiveError",
      errorCode: "LIKEGO_TEST_FAILURE"
    })
    expect(fields).not.toHaveProperty("error")
    expect(JSON.stringify(fields)).not.toContain(secretSentinel)
    expect(JSON.stringify(fields)).not.toContain("message")
    expect(JSON.stringify(fields)).not.toContain("stack")
    expect(JSON.stringify(fields)).not.toContain("cause")
  })

  test("isolates throwing diagnostic getters from the original failure", () => {
    const captured = capturedLogger()
    const failure = hostileFailure()
    const failed = logWebHandler(() => {
      throw failure
    }, captured.logger)

    expect(() => failed(new Request("https://example.test/"))).toThrow(failure)
    expect(captured.records[0]!.fields).toEqual({
      component: "web",
      operation: "GET",
      outcome: "failure",
      durationMs: expect.any(Number)
    })
  })

  test("omits malformed and oversized error identifiers", () => {
    const captured = capturedLogger()
    let failure = secretFailure("Invalid Error", "lowercase")
    const failed = logWebHandler(() => {
      throw failure
    }, captured.logger)

    expect(() => failed(new Request("https://example.test/"))).toThrow(failure)
    failure = secretFailure("X".repeat(65), "X".repeat(65))
    expect(() => failed(new Request("https://example.test/"))).toThrow(failure)
    for (const record of captured.records) {
      expect(record.fields).not.toHaveProperty("errorType")
      expect(record.fields).not.toHaveProperty("errorCode")
      expect(record.fields).not.toHaveProperty("error")
    }
  })

  test("rejects invalid Web handlers and loggers synchronously", () => {
    const captured = capturedLogger()
    expect(() => logWebHandler(null as never, captured.logger)).toThrow(TypeError)
    expect(() => logWebHandler(() => new Response(), null as never)).toThrow(TypeError)
  })
})

describe("Pino Broker request logging", () => {
  test("preserves publish receiver, options, result, failure, and cancellation", async () => {
    const captured = capturedLogger()
    const publishResult = Object.freeze({ sequence: 7 })
    const failure = new Error("publish failed")
    let selectedFailure: Error | null = null
    let suppliedOptions: Readonly<{ durable: boolean }> | undefined
    const subscriber: Subscriber = {
      topic: "events",
      async unsubscribe(): Promise<void> {}
    }
    const native = {
      async publish(
        this: unknown,
        _ctx: Context,
        _topic: string,
        _message: BrokerMessage,
        options?: Readonly<{ durable: boolean }>
      ): Promise<typeof publishResult> {
        if (this !== native) throw new Error("Broker publish receiver changed")
        suppliedOptions = options
        if (selectedFailure !== null) throw selectedFailure
        return publishResult
      },
      async subscribe(): Promise<Subscriber> {
        return subscriber
      },
      string(this: unknown): string {
        if (this !== native) throw new Error("Broker string receiver changed")
        return "native"
      }
    }
    const broker = logBroker(native, captured.logger)

    await expect(
      broker.publish(background(), "orders", brokerMessage(), { durable: true })
    ).resolves.toBe(publishResult)
    expect(suppliedOptions).toEqual({ durable: true })
    expectCompletion(captured.records[0]!, {
      component: "broker",
      operation: "publish orders",
      outcome: "success"
    })
    expect(broker.string()).toBe("native")

    selectedFailure = failure
    await expect(broker.publish(background(), "orders", brokerMessage())).rejects.toBe(failure)
    expectCompletion(captured.records[1]!, {
      component: "broker",
      operation: "publish orders",
      outcome: "failure",
      errorType: "Error"
    })

    const canceled = withCancelCause(background())
    canceled[1](new Error("publisher canceled"))
    await expect(broker.publish(canceled[0], "orders", brokerMessage())).rejects.toBe(failure)
    expect(captured.records[2]!.level).toBe("info")
    expectCompletion(captured.records[2]!, {
      component: "broker",
      operation: "publish orders",
      outcome: "canceled"
    })
  })

  test("returns the native Subscriber and logs each synchronous and asynchronous delivery", async () => {
    const captured = capturedLogger()
    const subscriber: Subscriber = {
      topic: "events",
      async unsubscribe(): Promise<void> {}
    }
    let admitted:
      | ((ctx: Context, event: BrokerEvent<Readonly<{ id: number }>>) => void | PromiseLike<void>)
      | null = null
    let subscribeOptions: Readonly<{ queue: string }> | undefined
    const native: Broker<
      undefined,
      undefined,
      Readonly<{ queue: string }>,
      Readonly<{ id: number }>
    > = {
      async publish(): Promise<undefined> {
        return undefined
      },
      async subscribe(_ctx, _topic, handler, options): Promise<Subscriber> {
        if (this !== native) throw new Error("Broker subscribe receiver changed")
        admitted = handler
        subscribeOptions = options
        return subscriber
      },
      string(): string {
        return "native"
      }
    }
    let mode: "sync" | "async" | "throw" | "reject" = "sync"
    const failure = new Error("consumer failed")
    const broker = logBroker(native, captured.logger)
    const returned = await broker.subscribe(
      background(),
      "events",
      () => {
        if (mode === "async") return Promise.resolve()
        if (mode === "throw") throw failure
        if (mode === "reject") return Promise.reject(failure)
      },
      { queue: "workers" }
    )
    expect(returned).toBe(subscriber)
    expect(subscribeOptions).toEqual({ queue: "workers" })
    expect(admitted).not.toBeNull()
    const event: BrokerEvent<Readonly<{ id: number }>> = {
      topic: "events",
      message: brokerMessage(),
      native: { id: 1 }
    }

    expect(admitted!(background(), event)).toBeUndefined()
    expectCompletion(captured.records[0]!, {
      component: "broker",
      operation: "consume events",
      outcome: "success"
    })

    mode = "async"
    await admitted!(background(), event)
    expectCompletion(captured.records[1]!, {
      component: "broker",
      operation: "consume events",
      outcome: "success"
    })

    mode = "throw"
    expect(() => admitted!(background(), event)).toThrow(failure)
    expectCompletion(captured.records[2]!, {
      component: "broker",
      operation: "consume events",
      outcome: "failure",
      errorType: "Error"
    })

    mode = "reject"
    await expect(admitted!(background(), event)).rejects.toBe(failure)
    expectCompletion(captured.records[3]!, {
      component: "broker",
      operation: "consume events",
      outcome: "failure",
      errorType: "Error"
    })

    const canceled = withCancelCause(background())
    canceled[1](new Error("consumer canceled"))
    await expect(admitted!(canceled[0], event)).rejects.toBe(failure)
    expect(captured.records[4]!.level).toBe("info")
    expectCompletion(captured.records[4]!, {
      component: "broker",
      operation: "consume events",
      outcome: "canceled"
    })
  })

  test("preserves subscribe without options and rejects malformed boundaries", async () => {
    const captured = capturedLogger()
    let argumentsCount = 0
    const subscriber: Subscriber = {
      topic: "events",
      async unsubscribe(): Promise<void> {}
    }
    const native = {
      async publish(): Promise<void> {},
      async subscribe(...values: readonly unknown[]): Promise<Subscriber> {
        argumentsCount = values.length
        return subscriber
      },
      string(): string {
        return "native"
      }
    }
    const broker = logBroker(native, captured.logger)
    await expect(broker.subscribe(background(), "events", () => {})).resolves.toBe(subscriber)
    expect(argumentsCount).toBe(3)
    await expect(broker.subscribe(background(), "events", null as never)).rejects.toThrow(TypeError)

    expect(() => logBroker(null as never, captured.logger)).toThrow(TypeError)
    expect(() =>
      logBroker({ publish: 1, subscribe: 1, string: 1 } as never, captured.logger)
    ).toThrow(TypeError)
    expect(() =>
      logBroker({ publish() {}, subscribe() {}, string() {} } as never, null as never)
    ).toThrow(TypeError)
  })
})
