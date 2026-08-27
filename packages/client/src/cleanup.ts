import { background, cause, withTimeoutCause } from "@go-like/context"
import type { Client as TransportClient, Message } from "@go-like/transport"

interface CompletedCallFailure extends AggregateError {
  readonly cause: Message
}

const completedCallFailures = new WeakSet<object>()

type CloseOutcome =
  | { readonly state: "closed" }
  | { readonly state: "failed"; readonly error: Error }
  | { readonly state: "timeout" }

/** Recognizes built-in Error values across realms with a legacy-runtime fallback. */
export function isError(value: unknown): value is Error {
  const candidate: unknown = Object.getOwnPropertyDescriptor(Error, "isError")?.value
  return (typeof candidate === "function" && candidate(value) === true) || value instanceof Error
}

/** Preserves a completed response and ordered cleanup failures using standard Error fields. */
export function newCompletedCallFailure(
  response: Message,
  failures: readonly Error[]
): CompletedCallFailure {
  const captured = Object.freeze(Array.from(failures))
  const error = new AggregateError(
    captured,
    "client exchange completed but cleanup failed; do not retry",
    { cause: response }
  ) as CompletedCallFailure
  Object.freeze(error.errors)
  completedCallFailures.add(error)
  return Object.freeze(error)
}

/** Recognizes only completed-call failures created by this package for retry suppression. */
export function isCompletedCallFailure(value: unknown): value is CompletedCallFailure {
  return typeof value === "object" && value !== null && completedCallFailures.has(value)
}

/** Preserves Error identity and normalizes a non-Error close rejection. */
function closeError(value: unknown): Error {
  return isError(value) ? value : new Error("transport client close rejected", { cause: value })
}

/** Creates one ordinary timeout diagnostic for an orphaned close operation. */
function closeTimeoutError(timeoutMs: number): Error {
  return new Error(`transport client close exceeded ${timeoutMs}ms`)
}

/** Invokes close under one deadline and keeps every late settlement observed. */
export async function closeWithTimeout(
  receiver: TransportClient,
  close: TransportClient["close"],
  timeoutMs: number
): Promise<void> {
  if (timeoutMs === 0) {
    try {
      await close.call(receiver, background())
      return
    } catch (value) {
      throw closeError(value)
    }
  }

  const timeout = closeTimeoutError(timeoutMs)
  const timed = withTimeoutCause(background(), timeoutMs, timeout)
  let observed: Promise<CloseOutcome>
  try {
    observed = Promise.resolve(close.call(receiver, timed[0])).then(
      function closed(): CloseOutcome {
        return Object.freeze({ state: "closed" })
      },
      function failed(value): CloseOutcome {
        return Object.freeze({ state: "failed", error: closeError(value) })
      }
    )
  } catch (value) {
    timed[1]()
    throw closeError(value)
  }

  const expired = new Promise<CloseOutcome>(function waitForDeadline(resolve): void {
    const signal = timed[0].done()
    if (signal === null) return
    signal.addEventListener(
      "abort",
      function deadline(): void {
        resolve(Object.freeze({ state: "timeout" }))
      },
      { once: true }
    )
  })
  const outcome = await Promise.race([observed, expired])
  const deadlineWon = cause(timed[0]) === timeout
  timed[1]()
  if (deadlineWon || outcome.state === "timeout") throw timeout
  if (outcome.state === "failed") throw outcome.error
}
