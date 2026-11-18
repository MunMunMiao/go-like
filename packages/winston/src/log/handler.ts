import type { Context } from "@go-like/core/context"
import type { LogAttrs, LogHandler, LogLevel, LogRecord } from "@go-like/core/log"
import { LogField } from "@go-like/core/telemetry"
import { logCorrelation } from "@go-like/core/telemetry/provider"
import type { Logger } from "winston"

import { createWinstonLifecycle } from "./lifecycle"
import type { WinstonHandler } from "./types"

/** Copies core attributes, mapping the diagnostic Error onto winston's `error` key. */
function fields(attrs: LogAttrs, into: Record<string, unknown>): Record<string, unknown> {
  for (const [key, value] of Object.entries(attrs)) {
    into[key === LogField.exception ? "error" : key] = value
  }
  return into
}

/** Builds a handler whose logger is resolved on each call so admission can rebind the root. */
function handlerFor(target: () => Logger, bound: Record<string, unknown> = {}): LogHandler {
  return Object.freeze({
    enabled(_ctx: Context, level: LogLevel): boolean {
      return target().isLevelEnabled(level)
    },
    handle(ctx: Context, record: LogRecord): void {
      const meta = fields(record.attrs, { ...bound })
      const correlation = logCorrelation(ctx)
      if (correlation !== null) Object.assign(meta, correlation)
      if (record.event !== "") meta[LogField.event] = record.event
      try {
        target().log({ ...meta, level: record.level, message: record.message } as never)
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
 * Adapts an application-owned Winston logger.
 * Construction installs no listeners. The lifecycle ends the borrowed logger on stop.
 */
export function newWinstonHandler(logger: Logger): WinstonHandler {
  const holder: { logger: Logger } = { logger }
  const lifecycle = createWinstonLifecycle(logger, function adopt(next: Logger): void {
    holder.logger = next
  })
  return Object.freeze({
    ...handlerFor(() => holder.logger),
    lifecycle
  })
}
