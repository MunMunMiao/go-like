import { cause, canceled, withCancelCause, withoutCancel, type Context } from "../context"
import { waitForContext } from "../context"
import { isError } from "../internal/errors"
import { waitForDelay } from "../internal/context"
import {
  detachSpan,
  enterRoot,
  LogEvent,
  LogField,
  logEvent
} from "../telemetry/internal/instrument"

import { notifyRegistrationError } from "./options"
import type { IdentityLocks } from "./locks"
import type { RegistrationErrorHandler, ServiceInstance } from "./types"

/** Options for one registration generation's renewal loop. */
export interface HeartbeatOptions {
  /** The registered instance, passed to onRegistrationError. */
  readonly instance: ServiceInstance
  /** Registration identity whose lock every renewal holds. */
  readonly identity: string
  readonly locks: IdentityLocks
  /** Delay between successful renewals. */
  readonly intervalMs: number
  /** Lower bound of the delay after a retryable failure. */
  readonly retryInitialMs: number
  /** Upper bound of the delay after a retryable failure. */
  readonly retryMaximumMs: number
  readonly retryable: (error: unknown) => boolean
  /** One renewal under a Context canceled when the heartbeat stops. */
  readonly renew: (ctx: Context) => Promise<void>
  /** Called with the lock held when a non-retryable failure ends the generation. */
  readonly lost: (error: Error) => void
  readonly onRegistrationError: RegistrationErrorHandler | null
  /** Fixed message of the heartbeat failure record. Never error text. */
  readonly message: string
}

/** A started renewal loop. */
export interface Heartbeat {
  /**
   * Ends the generation. No renewal starts afterwards. An in-flight renewal's Context is canceled.
   * Resolves when the loop has exited. `ctx` bounds only this wait.
   */
  stop(ctx: Context): Promise<void>
}

/** Starts one registration generation's renewal loop under the register Context's values. */
export function startHeartbeat(registerCtx: Context, options: HeartbeatOptions): Heartbeat {
  const intervalMs = delayMs(options.intervalMs, "intervalMs")
  const retryInitialMs = delayMs(options.retryInitialMs, "retryInitialMs")
  const retryMaximumMs = delayMs(options.retryMaximumMs, "retryMaximumMs")
  if (retryMaximumMs < retryInitialMs) {
    throw new RangeError("retryMaximumMs must be greater than or equal to retryInitialMs")
  }
  if (typeof options.identity !== "string" || options.identity.length === 0) {
    throw new TypeError("heartbeat identity must be a non-empty string")
  }
  if (typeof options.retryable !== "function" || typeof options.renew !== "function") {
    throw new TypeError("heartbeat retryable and renew must be functions")
  }
  if (typeof options.lost !== "function") throw new TypeError("heartbeat lost must be a function")
  if (typeof options.message !== "string" || options.message.length === 0) {
    throw new TypeError("heartbeat message must be a non-empty string")
  }
  if (
    options.locks === null ||
    typeof options.locks !== "object" ||
    typeof options.locks.acquire !== "function"
  ) {
    throw new TypeError("heartbeat locks must implement IdentityLocks")
  }
  const failure = cause(registerCtx)
  if (failure !== null) throw failure
  const [loopCtx, cancelLoop] = withCancelCause(detachSpan(withoutCancel(registerCtx)))
  let delay = intervalMs
  let stopping = false

  /** Writes one heartbeat diagnostic without copying error text into the message. */
  function report(level: "warn" | "error", error: unknown): void {
    logEvent(registerCtx, level, LogEvent.registryHeartbeatFailed, options.message, {
      [LogField.exception]: isError(error) ? error : new Error("registry heartbeat failed")
    })
  }

  const exited = enterRoot(loopCtx, async () => {
    while (loopCtx.err() === null) {
      let release: (() => void) | null = null
      try {
        release = await options.locks.acquire(loopCtx, options.identity)
      } catch {
        return
      }
      let wait = delay
      try {
        if (loopCtx.err() !== null) return
        try {
          await options.renew(loopCtx)
          delay = intervalMs
          wait = intervalMs
        } catch (error) {
          if (loopCtx.err() !== null) return
          if (options.retryable(error)) {
            report("warn", error)
            delay = Math.min(retryMaximumMs, Math.max(retryInitialMs, Math.floor(delay / 2)))
            wait = delay
          } else {
            const terminal = isError(error) ? error : new Error("registry heartbeat failed")
            try {
              options.lost(terminal)
            } catch {
              // A lost callback must not replace the generation failure.
            }
            notifyRegistrationError(options.onRegistrationError, terminal, options.instance)
            report("error", terminal)
            return
          }
        }
      } finally {
        release()
      }
      try {
        await waitForDelay(loopCtx, wait)
      } catch {
        return
      }
    }
  })

  return {
    /** Cancels the loop and waits until it has left, or until `ctx` ends. */
    stop(ctx: Context): Promise<void> {
      if (!stopping) {
        stopping = true
        cancelLoop(cause(ctx) ?? canceled)
      }
      return waitForContext(ctx, exited)
    }
  }
}

/** Requires a portable non-negative timer delay. */
function delayMs(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) {
    throw new RangeError(`${name} must be an integer from 0 through 2147483647`)
  }
  return value
}
