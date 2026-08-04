import { describe, expect, test } from "bun:test"
import { SQL } from "bun"

import { background } from "@go-like/context"
import { name, newApp, server } from "@go-like/core"

import { newPaymentHandler } from "../src/http"
import { isPaymentFailure, parsePaymentRequest } from "../src/payment"
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

describe("payment application lifecycle", () => {
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
