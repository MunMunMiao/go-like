import { background, withCancel } from "@go-like/context"
import { name, newApp, server } from "@go-like/core"
import { describe, expect, test } from "bun:test"
import { newBankTransferHandler } from "../src/http"
import {
  buildTransferQuote,
  newMemoryTransferNetworkDirectory,
  newQuoteTransfer,
  validateTransferQuote
} from "../src/service"
import { newBankTransferMicroservice } from "../src/transport"

function quoteTransfer() {
  return newQuoteTransfer(newMemoryTransferNetworkDirectory(["DE", "FR", "NL"]))
}

describe("bank transfer gateway", () => {
  test("prefers domestic clearing for transfers within one country", () => {
    const quote = quoteTransfer()(background(), {
      requestId: "domestic-1",
      sourceCountry: "DE",
      beneficiaryCountry: "DE",
      currency: "USD",
      amountMinor: 50_000,
      beneficiaryBic: null
    })
    expect(quote).toMatchObject({ rail: "domestic", feeMinor: 25, settlementBusinessDays: 0 })
  })

  test("uses SEPA only when both countries participate and the currency is EUR", () => {
    const quote = quoteTransfer()(background(), {
      requestId: "sepa-1",
      sourceCountry: "DE",
      beneficiaryCountry: "FR",
      currency: "EUR",
      amountMinor: 50_000,
      beneficiaryBic: null
    })
    expect(quote).toMatchObject({ rail: "sepa", feeMinor: 35, settlementBusinessDays: 1 })
  })

  test("requires BIC for SWIFT and enforces the minimum fee", () => {
    const transfer = quoteTransfer()
    expect(() =>
      transfer(background(), {
        requestId: "swift-missing",
        sourceCountry: "DE",
        beneficiaryCountry: "US",
        currency: "USD",
        amountMinor: 100_000,
        beneficiaryBic: null
      })
    ).toThrow("beneficiaryBic is required for SWIFT")
    expect(
      transfer(background(), {
        requestId: "swift-1",
        sourceCountry: "DE",
        beneficiaryCountry: "US",
        currency: "USD",
        amountMinor: 100_000,
        beneficiaryBic: "BOFAUS3NXXX"
      })
    ).toMatchObject({ rail: "swift", feeMinor: 1_500 })
  })

  test("serves a transfer quote through a standard Fetch handler", async () => {
    const response = await newBankTransferHandler(quoteTransfer())(
      new Request("https://example.test/v1/transfer-quotes", {
        method: "POST",
        body: JSON.stringify({
          requestId: "web-1",
          sourceCountry: "NL",
          beneficiaryCountry: "FR",
          currency: "EUR",
          amountMinor: 25_000
        })
      })
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ rail: "sepa" })
  })

  test("routes an internal unary call through Client, Server, and Memory Transport", async () => {
    const service = newBankTransferMicroservice(["DE", "FR", "NL"])
    const app = newApp(name("bank-transfer-test"), server(service.server))
    const running = app.run()
    await service.server.endpoint(background())
    try {
      const quote = await service.client.quote(background(), {
        requestId: "internal-1",
        sourceCountry: "DE",
        beneficiaryCountry: "FR",
        currency: "EUR",
        amountMinor: 50_000,
        beneficiaryBic: null
      })
      expect(service.address).toBe("memory://bank-transfer-gateway")
      expect(quote).toEqual({
        requestId: "internal-1",
        rail: "sepa",
        feeMinor: 35,
        settlementBusinessDays: 1
      })
      const response = await newBankTransferHandler(service.client.quote)(
        new Request("https://example.test/v1/transfer-quotes", {
          method: "POST",
          body: JSON.stringify({
            requestId: "internal-web-1",
            sourceCountry: "DE",
            beneficiaryCountry: "FR",
            currency: "EUR",
            amountMinor: 50_000
          })
        })
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ requestId: "internal-web-1", rail: "sepa" })
    } finally {
      await app.stop()
      await running
    }
  })

  test("validates transfer commands and maps Fetch errors", async () => {
    const valid = {
      requestId: "valid:1",
      sourceCountry: "DE",
      beneficiaryCountry: "US",
      currency: "USD",
      amountMinor: 100_000,
      beneficiaryBic: "BOFAUS3NXXX"
    }
    expect(validateTransferQuote(valid)).toBeUndefined()
    for (const [field, value, message] of [
      ["requestId", "", "invalid requestId"],
      ["sourceCountry", "D", "invalid sourceCountry"],
      ["beneficiaryCountry", "USA", "invalid beneficiaryCountry"],
      ["currency", "US", "invalid currency"],
      ["amountMinor", 0, "amountMinor is outside the supported range"],
      ["amountMinor", 1.5, "amountMinor is outside the supported range"],
      ["beneficiaryBic", "bad", "invalid beneficiaryBic"]
    ] as const) {
      expect(() => validateTransferQuote({ ...valid, [field]: value })).toThrow(message)
    }
    expect(() => newMemoryTransferNetworkDirectory(["D"])).toThrow("invalid SEPA country")
    expect(
      buildTransferQuote({ ...valid, beneficiaryBic: "BOFAUS3NXXX" }, false, false)
    ).toMatchObject({
      rail: "swift",
      feeMinor: 1500,
      settlementBusinessDays: 3
    })
    expect(buildTransferQuote({ ...valid, amountMinor: 2_000_000 }, false, false).feeMinor).toBe(
      3000
    )

    const validHandler = newBankTransferHandler(quoteTransfer())
    const invalidResponse = await validHandler(
      new Request("https://example.test/v1/transfer-quotes", {
        method: "POST",
        body: JSON.stringify({ ...valid, amountMinor: 0 })
      })
    )
    expect(invalidResponse.status).toBe(400)
    expect(await invalidResponse.json()).toMatchObject({
      code: "transfer_quote_rejected",
      message: "amountMinor is outside the supported range"
    })
    expect(
      (await validHandler(new Request("https://example.test/other", { method: "GET" }))).status
    ).toBe(404)

    const handler = newBankTransferHandler(() => {
      throw new Error("provider unavailable")
    })
    const response = await handler(
      new Request("https://example.test/v1/transfer-quotes", {
        method: "POST",
        body: JSON.stringify({ ...valid, beneficiaryBic: null })
      })
    )
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({
      code: "transfer_quote_rejected",
      message: "provider unavailable"
    })

    const [ctx, cancel] = withCancel(background())
    cancel()
    expect(() => newMemoryTransferNetworkDirectory(["DE"]).isSepaCountry(ctx, "DE")).toThrow()
  })
})
