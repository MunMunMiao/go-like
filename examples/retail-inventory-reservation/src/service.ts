import { expiresIn, type Cache } from "@go-like/cache"
import { newMemoryCache } from "@go-like/cache-memory"
import type { Context } from "@go-like/context"

export interface ReserveStockCommand {
  readonly requestId: string
  readonly sku: string
  readonly quantity: number
  readonly expiresAt: number
}

export interface StockReservation {
  readonly requestId: string
  readonly sku: string
  readonly quantity: number
  readonly expiresAt: number
}

export interface InventoryAvailability {
  readonly sku: string
  readonly available: number
}

export interface InventoryRepository {
  reserve(ctx: Context, command: ReserveStockCommand): StockReservation
  available(ctx: Context, sku: string): number
}

export type ReserveStock = (ctx: Context, command: ReserveStockCommand) => Promise<StockReservation>
export type GetAvailableStock = (ctx: Context, sku: string) => Promise<InventoryAvailability>

interface SavedReservation {
  readonly fingerprint: string
  readonly reservation: StockReservation
}

export interface RetailInventoryService {
  readonly cache: Cache
  readonly reserve: ReserveStock
  readonly available: GetAvailableStock
}

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

/** Validates one inventory SKU at the application trust boundary. */
export function validateSku(sku: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(sku)) {
    throw new TypeError("invalid sku")
  }
}

/** Validates one inventory reservation at the application trust boundary. */
export function validateReservation(command: ReserveStockCommand, now: number): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(command.requestId)) {
    throw new TypeError("invalid requestId")
  }
  validateSku(command.sku)
  if (!Number.isSafeInteger(command.quantity) || command.quantity <= 0) {
    throw new RangeError("quantity must be a positive safe integer")
  }
  if (!Number.isSafeInteger(command.expiresAt) || command.expiresAt <= now) {
    throw new RangeError("expiresAt must be in the future")
  }
}

/** Produces a stable fingerprint used to reject conflicting idempotency-key reuse. */
function reservationFingerprint(command: ReserveStockCommand): string {
  return `${command.sku}\u0000${command.quantity}\u0000${command.expiresAt}`
}

/** Creates an in-memory repository whose synchronous critical section prevents local overselling. */
export function newMemoryInventoryRepository(
  stock: Readonly<Record<string, number>>
): InventoryRepository {
  const availableBySku = new Map<string, number>()
  const reservations = new Map<string, SavedReservation>()
  for (const [sku, quantity] of Object.entries(stock)) {
    validateSku(sku)
    if (!Number.isSafeInteger(quantity) || quantity < 0) throw new RangeError("invalid stock")
    availableBySku.set(sku, quantity)
  }

  return Object.freeze({
    reserve(ctx: Context, command: ReserveStockCommand): StockReservation {
      const failure = ctx.err()
      if (failure !== null) throw failure
      const fingerprint = reservationFingerprint(command)
      const saved = reservations.get(command.requestId)
      if (saved !== undefined) {
        if (saved.fingerprint !== fingerprint) throw new Error("idempotency conflict")
        return saved.reservation
      }
      const available = availableBySku.get(command.sku)
      if (available === undefined) throw new Error("unknown sku")
      if (available < command.quantity) throw new Error("insufficient stock")
      const reservation = Object.freeze({
        requestId: command.requestId,
        sku: command.sku,
        quantity: command.quantity,
        expiresAt: command.expiresAt
      })
      availableBySku.set(command.sku, available - command.quantity)
      reservations.set(command.requestId, Object.freeze({ fingerprint, reservation }))
      return reservation
    },
    available(ctx: Context, sku: string): number {
      const failure = ctx.err()
      if (failure !== null) throw failure
      const available = availableBySku.get(sku)
      if (available === undefined) throw new Error("unknown sku")
      return available
    }
  })
}

/** Builds the stable cache key for one validated inventory SKU. */
function availabilityKey(sku: string): string {
  return `inventory-available:v1:${sku}`
}

/** Decodes one cached inventory count and fails closed on malformed bytes. */
function decodeAvailable(bytes: Uint8Array): number | null {
  let value: number
  try {
    value = Number(decoder.decode(bytes))
  } catch {
    return null
  }
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

/** Creates the inventory reservation use case with an injectable clock. */
export function newReserveStock(
  repository: InventoryRepository,
  cache: Cache,
  now: () => number = Date.now
): ReserveStock {
  return async function reserveStock(
    ctx: Context,
    command: ReserveStockCommand
  ): Promise<StockReservation> {
    validateReservation(command, now())
    const reservation = repository.reserve(ctx, command)
    const available = repository.available(ctx, command.sku)
    await cache.put(ctx, availabilityKey(command.sku), encoder.encode(String(available)))
    return reservation
  }
}

/** Creates a read-through inventory query backed by go-like Cache. */
export function newGetAvailableStock(
  repository: InventoryRepository,
  cache: Cache,
  ttlMs: number = 1_000
): GetAvailableStock {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
    throw new RangeError("inventory cache ttl must be a positive safe integer")
  }
  return async function getAvailableStock(
    ctx: Context,
    sku: string
  ): Promise<InventoryAvailability> {
    validateSku(sku)
    const key = availabilityKey(sku)
    const bytes = await cache.get(ctx, key)
    const cached = bytes === null ? null : decodeAvailable(bytes)
    const available = cached ?? repository.available(ctx, sku)
    if (cached === null) {
      await cache.put(ctx, key, encoder.encode(String(available)), expiresIn(ttlMs))
    }
    return Object.freeze({ sku, available })
  }
}

/** Creates one complete inventory service and its process-local Cache. */
export function newRetailInventoryService(
  stock: Readonly<Record<string, number>>
): RetailInventoryService {
  const repository = newMemoryInventoryRepository(stock)
  const cache = newMemoryCache()
  return Object.freeze({
    cache,
    reserve: newReserveStock(repository, cache),
    available: newGetAvailableStock(repository, cache)
  })
}
