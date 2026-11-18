import type { Context } from "@go-like/core/context"
import type { LogAttrs, LogHandler, LogLevel, LogRecord } from "@go-like/core/log"
import { LogField } from "@go-like/core/telemetry"
import { logCorrelation } from "@go-like/core/telemetry/provider"
import type { Logger } from "pino"

import { createPinoLifecycle, pinoDrainTimeout } from "./runtime"
import type { OfficialPinoDestination } from "./runtime"
import type { PinoHandler, PinoHandlerOption } from "./types"

export { pinoDrainTimeout }

/** Copies core attributes, mapping the diagnostic Error onto pino's `err` key. */
function fields(attrs: LogAttrs, into: Record<string, unknown>): Record<string, unknown> {
  for (const [key, value] of Object.entries(attrs)) {
    into[key === LogField.exception ? "err" : key] = value
  }
  return into
}

/** One level method on an official Pino logger. */
type LevelWrite = (mergingObject: object, message?: string) => void

/** Writes one record through the level method. Native failures are dropped. */
function write(logger: Logger, level: LogLevel, mergingObject: object, message: string): void {
  const method: LevelWrite = logger[level].bind(logger)
  method(mergingObject, message)
}

/** Builds a handler whose logger is resolved on each call so admission can rebind the root. */
function handlerFor(target: () => Logger, bound: Record<string, unknown> = {}): LogHandler {
  return Object.freeze({
    enabled(_ctx: Context, level: LogLevel): boolean {
      return target().isLevelEnabled(level)
    },
    handle(ctx: Context, record: LogRecord): void {
      const out = fields(record.attrs, { ...bound })
      const correlation = logCorrelation(ctx)
      if (correlation !== null) Object.assign(out, correlation)
      if (record.event !== "") out[LogField.event] = record.event
      try {
        write(target(), record.level, out, record.message)
      } catch {
        // Native failures inside handle are caught and dropped.
      }
    },
    withAttrs(attrs: LogAttrs): LogHandler {
      const next = fields(attrs, { ...bound })
      let child: Logger | null = null
      let parent: Logger | null = null
      return handlerFor(() => {
        const current = target()
        if (child === null || parent !== current) {
          child = current.child(next as never)
          parent = current
        }
        return child
      }, next)
    }
  })
}

/**
 * Adapts an application-owned Pino logger and the destination it was constructed with.
 * `logger[streamSym]` must be `destination`. The handler owns that destination after admission.
 */
export function newPinoHandler(
  logger: Logger,
  destination: OfficialPinoDestination,
  ...options: readonly PinoHandlerOption[]
): PinoHandler {
  const holder: { logger: Logger } = { logger }
  const lifecycle = createPinoLifecycle(
    logger,
    destination,
    options,
    function adopt(next: Logger): void {
      holder.logger = next
    }
  )
  return Object.freeze({
    ...handlerFor(() => holder.logger),
    lifecycle
  })
}
