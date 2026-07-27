/** Catalog identifiers and immutable in-process reference data. */
const ProductId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const SupportedCurrencies = new Set(["USD", "CNY"])

export const maximumCacheTtlMs = 30_000

export interface Product {
  readonly id: string
  readonly name: string
}

export interface PriceQuote {
  readonly productId: string
  readonly currency: string
  readonly amountMinor: number
  readonly validUntil: number
}

const Products: Readonly<Record<string, Product>> = Object.freeze({
  "sku-001": Object.freeze({ id: "sku-001", name: "LikeGo Mug" }),
  "sku-002": Object.freeze({ id: "sku-002", name: "LikeGo T-Shirt" })
})

const Prices: Readonly<Record<string, Readonly<Record<string, number>>>> = Object.freeze({
  "sku-001": Object.freeze({ USD: 1299, CNY: 8990 }),
  "sku-002": Object.freeze({ USD: 2499, CNY: 16990 })
})

/** Reports whether one value is a bounded product identifier. */
export function isProductId(value: string): boolean {
  return ProductId.test(value)
}

/** Reports whether the catalog supports one settlement currency. */
export function isSupportedCurrency(value: string): boolean {
  return SupportedCurrencies.has(value)
}

/** Finds one immutable catalog product without consulting inherited object properties. */
export function findProduct(productId: string): Product | null {
  return Object.hasOwn(Products, productId) ? (Products[productId] ?? null) : null
}

/** Finds one authoritative price without consulting inherited object properties. */
export function findAmountMinor(productId: string, currency: string): number | null {
  const prices = Object.hasOwn(Prices, productId) ? Prices[productId] : undefined
  return prices?.[currency] ?? null
}
