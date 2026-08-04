import type { Context } from "@go-like/context"
import type { TransferQuote, TransferQuoteCommand } from "./contract"

export interface TransferNetworkDirectory {
  isSepaCountry(ctx: Context, country: string): boolean
}

export type QuoteTransfer = (ctx: Context, command: TransferQuoteCommand) => TransferQuote

/** Validates one transfer routing request without performing network discovery. */
export function validateTransferQuote(command: TransferQuoteCommand): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(command.requestId)) {
    throw new TypeError("invalid requestId")
  }
  if (!/^[A-Z]{2}$/.test(command.sourceCountry)) {
    throw new TypeError("invalid sourceCountry")
  }
  if (!/^[A-Z]{2}$/.test(command.beneficiaryCountry)) {
    throw new TypeError("invalid beneficiaryCountry")
  }
  if (!/^[A-Z]{3}$/.test(command.currency)) throw new TypeError("invalid currency")
  if (
    !Number.isSafeInteger(command.amountMinor) ||
    command.amountMinor <= 0 ||
    command.amountMinor > 1_000_000_000_000
  ) {
    throw new RangeError("amountMinor is outside the supported range")
  }
  if (
    command.beneficiaryBic !== null &&
    !/^[A-Z0-9]{8}(?:[A-Z0-9]{3})?$/.test(command.beneficiaryBic)
  ) {
    throw new TypeError("invalid beneficiaryBic")
  }
}

function swiftFeeMinor(amountMinor: number): number {
  const proportional = Number((BigInt(amountMinor) * 15n + 9_999n) / 10_000n)
  return Math.max(1_500, proportional)
}

/** Selects a payment rail from explicit network-membership facts. */
export function buildTransferQuote(
  command: TransferQuoteCommand,
  sourceIsSepa: boolean,
  beneficiaryIsSepa: boolean
): TransferQuote {
  if (command.sourceCountry === command.beneficiaryCountry) {
    return Object.freeze({
      requestId: command.requestId,
      rail: "domestic",
      feeMinor: 25,
      settlementBusinessDays: 0
    })
  }
  if (command.currency === "EUR" && sourceIsSepa && beneficiaryIsSepa) {
    return Object.freeze({
      requestId: command.requestId,
      rail: "sepa",
      feeMinor: 35,
      settlementBusinessDays: 1
    })
  }
  if (command.beneficiaryBic === null) {
    throw new Error("beneficiaryBic is required for SWIFT")
  }
  return Object.freeze({
    requestId: command.requestId,
    rail: "swift",
    feeMinor: swiftFeeMinor(command.amountMinor),
    settlementBusinessDays: 3
  })
}

/** Creates a deterministic transfer-network membership directory. */
export function newMemoryTransferNetworkDirectory(
  sepaCountries: readonly string[]
): TransferNetworkDirectory {
  const countries = new Set<string>()
  for (const country of sepaCountries) {
    if (!/^[A-Z]{2}$/.test(country)) throw new TypeError("invalid SEPA country")
    countries.add(country)
  }
  return Object.freeze({
    isSepaCountry(ctx: Context, country: string): boolean {
      const failure = ctx.err()
      if (failure !== null) throw failure
      return countries.has(country)
    }
  })
}

/** Creates the routing use case backed by an explicit network directory. */
export function newQuoteTransfer(directory: TransferNetworkDirectory): QuoteTransfer {
  return function quoteTransfer(ctx: Context, command: TransferQuoteCommand): TransferQuote {
    validateTransferQuote(command)
    const sourceIsSepa = directory.isSepaCountry(ctx, command.sourceCountry)
    const beneficiaryIsSepa = directory.isSepaCountry(ctx, command.beneficiaryCountry)
    return buildTransferQuote(command, sourceIsSepa, beneficiaryIsSepa)
  }
}
