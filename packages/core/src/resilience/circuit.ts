import type { Context, ContextError } from "../context/index"
import { recordEvent, SemconvValue } from "../telemetry/internal/instrument"

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
  const recordedName = circuitName(options.name)

  let state: CircuitState = "closed"
  let consecutiveFailures = 0
  let openedAt = 0
  let probeActive = false
  let generation = 0
  let pending: "half_open" | null = null

  /** Records one transition. `half-open` is spelled `half_open` on the event. */
  function recordTransition(ctx: Context, next: "closed" | "open" | "half_open"): void {
    recordEvent(ctx, { kind: "circuit_breaker.transition", name: recordedName, state: next })
  }

  /** Writes a transition that snapshot observed before the next execute had a Context. */
  function flushPending(ctx: Context): void {
    if (pending === null) return
    const next = pending
    pending = null
    recordTransition(ctx, next)
  }

  /** Advances an elapsed open circuit into half-open without admitting a probe. */
  function refresh(observedAt: number, ctx: Context | null): void {
    if (state !== "open" || observedAt - openedAt < resetTimeoutMs) return
    state = "half-open"
    probeActive = false
    generation += 1
    if (ctx === null) pending = "half_open"
    else recordTransition(ctx, "half_open")
  }

  /** Admits one closed call or the sole half-open probe and returns its generation ticket. */
  function admit(observedAt: number, ctx: Context): CircuitTicket {
    refresh(observedAt, ctx)
    if (state === "open") throw circuitOpen
    if (state === "half-open") {
      if (probeActive) throw circuitOpen
      probeActive = true
      return { generation, state: "half-open" }
    }
    return { generation, state: "closed" }
  }

  /** Opens the circuit and invalidates every call admitted by the preceding generation. */
  function openCircuit(observedAt: number, ctx: Context): void {
    state = "open"
    openedAt = observedAt
    probeActive = false
    generation += 1
    recordTransition(ctx, "open")
  }

  /** Records an admitted success unless a newer transition made the outcome stale. */
  function recordSuccess(ticket: CircuitTicket, ctx: Context): void {
    if (ticket.generation !== generation) return
    if (ticket.state === "half-open") {
      state = "closed"
      probeActive = false
      consecutiveFailures = 0
      generation += 1
      recordTransition(ctx, "closed")
      return
    }
    consecutiveFailures = 0
  }

  /** Records an admitted breaker failure unless a newer transition made the outcome stale. */
  function recordFailure(ticket: CircuitTicket, ctx: Context): void {
    if (ticket.generation !== generation) return
    if (ticket.state === "half-open") {
      openCircuit(monotonicNow(), ctx)
      return
    }
    consecutiveFailures += 1
    if (consecutiveFailures >= failureThreshold) openCircuit(monotonicNow(), ctx)
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
      flushPending(ctx)
      const ticket = admit(monotonicNow(), ctx)
      try {
        const result = await operation(ctx)
        recordSuccess(ticket, ctx)
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
            recordFailure(ticket, ctx)
            throw classificationFailure
          }
          contextFailure = observedContextFailure(ctx, ticket)
          if (contextFailure !== null) {
            recordNeutral(ticket)
            throw contextFailure
          }
          if (typeof breakerFailure !== "boolean") {
            recordFailure(ticket, ctx)
            throw new TypeError("isFailure must return a boolean")
          }
        }
        if (breakerFailure) recordFailure(ticket, ctx)
        else recordSuccess(ticket, ctx)
        throw failure
      }
    },
    /** Returns an immutable snapshot after applying any elapsed reset timeout. */
    snapshot(): CircuitSnapshot {
      const observedAt = monotonicNow()
      refresh(observedAt, null)
      const retryAfterMs =
        state === "open" ? Math.max(0, Math.ceil(openedAt + resetTimeoutMs - observedAt)) : 0
      return Object.freeze({ state, consecutiveFailures, probeActive, retryAfterMs })
    }
  })
  return breaker
}

/** Accepts an omitted name or a bounded code-defined name. */
function circuitName(value: string | undefined): string {
  if (value === undefined) return SemconvValue.other
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new TypeError("circuit breaker name must be a non-empty string of at most 128 characters")
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) {
      throw new TypeError("circuit breaker name must not contain control characters")
    }
  }
  return value
}
