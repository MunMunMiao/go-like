import type { Context } from "../../context/index"
import type { LogAttrs, LogHandler, LogLevel, LogRecord, LogValue } from "../../log/index"

/** One installed handler plus the bound attributes core merges when `withAttrs` is absent. */
export interface FanoutHandler {
  readonly handler: LogHandler
  readonly bound: LogAttrs
  readonly inline: boolean
}

const emptyAttrs: LogAttrs = Object.freeze({})

/** Copies own enumerable log attributes so a later mutation cannot reach a handler. */
export function copyLogAttrs(attrs: LogAttrs): LogAttrs {
  if (typeof attrs !== "object" || attrs === null || Array.isArray(attrs)) {
    throw new TypeError("log attrs must be an object")
  }
  const copy: Record<string, LogValue> = {}
  for (const key of Object.keys(attrs)) {
    const value = Reflect.get(attrs, key) as LogValue
    copy[key] = value
  }
  return Object.freeze(copy)
}

/** Installs handlers with no bound attributes. */
export function installHandlers(handlers: readonly LogHandler[]): readonly FanoutHandler[] {
  return handlers.map((handler) => Object.freeze({ handler, bound: emptyAttrs, inline: true }))
}

/** Derives handlers whose records carry `attrs`. Handlers without `withAttrs` keep an inline merge. */
export function bindHandlers(
  fanout: readonly FanoutHandler[],
  attrs: LogAttrs
): readonly FanoutHandler[] {
  const snapshot = copyLogAttrs(attrs)
  if (Object.keys(snapshot).length === 0) return fanout
  return fanout.map((item) => {
    const withAttrs = item.handler.withAttrs
    const merged = Object.freeze({ ...item.bound, ...snapshot })
    if (typeof withAttrs !== "function") {
      return Object.freeze({ handler: item.handler, bound: merged, inline: true })
    }
    try {
      const child = withAttrs.call(item.handler, merged)
      if (typeof child !== "object" || child === null) return item
      return Object.freeze({ handler: child, bound: emptyAttrs, inline: false })
    } catch {
      return item
    }
  })
}

/** Reports whether any handler accepts `level`. A throwing `enabled` counts as false. */
export function anyEnabled(
  fanout: readonly FanoutHandler[],
  ctx: Context,
  level: LogLevel
): boolean {
  for (const item of fanout) {
    if (handlerEnabled(item.handler, ctx, level)) return true
  }
  return false
}

/** Writes one record to every enabled handler. Handler failures stay inside the fanout. */
export function deliver(ctx: Context, fanout: readonly FanoutHandler[], record: LogRecord): void {
  for (const item of fanout) {
    if (!handlerEnabled(item.handler, ctx, record.level)) continue
    const attrs = item.inline ? Object.freeze({ ...item.bound, ...record.attrs }) : record.attrs
    const delivered: LogRecord =
      attrs === record.attrs ? record : Object.freeze({ ...record, attrs })
    try {
      item.handler.handle(ctx, delivered)
    } catch {
      // A handler must not throw; a throw does not affect the other handlers or the caller.
    }
  }
}

/** Reads one handler's level gate without letting it escape. */
function handlerEnabled(handler: LogHandler, ctx: Context, level: LogLevel): boolean {
  try {
    return handler.enabled(ctx, level) === true
  } catch {
    return false
  }
}
