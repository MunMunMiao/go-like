import type { PutOption, PutOptions } from "./types"

const DefaultPutOptions: PutOptions = Object.freeze({ expiresInMs: null })

/** Validates one positive safe integer duration. */
function positiveDuration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("Cache expiresInMs must be a positive safe integer")
  }
  return value
}

/** Validates and freezes one put option candidate. */
function snapshotPutOptions(value: PutOptions): PutOptions {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Cache put options must be an object")
  }
  return Object.freeze({
    expiresInMs: value.expiresInMs === null ? null : positiveDuration(value.expiresInMs)
  })
}

/** Sets one cache value lifetime in positive safe integer milliseconds. */
export function expiresIn(valueMs: number): PutOption {
  const captured = positiveDuration(valueMs)
  /** Applies the captured lifetime to one put option snapshot. */
  function apply(_options: PutOptions): PutOptions {
    return Object.freeze({ expiresInMs: captured })
  }
  return apply
}

/** Resolves ordered put options from the normative no-expiry default. */
export function putOptions(options: readonly PutOption[] = []): PutOptions {
  let candidate = DefaultPutOptions
  for (const option of options) {
    if (typeof option !== "function") throw new TypeError("Cache put option must be a function")
    candidate = snapshotPutOptions(option(candidate))
  }
  return candidate
}
