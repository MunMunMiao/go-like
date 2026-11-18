import { waitForContext, type Context } from "@go-like/core/context"
import type { TelemetryLifecycle } from "@go-like/core/telemetry"

import { otelAlreadyStarted, shutdownExceeded } from "./errors"
import type { Shutdownable } from "./types"

/** Default owner wait for one provider `shutdown()`, in milliseconds. */
export const defaultOtelShutdownTimeoutMs = 25_000 as const

const maximumTimerDelay = 2_147_483_647

/** Integer 0..2147483647, or the default. Anything else is a RangeError. */
export function readShutdownTimeout(value: number | undefined): number {
  if (value === undefined) return defaultOtelShutdownTimeoutMs
  if (!Number.isInteger(value) || value < 0 || value > maximumTimerDelay) {
    throw new RangeError(
      `OpenTelemetry shutdown timeout must be an integer between zero and ${maximumTimerDelay} milliseconds`
    )
  }
  return value
}

/** Keeps a rejection that nobody is awaiting yet from becoming unhandled. */
function swallow(_reason: unknown): void {}

/**
 * One shutdown of one provider.
 * `start` stays pending until the native shutdown settles. `stop` before `start` still shuts it down.
 * The owner wait is bounded by `timeoutMs`; `start` is not.
 */
export function providerLifecycle(
  provider: Shutdownable,
  timeoutMs: number,
  onAdmit?: (ctx: Context) => void
): TelemetryLifecycle {
  let status: "idle" | "starting" | "running" | "stopping" | "stopped" | "failed" = "idle"
  let owner: Promise<void> | null = null
  let resolveDone!: () => void
  let rejectDone!: (error: unknown) => void
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })
  done.catch(swallow)
  return Object.freeze({
    start(ctx: Context): Promise<void> {
      if (status !== "idle") return Promise.reject(otelAlreadyStarted(status))
      status = "starting"
      const started = waitForContext(ctx, Promise.resolve()).then(() => {
        if (status === "starting") {
          status = "running"
          onAdmit?.(ctx)
        }
        return done
      })
      started.catch(swallow)
      return started
    },
    stop(ctx: Context): Promise<void> {
      if (owner === null) {
        status = "stopping"
        let native: Promise<void>
        try {
          native = Promise.resolve(provider.shutdown())
        } catch (error) {
          native = Promise.reject(error)
        }
        native.then(
          () => {
            status = "stopped"
            resolveDone()
          },
          (error: unknown) => {
            status = "failed"
            rejectDone(error)
          }
        )
        owner = new Promise<void>((resolve, reject) => {
          const exceeded = (): void => {
            reject(shutdownExceeded(timeoutMs))
          }
          const timer = timeoutMs > 0 ? setTimeout(exceeded, timeoutMs) : null
          if (timeoutMs === 0) exceeded()
          native
            .then(
              () => {
                resolve()
              },
              (error: unknown) => {
                reject(error)
              }
            )
            .finally(() => {
              if (timer !== null) clearTimeout(timer)
            })
        })
        owner.catch(swallow)
      }
      return waitForContext(ctx, owner)
    }
  })
}
