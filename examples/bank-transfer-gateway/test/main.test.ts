import { background } from "@likego/context"
import { name, newApp, server } from "@likego/core"
import { describe, expect, test } from "bun:test"
import { newBankTransferHandler } from "../src/http"
import { newMemoryTransferNetworkDirectory, newQuoteTransfer } from "../src/service"
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
})
