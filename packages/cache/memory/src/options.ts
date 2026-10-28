import type { MemoryCacheClock, MemoryCacheOption, MemoryCacheOptions } from "./types"

/** Reads the standard runtime wall clock without capturing runtime-specific globals. */
function standardNow(): number {
  return Date.now()
}

const DefaultOptions: MemoryCacheOptions = Object.freeze({ clock: standardNow })

/** Validates one clock capability without invoking application code. */
function requireClock(value: MemoryCacheClock): MemoryCacheClock {
  if (typeof value !== "function") throw new TypeError("Memory Cache clock must be a function")
  return value
}

/** Validates and freezes one Memory Cache option candidate. */
function snapshotOptions(value: MemoryCacheOptions): MemoryCacheOptions {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Memory Cache options must be an object")
  }
  return Object.freeze({ clock: requireClock(value.clock) })
}

/** Selects one deterministic millisecond clock for this Memory Cache instance. */
export function clock(value: MemoryCacheClock): MemoryCacheOption {
  const captured = requireClock(value)
  /** Applies the captured clock to one immutable option snapshot. */
  function apply(_options: MemoryCacheOptions): MemoryCacheOptions {
    return Object.freeze({ clock: captured })
  }
  return apply
}

/** Resolves ordered construction options from the standard Date.now clock. */
export function memoryCacheOptions(options: readonly MemoryCacheOption[]): MemoryCacheOptions {
  let candidate = DefaultOptions
  for (const option of options) {
    if (typeof option !== "function") throw new TypeError("Memory Cache option must be a function")
    candidate = snapshotOptions(option(candidate))
  }
  return candidate
}
