/** Recognizes standard Error values across realms, with an instanceof fallback. */
export function isError(value: unknown): value is Error {
  const descriptor = Object.getOwnPropertyDescriptor(Error, "isError")
  const candidate: unknown = descriptor?.value
  if (typeof candidate === "function") return candidate(value) === true
  return value instanceof Error
}

/** Preserves an Error's identity and wraps every other thrown value. */
export function toError(value: unknown, message: string): Error {
  if (isError(value)) return value
  return new Error(message, { cause: value })
}

/** Appends one failure unless that Error identity is already present. */
export function addFailure(errors: Error[], error: Error): void {
  if (!errors.includes(error)) errors.push(error)
}

/** Returns one failure unchanged, several as an AggregateError, and none as null. */
export function aggregateFailure(errors: readonly Error[], message: string): Error | null {
  const first = errors[0]
  if (first === undefined) return null
  if (errors.length === 1) return first
  return new AggregateError(errors, message)
}
