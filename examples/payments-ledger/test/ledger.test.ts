import { describe, expect, test } from "bun:test"
import { SQL } from "bun"

import { afterStart, name, newApp, resources, server } from "@go-like/core"
import { background } from "@go-like/core/context"
import type { Server } from "@go-like/core/lifecycle"
import type { NatsConnection } from "@nats-io/transport-node"

import { newPaymentHandler } from "../src/http"
import { postPayment } from "../src/post-payment"
import { isPaymentFailure, parsePaymentRequest } from "../src/payment"
import { newLedgerDatabaseResource, newLedgerNatsResource } from "../src/resources"
import { newOutboxPublisherServer } from "../src/worker"

const validPayment = Object.freeze({
  debitAccountId: "account_customer_1",
  creditAccountId: "account_merchant_1",
  currency: "USD",
  amountMinor: "1250",
  reference: "order_1001"
})

describe("payment request boundary", () => {
  test("normalizes one valid integer-minor-unit request", () => {
    const parsed = parsePaymentRequest({ ...validPayment, ignored: "discarded" })

    expect(parsed).toEqual(validPayment)
    expect(Object.isFrozen(parsed)).toBe(true)
    expect("ignored" in parsed).toBe(false)
  })

  test.each([
    [null, "payment body must be an object"],
    [[], "payment body must be an object"],
    [{ ...validPayment, amountMinor: undefined }, "payment body has invalid field types"],
    [
      {
        debitAccountId: "account_customer_1",
        creditAccountId: "account_merchant_1",
        currency: "USD",
        amountMinor: "1250"
      },
      "payment body is missing reference"
    ],
    [{ ...validPayment, debitAccountId: "bad account" }, "debitAccountId is invalid"],
    [{ ...validPayment, creditAccountId: "bad account" }, "creditAccountId is invalid"],
    [
      { ...validPayment, creditAccountId: validPayment.debitAccountId },
      "ledger accounts must differ"
    ],
    [{ ...validPayment, currency: "usd" }, "currency must be three uppercase letters"],
    [{ ...validPayment, amountMinor: "0" }, "amountMinor is outside the signed bigint range"],
    [
      { ...validPayment, amountMinor: "9223372036854775808" },
      "amountMinor is outside the signed bigint range"
    ],
    [{ ...validPayment, reference: "" }, "reference length must be 1..128"],
    [{ ...validPayment, reference: "x".repeat(129) }, "reference length must be 1..128"]
  ])("rejects invalid input %#", (value, message) => {
    try {
      parsePaymentRequest(value)
      throw new Error("expected payment validation to fail")
    } catch (error) {
      expect(isPaymentFailure(error)).toBe(true)
      expect(error).toHaveProperty("code", "PAYMENT_VALIDATION")
      expect(error).toHaveProperty("message", message)
    }
  })

  test("does not brand unrelated errors", () => {
    expect(isPaymentFailure(new Error("unrelated"))).toBe(false)
    expect(isPaymentFailure(null)).toBe(false)
  })

  test("does not let a hostile error code getter escape the HTTP boundary", async () => {
    const sql = new SQL()
    const failure = new Error("resolver unavailable")
    Object.defineProperty(failure, "code", {
      get() {
        throw new Error("hostile error getter")
      }
    })
    const handler = newPaymentHandler(sql, () => {
      throw failure
    })

    const response = await handler(
      new Request("http://ledger.internal/v1/ledger/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": "request-1" },
        body: JSON.stringify(validPayment)
      })
    )

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ code: "LEDGER_UNAVAILABLE" })
    await sql.close()
  })

  test("passes the request Context to the trusted tenant resolver", async () => {
    const sql = new SQL()
    const observed: { request: Request | null; signal: AbortSignal | null } = {
      request: null,
      signal: null
    }
    const handler = newPaymentHandler(sql, (ctx, request) => {
      observed.request = request
      observed.signal = ctx.done()
      throw new Error("resolver unavailable")
    })
    const request = new Request("http://ledger.internal/v1/ledger/payments", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "request-1" },
      body: JSON.stringify(validPayment)
    })

    const response = await handler(request)

    expect(response.status).toBe(503)
    expect(observed.request === request).toBe(true)
    expect(observed.signal?.aborted).toBe(true)
    await sql.close()
  })
})

describe("payment HTTP boundary", () => {
  test("maps method, path, malformed JSON, and validation failures", async () => {
    const sql = new SQL()
    const handler = newPaymentHandler(sql, () => "tenant_1")
    const method = await handler(new Request("http://ledger.internal/wrong"))
    expect(method.status).toBe(404)
    const get = await handler(new Request("http://ledger.internal/v1/ledger/payments"))
    expect(get.status).toBe(405)
    expect(get.headers.get("Allow")).toBe("POST")
    const malformed = await handler(
      new Request("http://ledger.internal/v1/ledger/payments", {
        method: "POST",
        headers: { "Idempotency-Key": "request-1" },
        body: "{"
      })
    )
    expect(malformed.status).toBe(400)
    const invalid = await handler(
      new Request("http://ledger.internal/v1/ledger/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": "request-1" },
        body: JSON.stringify({})
      })
    )
    expect(invalid.status).toBe(400)
    await sql.close()
  })
})

describe("payment application lifecycle", () => {
  test("replays identical idempotency rows and rejects conflicts or invalid stored responses", async () => {
    const replayRow = {
      same_request: true,
      response_status: 201,
      transaction_id: "transaction-existing",
      event_id: "event-existing"
    }
    let replayQueries = 0
    const replayConnection = ((..._args: unknown[]) => {
      replayQueries += 1
      return Promise.resolve(replayQueries === 1 ? [] : [replayRow])
    }) as unknown as SQL
    const replaySql = Object.assign((() => Promise.resolve([])) as unknown as SQL, {
      async begin<T>(callback: (connection: SQL) => Promise<T>): Promise<T> {
        return await callback(replayConnection)
      }
    }) as SQL
    const replay = await postPayment(background(), replaySql, "tenant_1", "request-1", validPayment)
    expect(replay).toEqual({
      transactionId: "transaction-existing",
      eventId: "event-existing",
      replayed: true
    })

    let conflictQueries = 0
    const conflictConnection = ((..._args: unknown[]) => {
      conflictQueries += 1
      return Promise.resolve(conflictQueries === 1 ? [] : [{ ...replayRow, same_request: false }])
    }) as unknown as SQL
    const conflictSql = Object.assign((() => Promise.resolve([])) as unknown as SQL, {
      async begin<T>(callback: (connection: SQL) => Promise<T>): Promise<T> {
        return await callback(conflictConnection)
      }
    }) as SQL
    await expect(
      postPayment(background(), conflictSql, "tenant_1", "request-1", validPayment)
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" })

    let invalidQueries = 0
    const invalidConnection = ((..._args: unknown[]) => {
      invalidQueries += 1
      return Promise.resolve(
        invalidQueries === 1
          ? []
          : [{ same_request: true, response_status: 500, transaction_id: "t", event_id: "e" }]
      )
    }) as unknown as SQL
    const invalidSql = Object.assign((() => Promise.resolve([])) as unknown as SQL, {
      async begin<T>(callback: (connection: SQL) => Promise<T>): Promise<T> {
        return await callback(invalidConnection)
      }
    }) as SQL
    await expect(
      postPayment(background(), invalidSql, "tenant_1", "request-1", validPayment)
    ).rejects.toThrow("stored idempotency response is invalid")
  })

  test("posts one balanced payment through the public persistence transaction", async () => {
    const queries: unknown[][] = []
    const transaction = ((...args: unknown[]) => {
      queries.push(args)
      return Promise.resolve(queries.length === 1 ? [{ idempotency_key: "request-1" }] : [])
    }) as unknown as SQL
    const sql = Object.assign(
      ((...args: unknown[]) => {
        queries.push(args)
        return Promise.resolve([])
      }) as unknown as SQL,
      {
        async begin<T>(callback: (connection: SQL) => Promise<T>): Promise<T> {
          return await callback(transaction)
        }
      }
    ) as SQL
    const receipt = await postPayment(background(), sql, "tenant_1", "request-1", validPayment)
    expect(receipt.replayed).toBe(false)
    expect(receipt.transactionId).toBeString()
    expect(receipt.eventId).toBeString()
    expect(queries).toHaveLength(4)
  })

  test("rejects invalid payment identity and idempotency keys before persistence", async () => {
    const sql = (() => {
      throw new Error("persistence must not be called")
    }) as unknown as SQL
    await expect(
      postPayment(background(), sql, "bad tenant", "request-1", validPayment)
    ).rejects.toMatchObject({
      code: "PAYMENT_VALIDATION"
    })
    await expect(
      postPayment(background(), sql, "tenant_1", "bad key\n", validPayment)
    ).rejects.toMatchObject({
      code: "PAYMENT_VALIDATION"
    })
  })

  test("rejects invalid publisher setup and reports publish failures", async () => {
    expect(() => newOutboxPublisherServer(null as never)).toThrow(
      "outbox publish attempt must be a function"
    )
    expect(() => newOutboxPublisherServer(async () => Object.freeze({ kind: "idle" }), -1)).toThrow(
      "outbox poll interval must be an integer from 0 to 2147483647"
    )
    const publisher = newOutboxPublisherServer(async () => {
      throw new Error("publish failed")
    }, 0)
    await expect(publisher.start(background())).rejects.toThrow("publish failed")
    await expect(publisher.stop(background())).rejects.toThrow("publish failed")
    expect(publisher.diagnostics()).toEqual({
      status: "failed",
      attempts: 1,
      published: 0
    })
  })

  test("stops a publisher while an idle polling delay is pending", async () => {
    const publisher = newOutboxPublisherServer(async () => Object.freeze({ kind: "idle" }), 60_000)
    const running = publisher.start(background())
    await Promise.resolve()
    await Promise.resolve()
    expect(publisher.diagnostics()).toMatchObject({ status: "running", attempts: 1 })
    await publisher.stop(background())
    await running
    expect(publisher.diagnostics().status).toBe("stopped")
  })

  test("lets Core start and stop the resident outbox publisher without an orphan", async () => {
    const publisher = newOutboxPublisherServer(async () => Object.freeze({ kind: "idle" }), 60_000)
    const app = newApp(name("payments-ledger-test"), server(publisher))

    const running = app.run()
    await Promise.resolve()
    await Promise.resolve()
    expect(publisher.diagnostics()).toEqual({
      status: "running",
      attempts: 1,
      published: 0
    })

    await app.stop()
    await running

    expect(publisher.diagnostics()).toEqual({
      status: "stopped",
      attempts: 1,
      published: 0
    })
  })
})

/** Resolves `start` when `stop` runs, matching a resident server-tier participant. */
function resident(label: string, events: string[]): Server {
  let resolveStart: (() => void) | null = null
  const started = new Promise<void>((resolve) => {
    resolveStart = resolve
  })
  return {
    async start(): Promise<void> {
      events.push(`${label}-start`)
      await started
    },
    async stop(): Promise<void> {
      events.push(`${label}-stop`)
      resolveStart?.()
    }
  }
}

/** Polls until the predicate holds. */
async function waitFor(label: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await Bun.sleep(1)
  }
}

describe("ledger resources", () => {
  test("closes the SQL pool with the existing five-second budget", async () => {
    const timeouts: number[] = []
    const sql = {
      async close(options?: { timeout?: number }) {
        timeouts.push(options?.timeout ?? -1)
      }
    } as unknown as SQL
    const resource = newLedgerDatabaseResource(sql)

    await resource.start(background())
    await resource.stop(background())

    expect(timeouts).toEqual([5])
  })

  test("does not drain a NATS connection that is already closed", async () => {
    let drains = 0
    const connection = {
      closed: () => new Promise<Error | undefined>(() => {}),
      isClosed: () => true,
      async drain() {
        drains += 1
      }
    } as unknown as NatsConnection
    const resource = newLedgerNatsResource(connection)

    await resource.start(background())
    await resource.stop(background())

    expect(drains).toBe(0)
  })

  test("stops the publisher and web server before draining NATS and closing SQL", async () => {
    const events: string[] = []
    const sql = {
      async close(options?: { timeout?: number }) {
        events.push(`sql-close:${options?.timeout ?? -1}`)
      }
    } as unknown as SQL
    const connection = {
      closed: () => new Promise<Error | undefined>(() => {}),
      isClosed: () => false,
      async drain() {
        events.push("nats-drain")
      }
    } as unknown as NatsConnection
    const app = newApp(
      name("payments-ledger-order"),
      resources(newLedgerDatabaseResource(sql), newLedgerNatsResource(connection)),
      server(resident("publisher", events), resident("web", events))
    )
    const running = app.run()
    void running.catch(() => {})

    await waitFor(
      "server start",
      () => events.includes("publisher-start") && events.includes("web-start")
    )
    await app.stop()
    await running

    const publisherStop = events.indexOf("publisher-stop")
    const webStop = events.indexOf("web-stop")
    const drain = events.indexOf("nats-drain")
    const sqlClose = events.indexOf("sql-close:5")
    expect(publisherStop).toBeGreaterThanOrEqual(0)
    expect(webStop).toBeGreaterThanOrEqual(0)
    expect(drain).toBeGreaterThan(Math.max(publisherStop, webStop))
    expect(sqlClose).toBeGreaterThan(drain)
  })

  test("a failed NATS close fails the running app", async () => {
    const failure = new Error("NATS connection failed")
    let finish: (error: Error) => void = () => {}
    const terminal = new Promise<Error>((resolve) => {
      finish = resolve
    })
    let drains = 0
    const connection = {
      closed: () => terminal,
      isClosed: () => false,
      async drain() {
        drains += 1
      }
    } as unknown as NatsConnection
    let ready = false
    const app = newApp(
      name("payments-ledger-terminal"),
      resources(newLedgerNatsResource(connection)),
      afterStart(() => {
        ready = true
      })
    )
    const running = app.run()
    void running.catch(() => {})

    await waitFor("admission", () => ready)
    finish(failure)

    await expect(running).rejects.toBe(failure)
    expect(drains).toBe(1)
  })
})
