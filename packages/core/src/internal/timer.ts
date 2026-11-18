/** Largest delay accepted by setTimeout in every supported runtime. */
export const MaximumTimerDelayMs = 2_147_483_647

/** Validates an integer millisecond option in `[minimum, MaximumTimerDelayMs]`. */
export function timerMs(value: unknown, label: string, minimum = 0): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > MaximumTimerDelayMs
  ) {
    throw new RangeError(
      `${label} must be an integer from ${minimum} to ${MaximumTimerDelayMs} milliseconds`
    )
  }
  return value
}

/** Calls `unref` when the runtime timer exposes it, and ignores every other value. */
export function unrefTimer(timer: unknown): void {
  if (typeof timer !== "object" || timer === null) return
  const unref: unknown = Reflect.get(timer, "unref")
  if (typeof unref !== "function") return
  try {
    Reflect.apply(unref, timer, [])
  } catch {
    // A timer that cannot leave the event loop still runs; the caller keeps the handle.
  }
}
