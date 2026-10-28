import type { Context, ContextError } from "@go-like/context"

import { circuitOpen } from "./errors"
import { activeContext, inspectContext, monotonicNow, readContextFailure } from "./internal"
import type {
  CircuitBreaker,
  CircuitBreakerOptions,
  CircuitOperation,
  CircuitSnapshot,
  CircuitState
} from "./types"

interface CircuitTicket {
  readonly generation: number
  readonly state: "closed" | "half-open"
}

/** Creates a consecutive-failure circuit breaker with one half-open probe at a time. */
export function newCircuitBreaker(options: CircuitBreakerOptions): CircuitBreaker {
  if (options === null || typeof options !== "object") {
    throw new TypeError("circuit breaker options must be an object")
  }
  const failureThreshold = options.failureThreshold
  const resetTimeoutMs = options.resetTimeoutMs
  const isFailure = options.isFailure
  if (!Number.isSafeInteger(failureThreshold) || failureThreshold < 1) {
    throw new RangeError("failureThreshold must be a positive safe integer")
  }
  if (!Number.isFinite(resetTimeoutMs) || resetTimeoutMs < 0) {
    throw new RangeError("resetTimeoutMs must be a finite non-negative number")
  }
  if (isFailure !== undefined && typeof isFailure !== "function") {
    throw new TypeError("isFailure must be callable")
  }

  let state: CircuitState = "closed"
  let consecutiveFailures = 0
  let openedAt = 0
  let probeActive = false
  let generation = 0

  /** Advances an elapsed open circuit into half-open without admitting a probe. */
  function refresh(observedAt: number): void {
    if (state !== "open" || observedAt - openedAt < resetTimeoutMs) return
    state = "half-open"
    probeActive = false
    generation += 1
  }

  /** Admits one closed call or the sole half-open probe and returns its generation ticket. */
  function admit(observedAt: number): CircuitTicket {
    refresh(observedAt)
    if (state === "open") throw circuitOpen
    if (state === "half-open") {
      if (probeActive) throw circuitOpen
      probeActive = true
      return { generation, state: "half-open" }
    }
    return { generation, state: "closed" }
  }

  /** Opens the circuit and invalidates every call admitted by the preceding generation. */
  function openCircuit(observedAt: number): void {
    state = "open"
    openedAt = observedAt
    probeActive = false
    generation += 1
  }

  /** Records an admitted success unless a newer transition made the outcome stale. */
  function recordSuccess(ticket: CircuitTicket): void {
    if (ticket.generation !== generation) return
    if (ticket.state === "half-open") {
      state = "closed"
      probeActive = false
      consecutiveFailures = 0
      generation += 1
      return
    }
    consecutiveFailures = 0
  }

  /** Records an admitted breaker failure unless a newer transition made the outcome stale. */
  function recordFailure(ticket: CircuitTicket): void {
    if (ticket.generation !== generation) return
    if (ticket.state === "half-open") {
      openCircuit(monotonicNow())
      return
    }
    consecutiveFailures += 1
    if (consecutiveFailures >= failureThreshold) openCircuit(monotonicNow())
  }

  /** Releases a canceled half-open probe without counting it as a breaker outcome. */
  function recordNeutral(ticket: CircuitTicket): void {
    if (ticket.generation === generation && ticket.state === "half-open") {
      probeActive = false
    }
  }

  /** Reads terminal Context state while ensuring a malformed Context cannot retain a half-open probe. */
  function observedContextFailure(ctx: Context, ticket: CircuitTicket): ContextError | null {
    try {
      return readContextFailure(inspectContext(ctx))
    } catch (contextReadFailure) {
      recordNeutral(ticket)
      throw contextReadFailure
    }
  }

  const breaker: CircuitBreaker = Object.freeze({
    /** Runs one operation when the current circuit state admits it. */
    async execute<T>(ctx: Context, operation: CircuitOperation<T>): Promise<T> {
      activeContext(ctx)
      if (typeof operation !== "function") throw new TypeError("operation must be callable")
      const ticket = admit(monotonicNow())
      try {
        const result = await operation(ctx)
        recordSuccess(ticket)
        return result
      } catch (failure) {
        let contextFailure = observedContextFailure(ctx, ticket)
        if (contextFailure !== null) {
          recordNeutral(ticket)
          throw contextFailure
        }
        let breakerFailure = true
        if (isFailure !== undefined) {
          try {
            breakerFailure = await isFailure(ctx, failure)
          } catch (classificationFailure) {
            contextFailure = observedContextFailure(ctx, ticket)
            if (contextFailure !== null) {
              recordNeutral(ticket)
              throw contextFailure
            }
            recordFailure(ticket)
            throw classificationFailure
          }
          contextFailure = observedContextFailure(ctx, ticket)
          if (contextFailure !== null) {
            recordNeutral(ticket)
            throw contextFailure
          }
          if (typeof breakerFailure !== "boolean") {
            recordFailure(ticket)
            throw new TypeError("isFailure must return a boolean")
          }
        }
        if (breakerFailure) recordFailure(ticket)
        else recordSuccess(ticket)
        throw failure
      }
    },
    /** Returns an immutable snapshot after applying any elapsed reset timeout. */
    snapshot(): CircuitSnapshot {
      const observedAt = monotonicNow()
      refresh(observedAt)
      const retryAfterMs =
        state === "open" ? Math.max(0, Math.ceil(openedAt + resetTimeoutMs - observedAt)) : 0
      return Object.freeze({ state, consecutiveFailures, probeActive, retryAfterMs })
    }
  })
  return breaker
}
