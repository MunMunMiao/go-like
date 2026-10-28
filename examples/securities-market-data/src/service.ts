import type { Context } from "@go-like/context"
import { newProbeRegistry, type ProbeRegistry } from "@go-like/health"

export interface MarketQuoteCommand {
  readonly symbol: string
  readonly sequence: number
  readonly bidPriceMicros: number
  readonly bidQuantity: number
  readonly askPriceMicros: number
  readonly askQuantity: number
}

export interface MarketQuote {
  readonly symbol: string
  readonly sequence: number
  readonly bidPriceMicros: number
  readonly bidQuantity: number
  readonly askPriceMicros: number
  readonly askQuantity: number
}

export interface MarketDataRepository {
  publish(ctx: Context, command: MarketQuoteCommand): MarketQuote
  latest(ctx: Context, symbol: string): MarketQuote | null
}

export type PublishMarketQuote = (ctx: Context, command: MarketQuoteCommand) => MarketQuote

export interface SecuritiesMarketDataService {
  readonly publish: PublishMarketQuote
  readonly probes: ProbeRegistry
  readonly repository: MarketDataRepository
}

/** Validates one top-of-book quote against market structure rules. */
export function validateMarketQuote(command: MarketQuoteCommand, tickSizeMicros: number): void {
  if (!/^[A-Z0-9][A-Z0-9._-]{0,15}$/.test(command.symbol)) {
    throw new TypeError("invalid symbol")
  }
  if (!Number.isSafeInteger(command.sequence) || command.sequence <= 0) {
    throw new RangeError("sequence must be a positive safe integer")
  }
  if (!Number.isSafeInteger(tickSizeMicros) || tickSizeMicros <= 0) {
    throw new RangeError("tickSizeMicros must be a positive safe integer")
  }
  if (
    !Number.isSafeInteger(command.bidPriceMicros) ||
    command.bidPriceMicros <= 0 ||
    !Number.isSafeInteger(command.askPriceMicros) ||
    command.askPriceMicros <= 0
  ) {
    throw new RangeError("prices must be positive safe integers")
  }
  if (command.bidPriceMicros >= command.askPriceMicros) {
    throw new Error("bid must be below ask")
  }
  if (
    command.bidPriceMicros % tickSizeMicros !== 0 ||
    command.askPriceMicros % tickSizeMicros !== 0
  ) {
    throw new Error("price is not aligned to tick size")
  }
  if (
    !Number.isSafeInteger(command.bidQuantity) ||
    command.bidQuantity <= 0 ||
    !Number.isSafeInteger(command.askQuantity) ||
    command.askQuantity <= 0
  ) {
    throw new RangeError("quantities must be positive safe integers")
  }
}

function marketQuoteFingerprint(command: MarketQuoteCommand): string {
  return [
    command.symbol,
    command.sequence,
    command.bidPriceMicros,
    command.bidQuantity,
    command.askPriceMicros,
    command.askQuantity
  ].join("\u0000")
}

function marketQuoteFrom(command: MarketQuoteCommand): MarketQuote {
  return Object.freeze({
    symbol: command.symbol,
    sequence: command.sequence,
    bidPriceMicros: command.bidPriceMicros,
    bidQuantity: command.bidQuantity,
    askPriceMicros: command.askPriceMicros,
    askQuantity: command.askQuantity
  })
}

/** Creates an in-memory latest-quote repository with per-symbol sequencing. */
export function newMemoryMarketDataRepository(): MarketDataRepository {
  const quotes = new Map<string, MarketQuote>()
  return Object.freeze({
    publish(ctx: Context, command: MarketQuoteCommand): MarketQuote {
      const failure = ctx.err()
      if (failure !== null) throw failure
      const current = quotes.get(command.symbol)
      if (current !== undefined) {
        if (command.sequence < current.sequence) throw new Error("stale market sequence")
        if (command.sequence === current.sequence) {
          if (marketQuoteFingerprint(command) !== marketQuoteFingerprint(current)) {
            throw new Error("market sequence conflict")
          }
          return current
        }
      }
      const quote = marketQuoteFrom(command)
      quotes.set(command.symbol, quote)
      return quote
    },
    latest(ctx: Context, symbol: string): MarketQuote | null {
      const failure = ctx.err()
      if (failure !== null) throw failure
      return quotes.get(symbol) ?? null
    }
  })
}

/** Creates the quote publication use case for one configured tick size. */
export function newPublishMarketQuote(
  repository: MarketDataRepository,
  tickSizeMicros: number
): PublishMarketQuote {
  return function publishMarketQuote(ctx: Context, command: MarketQuoteCommand): MarketQuote {
    validateMarketQuote(command, tickSizeMicros)
    return repository.publish(ctx, command)
  }
}

function checkContext(ctx: Context): void {
  const failure = ctx.err()
  if (failure !== null) throw failure
}

/** Composes quote ingestion with live and data-readiness health probes. */
export function newSecuritiesMarketDataService(
  tickSizeMicros: number,
  requiredSymbol: string
): SecuritiesMarketDataService {
  if (!/^[A-Z0-9][A-Z0-9._-]{0,15}$/.test(requiredSymbol)) {
    throw new TypeError("invalid required market-data symbol")
  }
  const repository = newMemoryMarketDataRepository()
  const probes = newProbeRegistry()
  probes.register("live", "market-data-runtime", checkContext)
  probes.register("ready", "required-market-quote", function quoteReady(ctx: Context): void {
    if (repository.latest(ctx, requiredSymbol) === null) {
      throw new Error(`market quote for ${requiredSymbol} is not ready`)
    }
  })
  return Object.freeze({
    publish: newPublishMarketQuote(repository, tickSizeMicros),
    probes,
    repository
  })
}
